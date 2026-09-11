use crate::{CancellationToken, Error, HostConfig, HostRoom, http::Http, sdk::Owner};
use hagency_core::replies::*;
use hagency_store::DomainStore;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};
use tokio::sync::{Mutex, Semaphore};

pub(crate) struct Inner {
    pub(crate) config: HostConfig,
    pub(crate) http: Http,
    pub(crate) domain: DomainStore,
    pub(crate) owner: Mutex<Option<Owner>>,
    pub(crate) busy: Arc<Semaphore>,
    pub(crate) attachment_handles: Arc<Semaphore>,
    #[cfg(test)]
    pub(crate) handoff_fault: std::sync::atomic::AtomicU8,
    #[cfg(test)]
    pub(crate) handoff_reached: tokio::sync::Notify,
    #[cfg(test)]
    pub(crate) handoff_continue: tokio::sync::Notify,
    #[cfg(test)]
    pub(crate) outgoing_fault: std::sync::atomic::AtomicU8,
    #[cfg(test)]
    pub(crate) outgoing_reached: tokio::sync::Notify,
    #[cfg(test)]
    pub(crate) outgoing_continue: tokio::sync::Notify,
    #[cfg(test)]
    lose_positive_response: std::sync::atomic::AtomicBool,
}
pub struct Collector {
    pub(crate) inner: Arc<Inner>,
}
#[derive(Debug, PartialEq, Eq)]
pub struct ObservationSummary {
    pub transport_generation: u64,
    pub rooms: usize,
}
impl Collector {
    /// Does not trust credentials or create an SDK identity until collect's
    /// authenticated exact whoami succeeds. No public raw-response setter.
    pub fn new(config: HostConfig, domain: DomainStore) -> Result<Self, Error> {
        if config.approval {
            return Err(Error::Config);
        }
        Ok(Self {
            inner: Inner::new(config, domain)?,
        })
    }
    /// One finite owned job, not a detached sync loop. Caller cancellation or
    /// dropping this future cannot discard a received failure before fencing.
    pub async fn collect(&self, cancel: &CancellationToken) -> Result<ObservationSummary, Error> {
        let permit = self
            .inner
            .busy
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let inner = self.inner.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move {
            let _permit = permit;
            inner.collect(&cancel).await
        })
        .await
        .map_err(|_| Error::OutcomeUnknown)?
    }
    pub async fn close(self) -> Result<(), Error> {
        let _permit = self
            .inner
            .busy
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let inner = self.inner;
        tokio::spawn(async move {
            let _permit = _permit;
            if let Some(state) = inner
                .domain
                .matrix_transport_state(inner.config.identity.transport.engagement_id.clone())
                .await?
                && state.available
                && state.observation == inner.config.identity.transport
            {
                inner
                    .domain
                    .invalidate_matrix_transport(MatrixTransportInvalidation {
                        expected: state.observation,
                        reason: "Matrix SDK owner closed".into(),
                    })
                    .await?;
            }
            if let Some(owner) = inner.owner.lock().await.take() {
                owner.close().await?;
            }
            Ok(())
        })
        .await
        .map_err(|_| Error::OutcomeUnknown)?
    }
}
impl Inner {
    pub(crate) fn new(config: HostConfig, domain: DomainStore) -> Result<Arc<Self>, Error> {
        let http = Http::new(&config)?;
        Ok(Arc::new(Self {
            config,
            http,
            domain,
            owner: Mutex::new(None),
            busy: Arc::new(Semaphore::new(1)),
            attachment_handles: Arc::new(Semaphore::new(crate::attachments::MAX_HANDLES)),
            #[cfg(test)]
            handoff_fault: std::sync::atomic::AtomicU8::new(0),
            #[cfg(test)]
            handoff_reached: tokio::sync::Notify::new(),
            #[cfg(test)]
            handoff_continue: tokio::sync::Notify::new(),
            #[cfg(test)]
            outgoing_fault: std::sync::atomic::AtomicU8::new(0),
            #[cfg(test)]
            outgoing_reached: tokio::sync::Notify::new(),
            #[cfg(test)]
            outgoing_continue: tokio::sync::Notify::new(),
            #[cfg(test)]
            lose_positive_response: std::sync::atomic::AtomicBool::new(false),
        }))
    }

