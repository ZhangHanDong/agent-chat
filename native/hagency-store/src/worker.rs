use crate::{Error, Repository};
use hagency_core::custody::{Delivery, Receipt};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot};

type Reply = oneshot::Sender<Result<Receipt, Error>>;
struct Receive {
    delivery: Delivery,
    now: u64,
    reply: Reply,
    _bytes: OwnedSemaphorePermit,
}

enum Job {
    Receive(Receive),
    Outbound {
        command: crate::outbound::Command,
        now: u64,
        submitted: Instant,
        reply: oneshot::Sender<Result<crate::outbound::Reply, Error>>,
        _bytes: OwnedSemaphorePermit,
    },
    #[cfg(test)]
    Pause {
        entered: oneshot::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
    },
    Shutdown(oneshot::Sender<()>),
}

/// The handle is cloneable; the connection is not. Queue and byte budgets bound memory.
#[derive(Clone)]
pub struct Store {
    tx: mpsc::Sender<Job>,
    bytes: Arc<Semaphore>,
    deadline: Duration,
}

impl Store {
    pub fn start(repository: Repository, capacity: usize) -> Result<Self, Error> {
        if !(1..=128).contains(&capacity) {
            return Err(hagency_core::InvalidInput("queue capacity must be 1..128").into());
        }
        let (tx, mut rx) = mpsc::channel::<Job>(capacity);
        std::thread::Builder::new()
            .name("hagency-custody".into())
            .spawn(move || {
                let mut repository = repository;
                while let Some(job) = rx.blocking_recv() {
                    let job = match job {
                        Job::Receive(job) => job,
                        Job::Outbound {
                            command,
                            now,
                            submitted,
                            reply,
                            _bytes,
                        } => {
                            if !reply.is_closed() {
                                let result = execution_time(now, submitted)
                                    .and_then(|now| repository.outbound(command, now));
                                let _ = reply.send(result);
                            }
                            continue;
                        }
                        #[cfg(test)]
                        Job::Pause { entered, release } => {
                            let _ = entered.send(());
                            let _ = release.recv();
                            continue;
                        }
                        Job::Shutdown(reply) => {
                            drop(repository);
                            let _ = reply.send(());
                            return;
                        }
                    };
                    // Caller cancellation before execution has no effect; after execution it is
                    // reconciled via the immutable idempotency key. Never replay an external action.
                    if !job.reply.is_closed() {
                        let result = repository.receive(&job.delivery, job.now);
                        let _ = job.reply.send(result);
                    }
                }
            })?;
        Ok(Self {
            tx,
            bytes: Arc::new(Semaphore::new(16 * 1024 * 1024)),
            deadline: Duration::from_secs(2),
        })
    }

    /// Drain preceding commands and release the database before acknowledging shutdown.
    pub async fn shutdown(&self) -> Result<(), Error> {
        let (reply, rx) = oneshot::channel();
        tokio::time::timeout(self.deadline, self.tx.send(Job::Shutdown(reply)))
            .await
            .map_err(|_| Error::OutcomeUnknown)?
            .map_err(|_| Error::Unavailable)?;
        tokio::time::timeout(self.deadline, rx)
            .await
            .map_err(|_| Error::OutcomeUnknown)?
            .map_err(|_| Error::Unavailable)
    }

    pub fn queue_remaining(&self) -> usize {
        self.tx.capacity()
    }

    /// Host adapter commands share the existing bounded custody writer. These
    /// types cannot be deserialized through the operator fixture endpoint.
    pub async fn outbound(
        &self,
        command: crate::outbound::Command,
        now: u64,
    ) -> Result<crate::outbound::Reply, Error> {
        self.outbound_at(command, now, Instant::now()).await
    }

    pub(crate) async fn outbound_at(
        &self,
        command: crate::outbound::Command,
        now: u64,
        submitted: Instant,
    ) -> Result<crate::outbound::Reply, Error> {
        let len = command.input_bytes()?;
        let bytes = self
            .bytes
            .clone()
            .try_acquire_many_owned(u32::try_from(len).map_err(|_| Error::Busy)?)
            .map_err(|_| Error::Busy)?;
        let (reply, rx) = oneshot::channel();
        self.tx
            .try_send(Job::Outbound {
                command,
                now,
                submitted,
                reply,
                _bytes: bytes,
            })
            .map_err(|e| match e {
                mpsc::error::TrySendError::Full(_) => Error::Busy,
                mpsc::error::TrySendError::Closed(_) => Error::Unavailable,
            })?;
        tokio::time::timeout(self.deadline, rx)
            .await
            .map_err(|_| Error::OutcomeUnknown)?
            .map_err(|_| Error::Unavailable)?
    }

    #[cfg(test)]
    pub(crate) async fn pause_for_test(&self) -> std::sync::mpsc::Sender<()> {
        let (entered, ready) = oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        self.tx
            .send(Job::Pause {
                entered,
                release: blocked,
            })
            .await
            .unwrap_or_else(|_| panic!("worker stopped"));
        ready.await.unwrap();
        release
    }

