use crate::registration::{Gate, RegistrationSlot, WorkspaceRegistration};
use crate::usage::{UsageFailure, UsageRun, UsageStatus};
use crate::workspace::{Binding, Handoff};
use crate::{Host, Limits, StartedWorkspace};
use hagency_core::tasks::{RunnerCapability, RunnerCommand, Task, TaskState};
use hagency_runtime::{
    codex::session::{self, Outcome, Update},
    owned::{Cleanup, OwnedSession},
};
use hagency_store::{DomainStore, OwnedFailure, OwnedObservation};
use std::{
    future::Future,
    sync::{
        Arc, Mutex,
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
    #[error("usage source binding failed or its response is unknown; no child launched")]
    UsageBinding,
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
            Self::Admission | Self::UsageBinding => OwnedFailure::Admission,
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

/// Fixed diagnostics from the original owned runtime, never execution authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeStage {
    Initialize,
    ThreadStart,
    TurnStart,
    Update,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeWriteObservation {
    pub accepted_bytes: usize,
    pub total_bytes: usize,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeObservation {
    pub stage: RuntimeStage,
    pub session_error: Option<session::Error>,
    pub transport_cause: Option<hagency_runtime::codex::transport::Error>,
    pub pending_requests: Option<usize>,
    pub pending_server_requests: Option<usize>,
    pub write: Option<RuntimeWriteObservation>,
}
impl RuntimeObservation {
    fn capture(stage: RuntimeStage, runner: &OwnedSession) -> Self {
        let termination = runner.transport_termination();
        Self {
            stage,
            session_error: match runner.protocol_outcome() {
                Some(Outcome::Unknown { reason }) => Some(*reason),
                _ => None,
            },
            transport_cause: termination.map(|t| t.cause),
            pending_requests: termination.map(|t| t.pending_requests),
            pending_server_requests: termination.map(|t| t.pending_server_requests),
            write: termination
                .and_then(|t| t.unconfirmed_write.as_ref())
                .map(|w| RuntimeWriteObservation {
                    accepted_bytes: w.accepted_bytes,
                    total_bytes: w.total_bytes,
                }),
        }
    }
}

/// Private host result: no Serialize/Debug or automatic console/Matrix projection.
/// An unresolved owner remains retained here; retrying stop never clears a lease.
pub struct Report {
    pub protocol: Protocol,
    pub cleanup: Cleanup,
    pub canonical_status: Option<TaskState>,
    pub settlement: Settlement,
    pub failure: Option<Failure>,
    runtime_observation: Option<RuntimeObservation>,
    pub text: Option<String>,
    owner: Option<OwnedSession>,
    reconciliation: Option<(DomainStore, RunnerCapability, OwnedFailure)>,
    usage: Option<UsageRun>,
    // After owner in field order: actual cleanup drops before retained roots.
    workspace: Option<Arc<Binding>>,
    handoff: Handoff,
    registration: Option<Gate>,
}
impl Report {
    fn new(handoff: Handoff) -> Self {
        Self {
            protocol: Protocol::NotStarted,
            cleanup: Cleanup::Pending,
            canonical_status: None,
            settlement: Settlement::Pending,
            failure: None,
            runtime_observation: None,
            text: None,
            owner: None,
            reconciliation: None,
            usage: None,
            workspace: None,
            handoff,
            registration: None,
        }
    }
    /// Immutable original observation survives retry_stop discarding a stopped
    /// owner. No descriptor, process ID, payload or private stderr is exposed.
    pub fn runtime_observation(&self) -> Option<&RuntimeObservation> {
        self.runtime_observation.as_ref()
    }
    pub fn usage_status(&self) -> UsageStatus {
        self.usage
            .as_ref()
            .map_or_else(UsageStatus::default, UsageRun::status)
    }
    /// Explicit retry of one retained historical observation. Never restarts
    /// capture, execution, cleanup, canonical completion or message delivery.
    pub async fn retry_usage(&mut self) -> Result<UsageStatus, UsageFailure> {
        match &mut self.usage {
            Some(usage) => usage.record_pending().await,
            None => Ok(UsageStatus::default()),
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

    /// Local physical custody only, never task/grant/lease settlement authority.
    /// Pending without an owner is the existing pre-child result. Unknown spawn
    /// or incomplete stop observations remain retained even without a returned owner.
    pub fn retains_process_custody(&self) -> bool {
        self.owner.is_some()
            || match self.cleanup {
                Cleanup::Pending => false,
                Cleanup::Observed(_) => !stopped(self.cleanup),
                Cleanup::Unknown { .. } => true,
            }
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
    result: oneshot::Receiver<Box<Report>>,
    workspace: Handoff,
    registration: RegistrationSlot,
}
impl Operation {
    pub fn start(
        domain: DomainStore,
        capability: RunnerCapability,
        host: Host,
        limits: Limits,
    ) -> Result<Self, Failure> {
        Self::start_mode(domain, capability, host, limits, false)
    }
    /// Require the host to register the exact Started workspace before any child.
    pub fn start_requiring_workspace(
        domain: DomainStore,
        capability: RunnerCapability,
        host: Host,
        limits: Limits,
    ) -> Result<Self, Failure> {
        Self::start_mode(domain, capability, host, limits, true)
    }
    fn start_mode(
        domain: DomainStore,
        capability: RunnerCapability,
        host: Host,
        limits: Limits,
        required: bool,
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
        let workspace = Arc::new(Mutex::new(None));
        let handoff = workspace.clone();
        let (gate, registration) = Gate::new();
        let worker = std::thread::Builder::new()
            .name("hagency-owned-dispatch".into())
            .spawn(move || {
                let until = Instant::now() + Duration::from_millis(limits.operation_ms);
                let mut report = Box::new(Report::new(handoff));
                report.registration = required.then_some(gate);
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
                if let Some(usage) = &mut report.usage {
                    usage.close();
                }
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
            workspace,
            registration,
        })
    }
    /// Nonblocking, one-shot handoff. None means not ready, already taken, or
    /// unavailable. A late value remains sealed but refuses retired access.
    pub fn take_workspace_binding(&mut self) -> Option<StartedWorkspace> {
        self.workspace.try_lock().ok()?.take()
    }
    /// One bounded host handoff; unavailable in the ordinary start mode.
    pub fn take_workspace_registration(&mut self) -> Option<WorkspaceRegistration> {
        self.registration.try_lock().ok()?.take()
    }
    pub fn is_finished(&self) -> bool {
        self.worker
            .as_ref()
            .is_none_or(std::thread::JoinHandle::is_finished)
    }
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }
    pub async fn wait(&mut self) -> Result<Report, Failure> {
        self.wait_boxed().await.map(|report| *report)
    }
    /// Keep the single retained result indirect across nested host futures.
    /// This changes storage location only; cancellation and ownership are identical.
    pub async fn wait_boxed(&mut self) -> Result<Box<Report>, Failure> {
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
pub(crate) async fn bounded<F: Future>(
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
    let crate::host::Prepared {
        launch,
        settings,
        io_limits,
        input,
        root,
    } = host.prepare(&scope, cap, limits)?;
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
    let workspace = Binding::start(root, domain.clone(), cap, &started, cancel.clone())?;
    let _retire_workspace = workspace.retirement(); // all returns and unwinds
    report.workspace = Some(workspace.clone()); // before any child can exist
    let required = report.registration.is_some();
    if let Some(gate) = report.registration.take() {
        let acknowledged = gate.publish(workspace.handoff())?;
        bounded(acknowledged, cancel, until)
            .await?
            .map_err(|_| Failure::Admission)?;
    } else {
        *report.handoff.lock().map_err(|_| Failure::Worker)? = Some(workspace.handoff());
    }
    #[cfg(test)]
    if host.panic_after_workspace {
        panic!("offline post-Started workspace unwind");
    }
    report.canonical_status = Some(started.task().status);
    checkpoint(cancel, until)?;
    let binding = bounded(
        UsageRun::bind(domain.clone(), cap.clone(), started.clone()),
        cancel,
        until,
    )
    .await?;
    // Test build only: discard an actual acknowledged source binding, never
    // manufacture a successful write or reopen execution after receipt loss.
    #[cfg(test)]
    let binding = if host.discard_usage_binding_reply && binding.is_ok() {
        Err(hagency_store::Error::OutcomeUnknown)
    } else {
        binding
    };
    report.usage = Some(binding.map_err(|_| Failure::UsageBinding)?);
    checkpoint(cancel, until)?;
    if required {
        bounded(
            domain.check_owned_dispatch(cap.clone(), expected.clone()),
            cancel,
            until,
        )
        .await?
        .map_err(|_| Failure::LostAuthority)?;
        checkpoint(cancel, until)?;
    }
    workspace.check_root().map_err(|_| Failure::Admission)?;
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
    let mut runtime_stage = RuntimeStage::Initialize;
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
        runtime_stage = RuntimeStage::ThreadStart;
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
        runtime_stage = RuntimeStage::TurnStart;
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
        let usage = report.usage.as_mut().ok_or(Failure::UsageBinding)?;
        usage.attach(&runner);
        loop {
            runtime_stage = RuntimeStage::Update;
            let (update, observation) = watched(
                runner.next_observed_update(),
                domain,
                cap,
                &expected,
                cancel,
                until,
                &mut report.canonical_status,
            )
            .await?;
            if usage.observe(&observation) {
                // Storage refusal closes capture only. Cancellation/deadline
                // still reaches the existing retained process cleanup path.
                let _ = bounded(usage.record_pending(), cancel, until).await?;
            }
            match update {
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
    // Capture before coordinator stop/removal. The runtime's own failure guard
    // may already have stopped it; its first transport cause remains retained.
    // Observation cannot alter the original drive or cleanup result.
    report.runtime_observation = Some(RuntimeObservation::capture(runtime_stage, &runner));
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
        // Keep the receipt future alive. The writer checks this original signal
        // and monotonic deadline after queue/lock before admitting final content;
        // cancellation after that eligibility decision cannot undo its commit.
        domain
            .publish_owned_completion(
                cap.clone(),
                started,
                reference,
                cancel.clone(),
                until.into_std(),
            )
            .await
            .map_err(|_| {
                checkpoint(cancel, until)
                    .err()
                    .unwrap_or(Failure::SettlementUnknown)
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