    async fn collect(&self, cancel: &CancellationToken) -> Result<ObservationSummary, Error> {
        let t = &self.config.identity.transport;
        let prior = self
            .domain
            .matrix_transport_state(t.engagement_id.clone())
            .await?;
        if prior.as_ref().is_some_and(|p| {
            p.observation.registration_generation != t.registration_generation
                || p.observation.generation > t.generation
                || (p.observation.generation == t.generation
                    && (!p.available || p.observation != *t))
        }) {
            return Err(Error::Generation);
        }
        let expected = prior.map_or_else(|| t.clone(), |p| p.observation);
        let result = async {
            self.whoami(cancel).await?;
            let mut guard = self.owner.lock().await;
            if guard.is_none() {
                *guard = Some(Owner::open(&self.config).await?);
            }
            let owner = guard.as_ref().ok_or(Error::Storage)?;
            if let Some(batch) = owner.batch().await?
                && batch.phase != crate::event_batch::Phase::Derived
            {
                return Err(Error::OutcomeUnknown);
            }
            if !owner.intake_mode().await? {
                let cursor = owner.cursor().await?;
                let filter = json!({
                    "room": {
                        "rooms": self.config.rooms.iter().map(|r| &r.room_id).collect::<Vec<_>>(),
                        "timeline": {"limit": 0}, "ephemeral": {"types": []},
                        "account_data": {"types": []}, "state": {"lazy_load_members": false}
                    },
                    "presence": {"types": []}, "account_data": {"types": []}
                })
                .to_string();
                let mut query = vec![
                    ("timeout", "0"),
                    ("full_state", "true"),
                    ("filter", filter.as_str()),
                ];
                if let Some(cursor) = cursor.as_deref() {
                    query.push(("since", cursor));
                }
                let value = self
                    .http
                    .request(&["_matrix", "client", "v3", "sync"], Some(&query), cancel)
                    .await?
                    .success()?;
                self.sync_bounds(&value)?;
                owner.sync(value).await?;
            }
            drop(guard);
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            self.domain.observe_matrix_transport(t.clone()).await?;
            #[cfg(test)]
            if self
                .lose_positive_response
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                return Err(Error::OutcomeUnknown);
            }
            for target in &self.config.rooms {
                self.collect_room(target, cancel).await?;
            }
            Ok(ObservationSummary {
                transport_generation: t.generation,
                rooms: self.config.rooms.len(),
            })
        }
        .await;
        if let Err(error) = result {
            return self.fence_observation(expected, error).await;
        }
        result
    }
    pub(crate) async fn expected_transport(&self) -> Result<MatrixTransportObservation, Error> {
        let t = &self.config.identity.transport;
        let prior = self
            .domain
            .matrix_transport_state(t.engagement_id.clone())
            .await?;
        if prior.as_ref().is_some_and(|p| {
            p.observation.registration_generation != t.registration_generation
                || p.observation.generation > t.generation
                || (p.observation.generation == t.generation
                    && (!p.available || p.observation != *t))
        }) {
            return Err(Error::Generation);
        }
        Ok(prior.map_or_else(|| t.clone(), |p| p.observation))
    }
    pub(crate) async fn fence_observation<T>(
        &self,
        expected: MatrixTransportObservation,
        error: Error,
    ) -> Result<T, Error> {
        let t = &self.config.identity.transport;
        // Conservative whole-device fence: incomplete collection cannot
        // leave an earlier private room or long-lived grant usable.
        // Positive commit may have succeeded before its response was lost.
        // Try both known exact identities; never a third/newer incarnation.
        let mut failed = false;
        let candidates = if expected == *t {
            vec![expected]
        } else {
            vec![expected, t.clone()]
        };
        for expected in candidates {
            match self
                .domain
                .invalidate_matrix_transport(MatrixTransportInvalidation {
                    expected,
                    reason: "Matrix authenticated collection failed".into(),
                })
                .await
            {
                Ok(()) | Err(hagency_store::Error::Generation | hagency_store::Error::Conflict) => {
                }
                Err(_) => failed = true,
            }
        }
        if failed {
            return Err(Error::OutcomeUnknown);
        }
        Err(error)
    }
    pub(crate) async fn collect_room(
        &self,
        target: &HostRoom,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        self.collect_room_observation(target, cancel)
            .await
            .map(|_| ())
    }
    pub(crate) async fn collect_room_observation(
        &self,
        target: &HostRoom,
        cancel: &CancellationToken,
    ) -> Result<MatrixRoomObservation, Error> {
        let t = &self.config.identity.transport;
        let prior = self
            .domain
            .matrix_room_state(t.engagement_id.clone(), target.room_id.clone())
            .await?;
        let result = async {
            let state = self
                .http
                .request(
                    &["_matrix", "client", "v3", "rooms", &target.room_id, "state"],
                    None,
                    cancel,
                )
                .await?
                .success()?;
            // Representable unsafe membership/privacy must reach the domain's
            // shared-room invalidation path rather than becoming a local-only error.
            let observation = self.room(target, state)?;
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            self.domain.observe_matrix_room(observation.clone()).await?;
            let current = self
                .domain
                .matrix_room_state(t.engagement_id.clone(), target.room_id.clone())
                .await?;
            if !current.is_some_and(|s| s.available && s.generation == target.generation) {
                return Err(Error::Wire);
            }
            Ok(observation)
        }
        .await;
        if result.is_err()
            && let Some(prior) = prior
            && prior.available
        {
            // Only the scope captured before the failed request can be retired.
            // A concurrent newer room generation is preserved by the domain CAS.
            match self
                .domain
                .invalidate_matrix_room(MatrixRoomInvalidation {
                    engagement_id: t.engagement_id.clone(),
                    registration_generation: t.registration_generation,
                    transport_generation: t.generation,
                    room_id: target.room_id.clone(),
                    generation: prior.generation.checked_add(1).ok_or(Error::Capacity)?,
                    reason: "Matrix full-state observation failed".into(),
                })
                .await
            {
                Ok(()) | Err(hagency_store::Error::Generation | hagency_store::Error::Conflict) => {
                }
                Err(_) => return Err(Error::OutcomeUnknown),
            }
        }
        result
    }
    pub(crate) async fn whoami(&self, cancel: &CancellationToken) -> Result<(), Error> {
        let value = self
            .http
            .request(
                &["_matrix", "client", "v3", "account", "whoami"],
                None,
                cancel,
            )
            .await?
            .success()?;
        if value.get("user_id").and_then(Value::as_str)
            != Some(&self.config.identity.transport.sender_mxid)
            || value.get("device_id").and_then(Value::as_str)
                != Some(&self.config.identity.transport.device_id)
            || value
                .get("is_guest")
                .is_some_and(|v| v != &Value::Bool(false))
        {
            return Err(Error::Identity);
        }
        Ok(())
    }
    pub(crate) fn sync_bounds(&self, value: &Value) -> Result<(), Error> {
        let token = value
            .get("next_batch")
            .and_then(Value::as_str)
            .ok_or(Error::Wire)?;
        if token.is_empty() || token.len() > 4096 || token.chars().any(char::is_control) {
            return Err(Error::Wire);
        }
        let allowed = self
            .config
            .rooms
            .iter()
            .map(|r| r.room_id.as_str())
            .collect::<BTreeSet<_>>();
        if let Some(rooms) = value.get("rooms") {
            let rooms = rooms.as_object().ok_or(Error::Wire)?;
            for (kind, rooms) in rooms {
                if !matches!(kind.as_str(), "join" | "invite" | "leave" | "knock") {
                    return Err(Error::Wire);
                }
                for id in rooms.as_object().ok_or(Error::Wire)?.keys() {
                    if !allowed.contains(id.as_str()) {
                        return Err(Error::Wire);
                    }
                }
            }
        }
        fn count(v: &Value, n: &mut usize, max: usize) -> Result<(), Error> {
            match v {
                Value::Object(o) => {
                    for (k, v) in o {
                        if k == "events" {
                            *n = n
                                .checked_add(v.as_array().ok_or(Error::Wire)?.len())
                                .ok_or(Error::Capacity)?;
                            if *n > max {
                                return Err(Error::Capacity);
                            }
                        }
                        count(v, n, max)?;
                    }
                }
                Value::Array(a) => {
                    for v in a {
                        count(v, n, max)?;
                    }
                }
                _ => {}
            }
            Ok(())
        }
        count(value, &mut 0, self.config.limits.events)
    }
    pub(crate) fn room(
        &self,
        target: &HostRoom,
        value: Value,
    ) -> Result<MatrixRoomObservation, Error> {
        let events = value.as_array().ok_or(Error::Wire)?;
        if events.len() > self.config.limits.events {
            return Err(Error::Capacity);
        }
        let mut states = BTreeSet::new();
        let mut joined = BTreeSet::new();
        let mut invite_only = false;
        let mut encrypted = false;
        for event in events {
            let kind = event
                .get("type")
                .and_then(Value::as_str)
                .ok_or(Error::Wire)?;
            let key = event
                .get("state_key")
                .and_then(Value::as_str)
                .ok_or(Error::Wire)?;
            if !states.insert((kind, key))
                || event
                    .get("room_id")
                    .is_some_and(|v| v.as_str() != Some(target.room_id.as_str()))
            {
                return Err(Error::Wire);
            }
            let content = event
                .get("content")
                .and_then(Value::as_object)
                .ok_or(Error::Wire)?;
            match kind {
                "m.room.member" => {
                    matrix_user(key, &self.config.identity.server_name).map_err(|_| Error::Wire)?;
                    match content.get("membership").and_then(Value::as_str) {
                        Some("join") => {
                            joined.insert(key.to_owned());
                        }
                        Some("invite" | "leave" | "ban" | "knock") => {}
                        _ => return Err(Error::Wire),
                    }
                }
                "m.room.join_rules" => {
                    if !key.is_empty() {
                        return Err(Error::Wire);
                    }
                    invite_only =
                        content.get("join_rule").and_then(Value::as_str) == Some("invite");
                }
                "m.room.encryption" => {
                    if !key.is_empty()
                        || content.get("algorithm").and_then(Value::as_str)
                            != Some("m.megolm.v1.aes-sha2")
                    {
                        return Err(Error::Wire);
                    }
                    encrypted = true;
                }
                _ => {}
            }
        }
        let t = &self.config.identity.transport;
        Ok(MatrixRoomObservation {
            engagement_id: t.engagement_id.clone(),
            registration_generation: t.registration_generation,
            transport_generation: t.generation,
            room_id: target.room_id.clone(),
            generation: target.generation,
            privacy: target.privacy.clone(),
            joined,
            invite_only,
            encrypted,
        })
    }
}

