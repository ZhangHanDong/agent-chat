use crate::{Host, Limits};
use hagency_core::tasks::{RunnerCapability, RunnerCommand, Task, TaskState};
use hagency_runtime::{
    codex::session::{self, Outcome, Update},
    owned::{Cleanup, OwnedSession},
};
use hagency_store::{DomainStore, OwnedFailure, OwnedObservation};
use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};
use tokio::{
    sync::oneshot,
    time::{Instant, MissedTickBehavior, interval},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Failure {
    #[error("host dispatch admission refused")]
    Admission,
    #[error("host operation cancelled")]
    Cancelled,
    #[error("durable start response unknown; no child launched")]
    StartUnknown,
    #[error("owned native child startup failed")]
    SpawnFailed,
    #[error("dispatch authority expired, changed or was revoked")]
    LostAuthority,
    #[error("native runner protocol failed")]
    Protocol,
    #[error("owned approval application is unavailable")]
    UnsupportedApproval,
    #[error("host operation deadline expired")]
    Deadline,
    #[error("whole-tree cleanup remains unproven")]
    CleanupUnknown,
    #[error("domain settlement outcome unknown")]
    SettlementUnknown,
    #[error("host worker failed")]
    Worker,
}
impl Failure {
    fn observation(self) -> OwnedFailure {
        match self {
            Self::Admission => OwnedFailure::Admission,
            Self::Cancelled => OwnedFailure::Cancelled,
            Self::StartUnknown => OwnedFailure::StartUnknown,
            Self::SpawnFailed => OwnedFailure::SpawnFailed,
            Self::LostAuthority => OwnedFailure::LostAuthority,
            Self::Protocol | Self::Worker => OwnedFailure::Protocol,
            Self::UnsupportedApproval => OwnedFailure::UnsupportedApproval,
            Self::Deadline => OwnedFailure::Deadline,
            Self::CleanupUnknown => OwnedFailure::CleanupUnknown,
            Self::SettlementUnknown => OwnedFailure::SettlementUnknown,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    NotStarted,
    Completed,
    Failed,
    Interrupted,
    Unsupported,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settlement {
    Pending,
    Completed,
    CanonicalReplyReady,
    Negative(OwnedObservation),
    Unknown,
}

/// Private host result: no Serialize/Debug or automatic console/Matrix projection.
/// An unresolved owner remains retained here; retrying stop never clears a lease.
pub struct Report {
    pub protocol: Protocol,
    pub cleanup: Cleanup,
    pub canonical_status: Option<TaskState>,
    pub settlement: Settlement,
    pub failure: Option<Failure>,
    pub text: Option<String>,
    owner: Option<OwnedSession>,
    reconciliation: Option<(DomainStore, RunnerCapability, OwnedFailure)>,
}
impl Report {
    fn new() -> Self {
        Self {
            protocol: Protocol::NotStarted,
            cleanup: Cleanup::Pending,
            canonical_status: None,
            settlement: Settlement::Pending,
            failure: None,
            text: None,
            owner: None,
            reconciliation: None,
        }
    }
    /// A bounded negative-only retry after a lost database response. Cancellation
    /// leaves the same retained receipt/capability for a subsequent explicit retry.
    /// This never retries successful settlement or clears a dirty lease.
    pub async fn retry_reconcile(&mut self) -> Settlement {
        self.retry_stop();
        if let Some((domain, cap, failure)) = &self.reconciliation
            && let Ok(value) = domain.observe_owned_failure(cap.clone(), *failure).await
        {
            self.settlement = Settlement::Negative(value);
            self.reconciliation = None;
        }
        self.settlement
    }

    pub fn retry_stop(&mut self) -> Cleanup {
        if let Some(owner) = &mut self.owner {
            self.cleanup = owner.stop();
        }
        if stopped(self.cleanup) {
            self.owner.take();
        }
        self.cleanup
    }
}
fn stopped(cleanup: Cleanup) -> bool {
    matches!(cleanup, Cleanup::Observed(report) if report.scope.whole_tree_stopped && report.scope.leader_exited && report.scope.signals_accepted)
}

/// One host operation, one retained OS worker, one result slot. No scheduler or
/// detached cleanup. Dropping a waiting future requests cancellation; the worker
/// still stops and reconciles. Dropping this handle joins it synchronously, with
/// the conservative 60 s combined wait allowance documented by `Limits`. It must
/// not be dropped on a latency-sensitive HTTP/UI worker. There is no forced
/// thread termination or claim that an unknown child/guardian outcome is clean.
pub struct Operation {
    cancel: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    result: oneshot::Receiver<Report>,
}
impl Operation {
    pub fn start(
        domain: DomainStore,
        capability: RunnerCapability,
        host: Host,
        limits: Limits,
    ) -> Result<Self, Failure> {
        if !limits.validate() {
            return Err(Failure::Admission);
        }
        // Runtime construction has no child/domain effect and fails synchronously.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| Failure::Worker)?;
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = cancel.clone();
        let (reply, result) = oneshot::channel();
        let worker = std::thread::Builder::new()
            .name("hagency-owned-dispatch".into())
            .spawn(move || {
                let until = Instant::now() + Duration::from_millis(limits.operation_ms);
                let mut report = Report::new();
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    runtime.block_on(execute(
                        &domain,
                        &capability,
                        host,
                        limits,
                        &signal,
                        until,
                        &mut report,
                    ))
                }))
                .unwrap_or(Err(Failure::Worker));
                if let Err(failure) = outcome {
                    // execute retains any returned owner; stop before negative domain
                    // observation too. This can never authorize lease release.
                    report.retry_stop();
                    report.failure = Some(failure);
                    report.reconciliation =
                        Some((domain.clone(), capability.clone(), failure.observation()));
                    report.settlement = match runtime
                        .block_on(domain.observe_owned_failure(capability, failure.observation()))
                    {
                        Ok(value) => {
                            report.reconciliation = None;
                            Settlement::Negative(value)
                        }
                        Err(_) => Settlement::Unknown,
                    };
                }
                // If the host dropped its handle, sending returns ownership and its
                // Drop still runs here before this retained worker exits.
                let _ = reply.send(report);
            })
            .map_err(|_| Failure::Worker)?;
        Ok(Self {
            cancel,
            worker: Some(worker),
            result,
        })
    }
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }
    pub async fn wait(&mut self) -> Result<Report, Failure> {
        let mut guard = WaitGuard {
            cancel: &self.cancel,
            done: false,
        };
        let result = (&mut self.result).await.map_err(|_| Failure::Worker);
        guard.done = true;
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| Failure::Worker)?;
        }
        result
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        self.cancel();
        self.result.close(); // Failed send drops any retained owner on the worker.
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
struct WaitGuard<'a> {
    cancel: &'a AtomicBool,
    done: bool,
}
impl Drop for WaitGuard<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.cancel.store(true, Ordering::Release);
        }
    }
}