    pub async fn receive(&self, delivery: Delivery, now: u64) -> Result<Receipt, Error> {
        delivery.validate()?;
        let len = serde_json::to_vec(&delivery)?.len();
        let bytes = self
            .bytes
            .clone()
            .try_acquire_many_owned(u32::try_from(len).map_err(|_| Error::Busy)?)
            .map_err(|_| Error::Busy)?;
        let (reply, rx) = oneshot::channel();
        self.tx
            .try_send(Job::Receive(Receive {
                delivery,
                now,
                reply,
                _bytes: bytes,
            }))
            .map_err(|e| match e {
                mpsc::error::TrySendError::Full(_) => Error::Busy,
                mpsc::error::TrySendError::Closed(_) => Error::Unavailable,
            })?;
        tokio::time::timeout(self.deadline, rx)
            .await
            .map_err(|_| Error::OutcomeUnknown)?
            .map_err(|_| Error::Unavailable)?
    }
}

fn execution_time(now: u64, submitted: Instant) -> Result<u64, Error> {
    let elapsed = submitted.elapsed();
    // Round upward so millisecond truncation cannot extend a lease through a
    // queue boundary. This anchor also covers foreground validation time.
    let elapsed_ms = elapsed.as_nanos().div_ceil(1_000_000);
    u64::try_from(elapsed_ms)
        .ok()
        .and_then(|elapsed| now.checked_add(elapsed))
        .filter(|current| *current <= hagency_core::JSON_SAFE_MAX)
        .ok_or_else(|| hagency_core::InvalidInput("outbound host clock exceeds safe range").into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hagency_core::custody::{Kind, Lane};
    use serde_json::json;
    fn delivery() -> Delivery {
        Delivery {
            binding: "binding".into(),
            generation: 1,
            id: "same_request".into(),
            lane: Lane::Work,
            kind: Kind::Request,
            payload: json!({"model":"fixture", "tokens":100}),
        }
    }
    #[tokio::test]
    async fn retries_are_content_bound() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::start(Repository::open(&dir.path().join("state")).unwrap(), 32).unwrap();
        let mut jobs = tokio::task::JoinSet::new();
        for n in 0..20 {
            let store = store.clone();
            jobs.spawn(async move { store.receive(delivery(), n).await.unwrap() });
        }
        let first = jobs.join_next().await.unwrap().unwrap();
        while let Some(receipt) = jobs.join_next().await {
            assert_eq!(receipt.unwrap(), first);
        }
        let mut changed = delivery();
        changed.payload["tokens"] = json!(101);
        assert!(matches!(
            store.receive(changed, 20).await,
            Err(Error::Conflict)
        ));
        store.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn bounded_queue_refuses_excess_work() {
        // A deliberately unconsumed queue gives a deterministic saturation test.
        let (tx, _rx) = mpsc::channel(1);
        let store = Store {
            tx,
            bytes: Arc::new(Semaphore::new(1024)),
            deadline: Duration::from_millis(50),
        };
        let pending = store.clone();
        let first = tokio::spawn(async move { pending.receive(delivery(), 0).await });
        tokio::task::yield_now().await;
        assert!(matches!(
            store.receive(delivery(), 0).await,
            Err(Error::Busy)
        ));
        assert!(matches!(first.await.unwrap(), Err(Error::OutcomeUnknown)));
    }

    #[tokio::test]
    async fn native_outbound_custody_worker_deadline() {
        use crate::outbound::{Activation, Command, RegistrationIdentity};
        let (tx, mut rx) = mpsc::channel(1);
        let store = Store {
            tx,
            bytes: Arc::new(Semaphore::new(4096)),
            deadline: Duration::from_millis(25),
        };
        let command = Command::Activate(Activation {
            registration: RegistrationIdentity {
                binding: "worker-fixture".into(),
                registration_generation: 1,
                side_id: "matrix.example.test".into(),
                fleet_id: "fleet-fixture".into(),
                registration_fingerprint: "a".repeat(64),
            },
            machine_generation: 1,
            credential_fingerprint: "b".repeat(64),
        });
        let pending = store.clone();
        let input = command.clone();
        let first = tokio::spawn(async move { pending.outbound(input, 1).await });
        tokio::task::yield_now().await;
        assert!(matches!(store.outbound(command, 1).await, Err(Error::Busy)));
        assert!(matches!(first.await.unwrap(), Err(Error::OutcomeUnknown)));
        // Timeout does not fabricate a reply or ACK. Before execution, the same
        // closed-reply guard used by the worker can discard the unstarted job.
        let Some(Job::Outbound { reply, .. }) = rx.recv().await else {
            panic!("queued command")
        };
        assert!(reply.is_closed());
        assert_eq!(store.bytes.available_permits(), 4096);
    }
}
