use crate::{DomainRepository, Effect, EffectOutcome, Error};
use hagency_core::{
    allocation::Budget,
    authority::{Registration, VerifiedRequest},
    messages::{InboundMessage, InboxItem, MessageReceipt, MessageTarget},
    project::{CatalogResource, ConfiguredResource, Engagement, Resource, Seat},
    task_intents::{IntentResult, NoticeClaim, NoticeDelivery, TaskIntent},
    tasks::{
        DispatchInput, MutationResult, RunnerCapability, RunnerCommand, SessionBinding, Task,
        TaskComment, TaskEvent, TaskMutation,
    },
};
use serde::Serialize;
use std::{sync::Arc, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot};

#[cfg(test)]
#[path = "../tests/common/mod.rs"]
mod clock_fixtures;

type Operation = Box<dyn FnOnce(&mut DomainRepository) + Send>;
enum Job {
    Run {
        operation: Operation,
        _bytes: OwnedSemaphorePermit,
    },
    Shutdown(oneshot::Sender<()>),
}

#[cfg(test)]
mod clock_tests {
    use super::*;
    use clock_fixtures::{proof, registration, request, resource};
    use serde_json::json;
    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }

    #[tokio::test]
    async fn native_runner_clock_after_queue() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("state");
        let mut db = DomainRepository::open(&state).unwrap();
        db.register(&registration()).unwrap();
        let pool = resource("pool", "seat", 100);
        db.put_resource(&pool).unwrap();
        let proof = proof(&request("request", "Worker", &pool, 10));
        let e = db.admit(&proof, 1000).unwrap();
        db.approve("approve", &proof, 1000).unwrap();
        let effect = db.claim_effect().unwrap().unwrap();
        db.observe_effect(
            &effect.id,
            effect.fence,
            &EffectOutcome::Applied {
                receipt: "fixture_identity".into(),
            },
        )
        .unwrap();
        db.register_session(&SessionBinding {
            id: "session".into(),
            engagement_id: e.id,
            room_id: "!project:example.test".into(),
            thread_root: None,
        })
        .unwrap();
        db.enqueue_dispatch(&DispatchInput {
            id: "dispatch".into(),
            session_id: "session".into(),
            task_id: None,
            resources: vec![],
            payload: json!({}),
        })
        .unwrap();
        let cap = db
            .claim_dispatch("runner", now(), 60_000, 60_000, 1)
            .unwrap()
            .unwrap();
        db.start_dispatch(&cap, now()).unwrap();
        let store = DomainStore::start(db, 16).unwrap();
        store
            .runner_command(cap.clone(), RunnerCommand::Check)
            .await
            .unwrap();
        let (entered, entered_rx) = oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::channel::<()>();
        let blocking = store.clone();
        let blocker = tokio::spawn(async move {
            blocking
                .call(1, move |_| {
                    let _ = entered.send(());
                    let _ = release_rx.recv();
                    Ok(())
                })
                .await
        });
        entered_rx.await.unwrap();
        let queued = store.runner_command(cap, RunnerCommand::Check);
        tokio::pin!(queued);
        tokio::select! {
            result=&mut queued=>panic!("writer is blocked; command unexpectedly completed: {result:?}"),
            _=tokio::time::sleep(Duration::from_millis(20))=>{}
        }
        assert_eq!(store.tx.capacity(), 15); // The request has entered the bounded queue.
        let inspect = rusqlite::Connection::open(state.join("domain.sqlite3")).unwrap();
        inspect
            .execute(
                "UPDATE runner_dispatches SET lease_until=?1 WHERE id='dispatch'",
                [now()],
            )
            .unwrap();
        release.send(()).unwrap();
        assert!(matches!(queued.await, Err(Error::RunnerAuthority)));
        blocker.await.unwrap().unwrap();
        store.shutdown().await.unwrap();
    }
}
#[derive(Clone)]
pub struct DomainStore {
    tx: mpsc::Sender<Job>,
    bytes: Arc<Semaphore>,
}
fn weight(value: &impl Serialize) -> Result<u32, Error> {
    let len = serde_json::to_vec(value)?.len();
    if len > 64 * 1024 {
        return Err(hagency_core::InvalidInput("domain command exceeds 64 KiB").into());
    }
    Ok(len.max(1) as u32)
}
fn writer_time() -> Result<u64, Error> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .ok_or(Error::Unavailable)
}
impl DomainStore {
    pub async fn create_task_intent(&self, input: TaskIntent) -> Result<IntentResult, Error> {
        input.definition.validate()?;
        self.call(weight(&input)?, move |db| {
            db.create_task_intent(&input, writer_time()?)
        })
        .await
    }
    pub async fn attach_task_inputs(
        &self,
        task: String,
        scope: String,
        key: String,
        sequences: Vec<u64>,
    ) -> Result<(), Error> {
        self.call(weight(&(&task, &scope, &key, &sequences))?, move |db| {
            db.attach_task_inputs(&task, &scope, &key, &sequences)
        })
        .await
    }
    pub async fn claim_task_notice(&self, lease_ms: u64) -> Result<Option<NoticeClaim>, Error> {
        self.call(1, move |db| db.claim_task_notice(writer_time()?, lease_ms))
            .await
    }
    pub async fn deliver_task_notice(
        &self,
        id: String,
        token: String,
        receipt: NoticeDelivery,
    ) -> Result<IntentResult, Error> {
        receipt.validate()?;
        self.call(weight(&(&id, &token, &receipt))?, move |db| {
            db.deliver_task_notice(&id, &token, &receipt, writer_time()?)
        })
        .await
    }
    pub async fn fail_task_notice(
        &self,
        id: String,
        token: String,
        code: String,
        permanent: bool,
    ) -> Result<(), Error> {
        self.call(weight(&(&id, &token, &code))?, move |db| {
            db.fail_task_notice(&id, &token, &code, permanent, writer_time()?)
        })
        .await
    }
    pub async fn retry_task_notice(&self, id: String) -> Result<(), Error> {
        self.call(weight(&id)?, move |db| {
            db.retry_task_notice(&id, writer_time()?)
        })
        .await
    }
    /// Obtain wall time inside the writer, after queueing; callers cannot freeze
    /// authorization at request arrival or supply a historical clock.
    pub async fn runner_command(
        &self,
        cap: RunnerCapability,
        command: RunnerCommand,
    ) -> Result<serde_json::Value, Error> {
        self.call(weight(&(&cap, &command))?, move |db| {
            let now = writer_time()?;
            Ok(match command {
                RunnerCommand::SendPeer(input) => {
                    serde_json::to_value(db.send_peer(&cap, &input, now)?)?
                }
                RunnerCommand::PeerInbox { after, limit } => {
                    serde_json::to_value(db.runner_peer_inbox(&cap, after, limit, now)?)?
                }
                RunnerCommand::OpenConversation(input) => {
                    serde_json::to_value(db.create_internal_conversation(&cap, &input, now)?)?
                }
                RunnerCommand::Conversation { id } => {
                    serde_json::to_value(db.runner_conversation(&cap, &id, now)?)?
                }
                RunnerCommand::Delegate(input) => {
                    serde_json::to_value(db.delegate_task(&cap, &input, now)?)?
                }
                RunnerCommand::Check => {
                    db.check_runner(&cap, now)?;
                    serde_json::Value::Null
                }
                RunnerCommand::Task { id } => {
                    serde_json::to_value(db.runner_task(&cap, &id, now)?)?
                }
                RunnerCommand::Tasks { after, limit } => {
                    serde_json::to_value(db.runner_tasks(&cap, &after, limit, now)?)?
                }
                RunnerCommand::Comments { id, after, limit } => {
                    serde_json::to_value(db.runner_comments(&cap, &id, after, limit, now)?)?
                }
                RunnerCommand::Inbox { after, limit } => {
                    serde_json::to_value(db.runner_inbox(&cap, after, limit, now)?)?
                }
                RunnerCommand::Mutate {
                    id,
                    call_id,
                    operation,
                } => serde_json::to_value(db.mutate_task(&cap, &id, &call_id, &operation, now)?)?,
            })
        })
        .await
    }
    pub async fn check_runner(&self, cap: RunnerCapability, now: u64) -> Result<(), Error> {
        self.call(weight(&cap)?, move |db| db.check_runner(&cap, now))
            .await
    }
    pub async fn resolve_session(&self, binding: SessionBinding) -> Result<SessionBinding, Error> {
        self.call(weight(&binding)?, move |db| db.resolve_session(&binding))
            .await
    }
    pub async fn ingest_message(
        &self,
        input: InboundMessage,
        targets: Vec<MessageTarget>,
        now: u64,
    ) -> Result<MessageReceipt, Error> {
        input.validate()?;
        self.call(weight(&(&input, &targets))?, move |db| {
            db.ingest_message(&input, &targets, now)
        })
        .await
    }
    pub async fn inbox(
        &self,
        session: String,
        after: u64,
        limit: usize,
        kind: Option<String>,
    ) -> Result<Vec<InboxItem>, Error> {
        self.call(weight(&(&session, &kind))?, move |db| {
            db.inbox(&session, after, limit, kind.as_deref())
        })
        .await
    }
    pub async fn peer_inbox(
        &self,
        session: String,
        after: u64,
        limit: usize,
    ) -> Result<Vec<hagency_core::peers::PeerInboxItem>, Error> {
        self.call(weight(&session)?, move |db| {
            db.peer_inbox(&session, after, limit)
        })
        .await
    }
    pub async fn enqueue_peer_dispatch(
        &self,
        input: DispatchInput,
        sequences: Vec<u64>,
    ) -> Result<(), Error> {
        input.validate()?;
        self.call(weight(&(&input, &sequences))?, move |db| {
            db.enqueue_peer_dispatch(&input, &sequences)
        })
        .await
    }
    pub async fn enqueue_inbox_dispatch(
        &self,
        input: DispatchInput,
        sequences: Vec<u64>,
    ) -> Result<(), Error> {
        input.validate()?;
        self.call(weight(&(&input, &sequences))?, move |db| {
            db.enqueue_inbox_dispatch(&input, &sequences)
        })
        .await
    }
    pub async fn runner_inbox(
        &self,
        cap: RunnerCapability,
        after: u64,
        limit: usize,
        now: u64,
    ) -> Result<Vec<InboxItem>, Error> {
        self.call(weight(&cap)?, move |db| {
            db.runner_inbox(&cap, after, limit, now)
        })
        .await
    }
    pub async fn register_session(&self, binding: SessionBinding) -> Result<(), Error> {
        self.call(weight(&binding)?, move |db| db.register_session(&binding))
            .await
    }
    pub async fn register_workspace(&self, id: String) -> Result<(), Error> {
        self.call(weight(&id)?, move |db| db.register_workspace(&id))
            .await
    }
    pub async fn create_canonical_task(
        &self,
        id: String,
        session: String,
        title: String,
        now: u64,
    ) -> Result<Task, Error> {
        self.call(weight(&(&id, &session, &title))?, move |db| {
            db.create_canonical_task(&id, &session, &title, now)
        })
        .await
    }
    pub async fn create_coordinator_task(
        &self,
        cap: RunnerCapability,
        id: String,
        session: String,
        title: String,
        now: u64,
    ) -> Result<Task, Error> {
        self.call(weight(&(&cap, &id, &session, &title))?, move |db| {
            db.create_coordinator_task(&cap, &id, &session, &title, now)
        })
        .await
    }
    pub async fn enqueue_dispatch(&self, input: DispatchInput) -> Result<(), Error> {
        input.validate()?;
        self.call(weight(&input)?, move |db| db.enqueue_dispatch(&input))
            .await
    }
    pub async fn claim_dispatch(
        &self,
        runner: String,
        now: u64,
        lease_ms: u64,
        capability_ms: u64,
        max_live: u32,
    ) -> Result<Option<RunnerCapability>, Error> {
        self.call(weight(&runner)?, move |db| {
            db.claim_dispatch(&runner, now, lease_ms, capability_ms, max_live)
        })
        .await
    }
    pub async fn start_dispatch(
        &self,
        cap: RunnerCapability,
        now: u64,
    ) -> Result<serde_json::Value, Error> {
        self.call(weight(&cap)?, move |db| db.start_dispatch(&cap, now))
            .await
    }
    pub async fn park_dispatch(
        &self,
        cap: RunnerCapability,
        parked: bool,
        now: u64,
    ) -> Result<(), Error> {
        self.call(weight(&cap)?, move |db| db.park_dispatch(&cap, parked, now))
            .await
    }
    pub async fn renew_dispatch(
        &self,
        cap: RunnerCapability,
        now: u64,
        lease_ms: u64,
    ) -> Result<(), Error> {
        self.call(weight(&cap)?, move |db| {
            db.renew_dispatch(&cap, now, lease_ms)
        })
        .await
    }
    pub async fn fail_before_start(
        &self,
        cap: RunnerCapability,
        now: u64,
        retry_ms: u64,
    ) -> Result<(), Error> {
        self.call(weight(&cap)?, move |db| {
            db.fail_before_start(&cap, now, retry_ms)
        })
        .await
    }
    pub async fn complete_dispatch(
        &self,
        cap: RunnerCapability,
        output: serde_json::Value,
        now: u64,
    ) -> Result<(), Error> {
        self.call(weight(&(&cap, &output))?, move |db| {
            db.complete_dispatch(&cap, &output, now)
        })
        .await
    }
    pub async fn record_late_output(
        &self,
        cap: RunnerCapability,
        output: serde_json::Value,
    ) -> Result<(), Error> {
        self.call(weight(&(&cap, &output))?, move |db| {
            db.record_late_output(&cap, &output)
        })
        .await
    }
    pub async fn reconcile_dispatches(&self, now: u64) -> Result<(), Error> {
        self.call(1, move |db| db.reconcile_dispatches(now)).await
    }
    pub async fn recover_dispatch(
        &self,
        original: String,
        replacement: DispatchInput,
        evidence: String,
        now: u64,
    ) -> Result<(), Error> {
        self.call(weight(&(&original, &replacement, &evidence))?, move |db| {
            db.recover_dispatch(&original, &replacement, &evidence, now)
        })
        .await
    }
    pub async fn runner_task(
        &self,
        cap: RunnerCapability,
        id: String,
        now: u64,
    ) -> Result<Task, Error> {
        self.call(weight(&(&cap, &id))?, move |db| {
            db.runner_task(&cap, &id, now)
        })
        .await
    }
    pub async fn runner_tasks(
        &self,
        cap: RunnerCapability,
        after: String,
        limit: usize,
        now: u64,
    ) -> Result<Vec<Task>, Error> {
        self.call(weight(&(&cap, &after))?, move |db| {
            db.runner_tasks(&cap, &after, limit, now)
        })
        .await
    }
    pub async fn mutate_task(
        &self,
        cap: RunnerCapability,
        id: String,
        call_id: String,
        mutation: TaskMutation,
        now: u64,
    ) -> Result<MutationResult, Error> {
        self.call(weight(&(&cap, &id, &call_id, &mutation))?, move |db| {
            db.mutate_task(&cap, &id, &call_id, &mutation, now)
        })
        .await
    }
    pub async fn runner_comments(
        &self,
        cap: RunnerCapability,
        id: String,
        after: u64,
        limit: usize,
        now: u64,
    ) -> Result<Vec<TaskComment>, Error> {
        self.call(weight(&(&cap, &id))?, move |db| {
            db.runner_comments(&cap, &id, after, limit, now)
        })
        .await
    }
    pub async fn task_events(&self, after: u64, limit: usize) -> Result<Vec<TaskEvent>, Error> {
        self.call(1, move |db| db.task_events(after, limit)).await
    }
    pub fn start(mut repository: DomainRepository, capacity: usize) -> Result<Self, Error> {
        if !(1..=128).contains(&capacity) {
            return Err(hagency_core::InvalidInput("queue capacity must be 1..128").into());
        }
        let (tx, mut rx) = mpsc::channel(capacity);
        std::thread::Builder::new()
            .name("hagency-domain".into())
            .spawn(move || {
                while let Some(job) = rx.blocking_recv() {
                    match job {
                        Job::Run { operation, _bytes } => operation(&mut repository),
                        Job::Shutdown(reply) => {
                            drop(repository);
                            let _ = reply.send(());
                            return;
                        }
                    }
                }
            })?;
        Ok(Self {
            tx,
            bytes: Arc::new(Semaphore::new(8 * 1024 * 1024)),
        })
    }
    async fn call<T: Send + 'static>(
        &self,
        bytes: u32,
        operation: impl FnOnce(&mut DomainRepository) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        let permit = self
            .bytes
            .clone()
            .try_acquire_many_owned(bytes)
            .map_err(|_| Error::Busy)?;
        let (reply, rx) = oneshot::channel();
        let operation = Box::new(move |db: &mut DomainRepository| {
            if !reply.is_closed() {
                let _ = reply.send(operation(db));
            }
        });
        self.tx
            .try_send(Job::Run {
                operation,
                _bytes: permit,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => Error::Busy,
                mpsc::error::TrySendError::Closed(_) => Error::Unavailable,
            })?;
        tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .map_err(|_| Error::OutcomeUnknown)?
            .map_err(|_| Error::Unavailable)?
    }
    pub async fn shutdown(&self) -> Result<(), Error> {
        let (reply, rx) = oneshot::channel();
        tokio::time::timeout(Duration::from_secs(2), self.tx.send(Job::Shutdown(reply)))
            .await
            .map_err(|_| Error::OutcomeUnknown)?
            .map_err(|_| Error::Unavailable)?;
        tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .map_err(|_| Error::OutcomeUnknown)?
            .map_err(|_| Error::Unavailable)
    }
    pub async fn put_resource(&self, resource: Resource) -> Result<CatalogResource, Error> {
        resource.validate()?;
        self.call(weight(&resource)?, move |db| db.put_resource(&resource))
            .await
    }
    pub async fn put_seat(&self, seat: Seat) -> Result<(), Error> {
        seat.validate()?;
        self.call(weight(&seat)?, move |db| db.put_seat(&seat))
            .await
    }
    pub async fn set_role_publication(&self, role: String, published: bool) -> Result<(), Error> {
        self.call(weight(&role)?, move |db| {
            db.set_role_publication(&role, published)
        })
        .await
    }
    pub async fn role_publications(&self) -> Result<Vec<serde_json::Value>, Error> {
        self.call(1, |db| db.role_publications()).await
    }
    pub async fn catalog_for(
        &self,
        fleet: String,
        after: String,
        limit: usize,
    ) -> Result<Vec<CatalogResource>, Error> {
        self.call(weight(&(&fleet, &after))?, move |db| {
            db.catalog_for(Some(&fleet), &after, limit)
        })
        .await
    }
    pub async fn edit_resource(
        &self,
        resource: Resource,
        publication: Option<bool>,
    ) -> Result<CatalogResource, Error> {
        self.call(weight(&resource)?, move |db| {
            db.edit_resource(&resource, publication)
        })
        .await
    }
    pub async fn resource_configurations(
        &self,
        after: String,
        limit: usize,
    ) -> Result<Vec<ConfiguredResource>, Error> {
        self.call(weight(&after)?, move |db| {
            db.resource_configurations(&after, limit)
        })
        .await
    }
    pub async fn seats(&self, after: String, limit: usize) -> Result<Vec<Seat>, Error> {
        self.call(weight(&after)?, move |db| db.seats(&after, limit))
            .await
    }
    pub async fn catalog(
        &self,
        after: String,
        limit: usize,
    ) -> Result<Vec<CatalogResource>, Error> {
        self.call(weight(&after)?, move |db| db.catalog(&after, limit))
            .await
    }
    pub async fn engagements(&self, after: String, limit: usize) -> Result<Vec<Engagement>, Error> {
        self.call(weight(&after)?, move |db| db.engagements(&after, limit))
            .await
    }
    pub async fn resource_budget(&self, id: String) -> Result<Budget, Error> {
        self.call(weight(&id)?, move |db| db.resource_budget(&id))
            .await
    }
    pub async fn register(&self, registration: Registration) -> Result<(), Error> {
        self.call(weight(&registration)?, move |db| db.register(&registration))
            .await
    }
    pub async fn admit(&self, proof: VerifiedRequest, now: u64) -> Result<Engagement, Error> {
        self.call(
            weight(&(
                proof.request(),
                proof.registration(),
                proof.project_name(),
                proof.audit(),
            ))?,
            move |db| db.admit(&proof, now),
        )
        .await
    }
    pub async fn approve(
        &self,
        command: String,
        proof: VerifiedRequest,
        now: u64,
    ) -> Result<Engagement, Error> {
        self.call(
            weight(&(
                &command,
                proof.request(),
                proof.registration(),
                proof.project_name(),
                proof.audit(),
            ))?,
            move |db| db.approve(&command, &proof, now),
        )
        .await
    }
    pub async fn reject(&self, command: String, id: String) -> Result<Engagement, Error> {
        self.call(weight(&(&command, &id))?, move |db| {
            db.reject(&command, &id)
        })
        .await
    }
    pub async fn revoke(&self, command: String, id: String) -> Result<Engagement, Error> {
        self.call(weight(&(&command, &id))?, move |db| {
            db.revoke(&command, &id)
        })
        .await
    }
    pub async fn claim_effect(&self) -> Result<Option<Effect>, Error> {
        self.call(1, DomainRepository::claim_effect).await
    }
    pub async fn retry_cleanup(&self, command: String, id: String) -> Result<Engagement, Error> {
        self.call(weight(&(&command, &id))?, move |db| {
            db.retry_cleanup(&command, &id)
        })
        .await
    }
    pub async fn observe_effect(
        &self,
        id: String,
        fence: u64,
        outcome: EffectOutcome,
    ) -> Result<Engagement, Error> {
        self.call(weight(&(&id, &outcome))?, move |db| {
            db.observe_effect(&id, fence, &outcome)
        })
        .await
    }
}