fn checkpoint(cancel: &AtomicBool, until: Instant) -> Result<(), Failure> {
    if cancel.load(Ordering::Acquire) {
        Err(Failure::Cancelled)
    } else if Instant::now() >= until {
        Err(Failure::Deadline)
    } else {
        Ok(())
    }
}
async fn bounded<F: Future>(
    future: F,
    cancel: &AtomicBool,
    until: Instant,
) -> Result<F::Output, Failure> {
    tokio::pin!(future);
    let mut tick = interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        checkpoint(cancel, until)?;
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(until) => return Err(Failure::Deadline),
            _ = tick.tick() => {},
            result = &mut future => return Ok(result),
        }
    }
}
async fn watched<F: Future<Output = Result<T, session::Error>>, T>(
    future: F,
    domain: &DomainStore,
    cap: &RunnerCapability,
    expected: &str,
    cancel: &AtomicBool,
    until: Instant,
    status: &mut Option<TaskState>,
) -> Result<T, Failure> {
    tokio::pin!(future); // Held across checks; a cancelled future is never repolled.
    let mut tick = interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        checkpoint(cancel, until)?;
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(until) => return Err(Failure::Deadline),
            _ = tick.tick() => {
                let current = bounded(domain.renew_owned_dispatch(cap.clone(), expected.into(), 5_000), cancel, until).await?
                    .map_err(|_| Failure::LostAuthority)?;
                *status = Some(current.status);
            },
            result = &mut future => return result.map_err(|error| if error == session::Error::UnsupportedRequest { Failure::UnsupportedApproval } else { Failure::Protocol }),
        }
    }
}
async fn execute(
    domain: &DomainStore,
    cap: &RunnerCapability,
    host: Host,
    limits: Limits,
    cancel: &Arc<AtomicBool>,
    until: Instant,
    report: &mut Report,
) -> Result<(), Failure> {
    let scope = bounded(domain.owned_dispatch_scope(cap.clone()), cancel, until)
        .await?
        .map_err(|_| Failure::Admission)?;
    let expected = scope.fingerprint().to_owned();
    let (launch, settings, io_limits, input) = host.prepare(&scope, cap, limits)?;
    checkpoint(cancel, until)?;
    let start_reply = bounded(
        domain.start_owned_dispatch(cap.clone(), expected.clone()),
        cancel,
        until,
    )
    .await?;
    // Delivery-loss test double only. DomainStore has actually committed the
    // start; production contains no way to manufacture or recover a lost reply.
    #[cfg(test)]
    let start_reply = if host.discard_start_reply && start_reply.is_ok() {
        Err(hagency_store::Error::OutcomeUnknown)
    } else {
        start_reply
    };
    let started = start_reply.map_err(|error| {
        if matches!(
            error,
            hagency_store::Error::OutcomeUnknown | hagency_store::Error::Unavailable
        ) {
            Failure::StartUnknown
        } else {
            Failure::Admission
        }
    })?;
    report.canonical_status = Some(started.task().status);
    checkpoint(cancel, until)?;
    let mut runner = OwnedSession::spawn(
        &host.guardian,
        &launch,
        settings,
        io_limits,
        limits.response_ms,
    )
    .map_err(|error| {
        if let hagency_runtime::owned::StartError::Uncertain { cleanup, .. } = error {
            report.cleanup = cleanup;
        }
        Failure::SpawnFailed
    })?;
    let drive = async {
        watched(
            runner.initialize(),
            domain,
            cap,
            &expected,
            cancel,
            until,
            &mut report.canonical_status,
        )
        .await?;
        watched(
            runner.start_thread(),
            domain,
            cap,
            &expected,
            cancel,
            until,
            &mut report.canonical_status,
        )
        .await?;
        watched(
            runner.start_turn(input),
            domain,
            cap,
            &expected,
            cancel,
            until,
            &mut report.canonical_status,
        )
        .await?;
        loop {
            match watched(
                runner.next_update(),
                domain,
                cap,
                &expected,
                cancel,
                until,
                &mut report.canonical_status,
            )
            .await?
            {
                Update::TurnEnded => break,
                Update::Approval(_) | Update::ApprovalResolved { .. } => {
                    return Err(Failure::UnsupportedApproval);
                }
                _ => {}
            }
        }
        Ok(())
    }
    .await;
    report.protocol = match runner.protocol_outcome() {
        Some(Outcome::Completed { text }) => {
            report.text = Some(text.clone());
            Protocol::Completed
        }
        Some(Outcome::Failed) => Protocol::Failed,
        Some(Outcome::Interrupted) => Protocol::Interrupted,
        Some(Outcome::UnsupportedRequest) => Protocol::Unsupported,
        _ => Protocol::Unknown,
    };
    report.cleanup = runner.stop();
    report.owner = Some(runner);
    if host.task_helper_enabled() {
        // Observation only, after actual owner stop and before negative fencing.
        // This adds one bounded (2 s) fresh-clock writer read. Done changes the
        // epoch and still fails the exact renewal/settlement fingerprint. Never
        // use this status as execution, release, retry or reply authority.
        report.canonical_status = domain
            .runner_command(
                cap.clone(),
                RunnerCommand::Task {
                    id: scope.task().id.clone(),
                },
            )
            .await
            .ok()
            .and_then(|value| serde_json::from_value::<Task>(value).ok())
            .filter(|task| task.id == scope.task().id && task.session_id == scope.task().session_id)
            .map(|task| task.status);
    }
    checkpoint(cancel, until)?;
    // A matching explicit Done+body is completion custody, not a renewed task
    // epoch or permission to continue this process. The same runner was stopped
    // above. Scope is the opaque successful Start response, never admission data.
    if !matches!(
        drive,
        Err(Failure::Cancelled | Failure::Deadline | Failure::UnsupportedApproval)
    ) && let Some(reference) = domain
        .observe_owned_completion(cap.clone(), started.clone())
        .await
        .map_err(|_| Failure::SettlementUnknown)?
    {
        report.canonical_status = Some(TaskState::Done);
        checkpoint(cancel, until)?;
        if !stopped(report.cleanup) {
            return Err(Failure::CleanupUnknown);
        }
        // This finite writer commit is not cancellation-raced: after this
        // checkpoint cancellation cannot undo an already committed final intent.
        domain
            .publish_owned_completion(cap.clone(), started, reference, cancel.clone())
            .await
            .map_err(|_| {
                if cancel.load(Ordering::Acquire) {
                    Failure::Cancelled
                } else {
                    Failure::SettlementUnknown
                }
            })?;
        report.settlement = Settlement::CanonicalReplyReady;
        report.text = None; // Stored explicit content is the sole final body.
        report.owner.take();
        return Ok(());
    }
    drive?;
    checkpoint(cancel, until)?;
    if report.protocol != Protocol::Completed {
        return Err(Failure::Protocol);
    }
    if !stopped(report.cleanup) {
        return Err(Failure::CleanupUnknown);
    }
    let text = report.text.as_deref().ok_or(Failure::Protocol)?;
    // From this checkpoint the bounded writer commit is deliberately not
    // cancellation-raced. A later caller cancellation cannot undo a commit.
    let task = domain
        .complete_owned_dispatch(
            cap.clone(),
            expected,
            serde_json::json!({"upstream_text":text}),
        )
        .await
        .map_err(|_| Failure::SettlementUnknown)?;
    report.canonical_status = Some(task.status);
    report.settlement = Settlement::Completed;
    report.owner.take();
    Ok(())
}
