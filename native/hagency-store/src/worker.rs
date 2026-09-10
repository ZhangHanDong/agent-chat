use crate::{Error, Repository};
use hagency_core::custody::{Delivery, Receipt};
use std::{sync::Arc, time::Duration};
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
}