#[cfg(test)]
#[path = "../tests/common/mod.rs"]
pub(crate) mod fixtures;
#[cfg(test)]
mod tests {
    use super::fixtures as common;
    use super::*;
    #[tokio::test]
    async fn native_matrix_transport_generation_lost_positive_response_fences_attempted_identity() {
        let mut fake = common::Fake::start(false).await;
        let mut f = common::Fixture::new();
        f.store
            .observe_matrix_transport(f.identity.transport.clone())
            .await
            .unwrap();
        f.identity.transport.generation = 2;
        let c = Collector::new(f.config(&fake.endpoint), f.store.clone()).unwrap();
        c.inner
            .lose_positive_response
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let cancel = CancellationToken::new();
        let (result, _) = tokio::join!(c.collect(&cancel), async {
            fake.next().await.json(200, common::who());
            fake.next().await.json(200, common::sync("lost"));
        });
        assert_eq!(result, Err(Error::OutcomeUnknown));
        let state = f
            .store
            .matrix_transport_state(f.identity.transport.engagement_id.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(state.observation.generation, 2);
        assert!(!state.available);
        assert!(
            f.store
                .observe_matrix_transport(f.identity.transport.clone())
                .await
                .is_err()
        );
        c.close().await.unwrap();
        f.store.shutdown().await.unwrap();
        fake.close().await;
    }
}
