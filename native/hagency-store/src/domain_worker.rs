use crate::{DomainRepository, Effect, EffectOutcome, Error};
use hagency_core::{
    allocation::Budget,
    authority::{Registration, VerifiedRequest},
    project::{CatalogResource, ConfiguredResource, Engagement, Resource, Seat},
};
use serde::Serialize;
use std::{sync::Arc, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot};

type Operation = Box<dyn FnOnce(&mut DomainRepository) + Send>;
enum Job {
    Run {
        operation: Operation,
        _bytes: OwnedSemaphorePermit,
    },
    Shutdown(oneshot::Sender<()>),
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
impl DomainStore {
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
