use super::{Failure, StatusHandle, config::Prepared, workspace::WorkspaceAccess};
use hagency_execution::{Operation, Report};
use hagency_matrix::{CancellationToken, Collector};
use hagency_store::DomainStore;
use std::{
    sync::mpsc::{self, Receiver, SyncSender, TrySendError},
    thread::JoinHandle,
    time::Duration,
};
use tokio::sync::oneshot;

enum Command {
    Close(oneshot::Sender<Result<(), Failure>>),
}

// Collector::close consumes its SDK owner before awaiting the close ACK. A
// subsequent call may see an empty owner and succeed, which cannot establish
// the outcome of the original consumed attempt. Keep that exact result.
#[derive(Default)]
struct CollectorClose {
    result: Option<Result<(), Failure>>,
}
impl CollectorClose {
    fn attempt(&mut self, close: impl FnOnce() -> Result<(), Failure>) -> Result<(), Failure> {
        *self.result.get_or_insert_with(close)
    }
}
pub(super) struct Driver {
    cancel: CancellationToken,
    control: SyncSender<Command>,
    thread: Option<JoinHandle<()>>,
    pending_close: Option<oneshot::Receiver<Result<(), Failure>>>,
    close_reply_unknown: bool,
}
impl Driver {
    pub fn start(
        prepared: Prepared,
        domain: DomainStore,
        status: StatusHandle,
    ) -> Result<Self, Failure> {
        let (control, commands) = mpsc::sync_channel(1);
        let cancel = CancellationToken::new();
        let signal = cancel.clone();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| Failure::Worker)?;
        let thread = std::thread::Builder::new()
            .name("hagency-development-driver".into())
            .spawn(move || {
                let workspace = WorkspaceAccess::new();
                let collector = match Collector::new(prepared.matrix, domain.clone()) {
                    Ok(value) => value,
                    Err(_) => {
                        status.fail(Failure::Config);
                        close_failed(commands);
                        return;
                    }
                };
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let future = run(Attempt {
                        domain: &domain,
                        host: prepared.host,
                        profile: prepared.claim,
                        limits: prepared.limits,
                        collector: &collector,
                        workspace: &workspace,
                        cancel: &signal,
                        status: &status,
                        #[cfg(test)]
                        discard_claim_reply: prepared.discard_claim_reply,
                    });
                    runtime.block_on(Box::pin(future))
                }));
                workspace.retire();
                let unowned_failure = matches!(&result, Err(_) | Ok(Err(Failure::Worker)));
                let mut report = match result {
                    Ok(Ok(report)) => report,
                    Ok(Err(error)) => {
                        status.fail(error);
                        None
                    }
                    Err(_) => {
                        status.fail(Failure::Worker);
                        None
                    }
                };
                let mut collector_close = CollectorClose::default();
                while let Ok(Command::Close(reply)) = commands.recv() {
                    signal.cancel();
                    workspace.retire();
                    let outcome = if unowned_failure || report.as_mut().is_some_and(|r| !stopped(r))
                    {
                        Err(Failure::OutcomeUnknown)
                    } else {
                        collector_close.attempt(|| {
                            runtime
                                .block_on(collector.close())
                                .map_err(|_| Failure::OutcomeUnknown)
                        })
                    };
                    if outcome.is_ok() {
                        drop(report.take());
                        status.phase("closed");
                        let _ = reply.send(Ok(()));
                        return;
                    }
                    status.fail(Failure::OutcomeUnknown);
                    let _ = reply.send(outcome); // original report stays in this owner
                }
                // Abrupt handle abandonment is not a successful close. Destruction
                // remains on the retained OS worker and can never release a DB lease.
                drop(report);
            })
            .map_err(|_| Failure::Worker)?;
        Ok(Self {
            cancel,
            control,
            thread: Some(thread),
            pending_close: None,
            close_reply_unknown: false,
        })
    }
    pub fn cancel(&self) {
        self.cancel.cancel();
    }
    /// Non-consuming close. Unknown keeps both the worker and pending receipt.
    pub async fn close(&mut self) -> Result<(), Failure> {
        self.cancel();
        if self.thread.is_none() {
            return Ok(());
        }
        if self.close_reply_unknown {
            return Err(Failure::OutcomeUnknown);
        }
        if self.pending_close.is_none() {
            let (send, receive) = oneshot::channel();
            match self.control.try_send(Command::Close(send)) {
                Ok(()) => self.pending_close = Some(receive),
                Err(TrySendError::Full(_)) => return Err(Failure::OutcomeUnknown),
                Err(TrySendError::Disconnected(_)) => return Err(Failure::Worker),
            }
        }
        let pending = self.pending_close.as_mut().ok_or(Failure::Worker)?;
        let result = match tokio::time::timeout(Duration::from_secs(2), pending).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                // The receiver is completed, unlike a timed-out pending wait.
                // Polling it again can panic and cannot recover the lost ACK.
                self.pending_close = None;
                self.close_reply_unknown = true;
                return Err(Failure::OutcomeUnknown);
            }
            Err(_) => return Err(Failure::OutcomeUnknown),
        };
        self.pending_close = None;
        result?;
        if let Some(worker) = self.thread.take() {
            // ACK precedes return by only fixed local operations. Never joins
            // an executing model/SDK owner from an HTTP request handler.
            worker.join().map_err(|_| Failure::Worker)?;
        }
        Ok(())
    }
}
impl Drop for Driver {
    fn drop(&mut self) {
        self.cancel();
    }
}
fn close_failed(commands: Receiver<Command>) {
    if let Ok(Command::Close(reply)) = commands.recv() {
        let _ = reply.send(Ok(()));
    }
}
fn stopped(report: &mut Report) -> bool {
    report.retry_stop();
    !report.retains_process_custody()
}
struct Attempt<'a> {
    domain: &'a DomainStore,
    host: hagency_execution::Host,
    profile: hagency_store::OwnedClaimProfile,
    limits: hagency_execution::Limits,
    collector: &'a Collector,
    workspace: &'a WorkspaceAccess,
    cancel: &'a CancellationToken,
    status: &'a StatusHandle,
    #[cfg(test)]
    discard_claim_reply: bool,
}
async fn run(input: Attempt<'_>) -> Result<Option<Box<Report>>, Failure> {
    let Attempt {
        domain,
        host,
        profile,
        limits,
        collector,
        workspace,
        cancel,
        status,
        #[cfg(test)]
        discard_claim_reply,
    } = input;
    status.phase("refreshing");
    collector.collect(cancel).await.map_err(|e| {
        if matches!(e, hagency_matrix::Error::OutcomeUnknown) {
            Failure::OutcomeUnknown
        } else {
            Failure::Refresh
        }
    })?;
    if cancel.is_cancelled() {
        return Err(Failure::Cancelled);
    }
    status.phase("claiming");
    let capability = domain
        .claim_owned_dispatch_for_host(profile, "native_development".into(), 60_000, 60_000, 1)
        .await
        .map_err(|_| Failure::OutcomeUnknown)?;
    // Test-build only: discard an actual committed claim response. No host
    // profile, runtime input or production branch can request this fault.
    #[cfg(test)]
    if discard_claim_reply && capability.is_some() {
        drop(capability);
        return Err(Failure::OutcomeUnknown);
    }
    let Some(capability) = capability else {
        status.phase("no_work");
        return Ok(None);
    };
    if cancel.is_cancelled() {
        domain
            .observe_owned_failure(capability, hagency_store::OwnedFailure::Cancelled)
            .await
            .map_err(|_| Failure::OutcomeUnknown)?;
        return Err(Failure::Cancelled);
    }
    let mut operation =
        Operation::start_requiring_workspace(domain.clone(), capability.clone(), host, limits)
            .map_err(|_| Failure::Worker)?;
    status.phase("registering");
    loop {
        if cancel.is_cancelled() {
            operation.cancel();
        }
        if let Some(registration) = operation.take_workspace_registration() {
            let (binding, ack) = registration.into_parts();
            if let Err(rejected) = workspace.register(capability.clone(), binding).await {
                drop(rejected.capability);
                drop(rejected.binding);
                operation.cancel();
                drop(ack);
            } else if workspace.check(&capability).await.is_ok() && !cancel.is_cancelled() {
                status.registered();
                if ack.registered().is_err() {
                    operation.cancel();
                }
            } else {
                operation.cancel();
                drop(ack);
            }
            break;
        }
        if operation.is_finished() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    status.phase("running");
    let mut wait = Box::pin(operation.wait_boxed());
    let report = tokio::select! {
            value = &mut wait => value.map_err(|_| Failure::Worker)?,
            _ = cancel.cancelled() => {
                // Dropping wait triggers the existing operation cancellation guard;
                // then await the SAME operation owner, never start it again.
                drop(wait);
                operation.cancel();
                operation.wait_boxed().await.map_err(|_| Failure::Worker)?
            }
    };
    status.result(&report);
    Ok(Some(report))
}

#[cfg(test)]
#[path = "../../../hagency-matrix/tests/common/mod.rs"]
mod test_common;
#[cfg(test)]
mod tests {
    use super::*;
    use hagency_core::{replies::*, tasks::*};
    use hagency_execution::{Host, Limits};
    use hagency_store::{OwnedClaimProfile, OwnedClaimRoom, private};
    use std::collections::{BTreeMap, BTreeSet};

    #[test]
    fn native_bootstrap_custody_consumed_close_ack() {
        // Model the consuming API's documented boundary: first call takes its
        // owner but loses the ACK; a later empty-owner close would return Ok.
        // This is a protocol-state test, not evidence of a real SDK shutdown.
        let mut original_owner = Some(());
        let calls = std::cell::Cell::new(0);
        let mut close = CollectorClose::default();
        let mut upstream = || {
            calls.set(calls.get() + 1);
            if original_owner.take().is_some() {
                Err(Failure::OutcomeUnknown)
            } else {
                Ok(())
            }
        };
        assert_eq!(close.attempt(&mut upstream), Err(Failure::OutcomeUnknown));
        assert_eq!(close.attempt(&mut upstream), Err(Failure::OutcomeUnknown));
        assert_eq!(calls.get(), 1);
        assert!(original_owner.is_none());

        let mut known = CollectorClose::default();
        assert_eq!(known.attempt(|| Ok(())), Ok(()));
        assert_eq!(known.attempt(|| panic!("repeat consumed close")), Ok(()));
    }

    #[tokio::test]
    async fn native_bootstrap_custody_closed_reply() {
        let (reply, pending) = oneshot::channel();
        drop(reply);
        let (control, commands) = mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || drop(commands));
        let mut driver = Driver {
            cancel: CancellationToken::new(),
            control,
            thread: Some(worker),
            pending_close: Some(pending),
            close_reply_unknown: false,
        };
        assert_eq!(driver.close().await, Err(Failure::OutcomeUnknown));
        assert_eq!(driver.close().await, Err(Failure::OutcomeUnknown));
        assert!(driver.close_reply_unknown);
        assert!(driver.pending_close.is_none());
        assert!(driver.thread.is_some()); // retained wrapper is not a live-worker proof
        driver.thread.take().unwrap().join().unwrap();
    }

    async fn fixture(f: &test_common::Fixture, endpoint: &str) -> Prepared {
        let transport = f.identity.transport.clone();
        f.store
            .observe_matrix_transport(transport.clone())
            .await
            .unwrap();
        f.store
            .observe_matrix_room(MatrixRoomObservation {
                engagement_id: transport.engagement_id.clone(),
                registration_generation: 1,
                transport_generation: 1,
                room_id: "!direct:example.test".into(),
                generation: 1,
                privacy: RoomPrivacy::Direct {
                    human_mxid: "@owner:example.test".into(),
                },
                joined: BTreeSet::from([
                    "@worker:example.test".into(),
                    "@owner:example.test".into(),
                ]),
                invite_only: true,
                encrypted: true,
            })
            .await
            .unwrap();
        f.store
            .resolve_verified_matrix_session(SessionBinding {
                id: "bootstrap".into(),
                engagement_id: transport.engagement_id.clone(),
                room_id: "!direct:example.test".into(),
                thread_root: None,
            })
            .await
            .unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        f.store
            .create_canonical_task(
                "task".into(),
                "bootstrap".into(),
                "Owned bootstrap".into(),
                now,
            )
            .await
            .unwrap();
        f.store.register_workspace("work".into()).await.unwrap();
        f.store
            .enqueue_dispatch(DispatchInput {
                id: "dispatch".into(),
                session_id: "bootstrap".into(),
                task_id: Some("task".into()),
                resources: vec![ResourceLease {
                    id: "work".into(),
                    exclusive: true,
                }],
                payload: serde_json::json!({"instruction":"offline"}),
            })
            .await
            .unwrap();
        let root = f.root.path().join("work");
        private::directory(&root).unwrap();
        let own = std::env::current_exe().unwrap();
        Prepared {
            host: Host::new(
                own.clone(),
                own,
                BTreeMap::new(),
                BTreeMap::from([("work".into(), root.canonicalize().unwrap())]),
            )
            .unwrap(),
            matrix: f
                .config(endpoint)
                .with_root_pem(include_bytes!(
                    "../../../hagency-matrix/tests/fixtures/ca.pem"
                ))
                .unwrap(),
            claim: OwnedClaimProfile::new(
                transport,
                vec![
                    OwnedClaimRoom::new(
                        "!direct:example.test".into(),
                        1,
                        RoomPrivacy::Direct {
                            human_mxid: "@owner:example.test".into(),
                        },
                    )
                    .unwrap(),
                ],
                vec!["work".into()],
            )
            .unwrap(),
            limits: Limits {
                operation_ms: 5000,
                response_ms: 1000,
            },
            discard_claim_reply: false,
        }
    }
    #[tokio::test]
    async fn native_bootstrap_unknown_start_lost_claim() {
        let f = test_common::Fixture::new();
        let mut fake = test_common::Fake::start(true).await;
        let mut prepared = fixture(&f, &fake.endpoint).await;
        prepared.discard_claim_reply = true;
        let status = StatusHandle::new(true);
        let mut driver = Driver::start(prepared, f.store.clone(), status.clone()).unwrap();
        test_common::success(&mut fake, "claim_loss").await;
        let until = tokio::time::Instant::now() + Duration::from_secs(5);
        while status.get().state != "outcome_unknown" {
            assert!(
                tokio::time::Instant::now() < until,
                "lost claim was not retained unknown"
            );
            tokio::task::yield_now().await;
        }
        assert_eq!(status.get().error, Some("outcome_unknown"));
        assert!(!status.get().workspace_registered);
        let inspect =
            rusqlite::Connection::open(f.root.path().join("domain/domain.sqlite3")).unwrap();
        assert_eq!(
            inspect
                .query_row("SELECT COUNT(*) FROM runner_attempts", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            inspect
                .query_row(
                    "SELECT state FROM runner_dispatches WHERE id='dispatch'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "leased"
        );
        assert!(!f.root.path().join("work/owned-mcp.requests").exists());
        driver.close().await.unwrap();
        assert_eq!(
            inspect
                .query_row("SELECT COUNT(*) FROM runner_attempts", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            1
        );
        drop(inspect);
        test_common::shutdown_domain(&f.store, "bootstrap lost claim").await;
    }
    #[tokio::test]
    async fn native_bootstrap_custody_original_binding() {
        let f = test_common::Fixture::new();
        let fake = test_common::Fake::start(true).await;
        let prepared = fixture(&f, &fake.endpoint).await;
        let cap = f
            .store
            .claim_owned_dispatch_for_host(prepared.claim, "host".into(), 60_000, 60_000, 1)
            .await
            .unwrap()
            .unwrap();
        let mut operation = Operation::start_requiring_workspace(
            f.store.clone(),
            cap.clone(),
            prepared.host,
            prepared.limits,
        )
        .unwrap();
        let until = tokio::time::Instant::now() + Duration::from_secs(3);
        let (binding, ack) = loop {
            if let Some(r) = operation.take_workspace_registration() {
                break r.into_parts();
            }
            assert!(tokio::time::Instant::now() < until && !operation.is_finished());
            tokio::task::yield_now().await;
        };
        let access = WorkspaceAccess::new();
        let mut foreign = cap.clone();
        foreign.secret = "f".repeat(64);
        let rejected = match access.register(foreign, binding).await {
            Ok(()) => panic!("foreign capability registered"),
            Err(value) => value,
        };
        assert_eq!(rejected.capability.secret, "f".repeat(64));
        assert!(access.register(cap.clone(), rejected.binding).await.is_ok());
        access.check(&cap).await.unwrap();
        assert!(access.check(&rejected.capability).await.is_err());
        let other = access.clone();
        other.retire();
        assert!(access.check(&cap).await.is_err());
        drop(ack); // No child was ever given launch ACK.
        let mut report = operation.wait_boxed().await.unwrap();
        assert_eq!(report.protocol, hagency_execution::Protocol::NotStarted);
        assert_eq!(report.cleanup, hagency_runtime::owned::Cleanup::Pending);
        assert!(stopped(&mut report)); // Known pre-child result; domain lease still fenced.
        assert!(other.check(&cap).await.is_err());
        assert!(!f.root.path().join("work/owned-mcp.requests").exists());
        drop(report);
        test_common::shutdown_domain(&f.store, "bootstrap binding").await;
    }
}
