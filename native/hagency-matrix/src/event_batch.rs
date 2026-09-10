//! Private authenticated journal DTOs. Only the owned SDK constructs proofs;
//! deserialization occurs solely after authenticated journal decryption.
use crate::{Error, wire};
use hagency_core::{canonical, ingress::*, messages::InboundMessage, replies::ReplyRoute};
use matrix_sdk_base::sync::SyncResponse;
use matrix_sdk_common::deserialized_responses::{
    AlgorithmInfo, TimelineEventKind, VerificationState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
pub(crate) const MAX_TIMELINE: usize = 100;
pub(crate) const MAX_TARGETS: usize = 64;
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Phase {
    Prepared,
    Applying,
    Derived,
    Quarantined,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Batch {
    pub token: String,
    pub digest: String,
    pub sdk_identity: String,
    pub targets: Vec<ReplyRoute>,
    pub raw: Value,
    pub phase: Phase,
    pub reason: Option<String>,
    pub events: Vec<Event>,
    pub acknowledgements: Vec<Acknowledgement>,
    pub filtered: usize,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Event {
    pub route: ReplyRoute,
    input: Message,
    pub mentions: BTreeSet<String>,
    proof: Proof,
}
#[derive(Clone, Serialize, Deserialize)]
struct Message {
    server_name: String,
    room_id: String,
    event_id: String,
    sender_mxid: String,
    thread_root: Option<String>,
    body: String,
    kind: String,
    origin_ts: u64,
}
impl Message {
    fn observation(&self) -> InboundMessage {
        InboundMessage {
            server_name: self.server_name.clone(),
            room_id: self.room_id.clone(),
            event_id: self.event_id.clone(),
            sender_mxid: self.sender_mxid.clone(),
            thread_root: self.thread_root.clone(),
            body: self.body.clone(),
            kind: self.kind.clone(),
            origin_ts: self.origin_ts,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Proof {
    Plain,
    Verified {
        sender: String,
        device: String,
        session: String,
    },
}
impl Event {
    pub(crate) fn observation(&self) -> MatrixEventObservation {
        MatrixEventObservation {
            scope: MatrixIngressScope::from(&self.route),
            event: self.input.observation(),
            mentions: self.mentions.clone(),
            encrypted: matches!(self.proof, Proof::Verified { .. }),
        }
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct Acknowledgement {
    pub sequence: u64,
    pub session_id: String,
    pub wake: bool,
}
impl From<&MatrixIngressReceipt> for Acknowledgement {
    fn from(r: &MatrixIngressReceipt) -> Self {
        Self {
            sequence: r.sequence,
            session_id: r.session_id.clone(),
            wake: r.wake,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Receipt {
    pub token: String,
    pub digest: String,
    pub target_digest: String,
    pub acknowledgements: Vec<Acknowledgement>,
    pub filtered: usize,
}
impl Batch {
    pub(crate) fn new(
        raw: Value,
        targets: Vec<ReplyRoute>,
        identity: String,
    ) -> Result<Self, Error> {
        let token = raw
            .get("next_batch")
            .and_then(Value::as_str)
            .ok_or(Error::Wire)?
            .to_owned();
        let digest = canonical::transport_digest(&raw).map_err(|_| Error::Wire)?;
        if targets.is_empty() || targets.len() > MAX_TARGETS {
            return Err(Error::Capacity);
        }
        Ok(Self {
            token,
            digest,
            sdk_identity: identity,
            targets,
            raw,
            phase: Phase::Prepared,
            reason: None,
            events: vec![],
            acknowledgements: vec![],
            filtered: 0,
        })
    }
    pub(crate) fn derive(&mut self, sync: SyncResponse) -> Result<(), Error> {
        if sync
            .rooms
            .left
            .values()
            .any(|room| !room.timeline.events.is_empty())
        {
            return Err(Error::Unsupported);
        }
        let mut events = vec![];
        let mut filtered = 0;
        let mut seen = BTreeSet::new();
        for (room, update) in sync.rooms.joined {
            if update.timeline.limited {
                return Err(Error::Unsupported);
            }
            for timeline in update.timeline.events {
                if seen.len() >= MAX_TIMELINE {
                    return Err(Error::Capacity);
                }
                timeline.raw().deserialize().map_err(|_| Error::Wire)?;
                let value = wire::json(timeline.raw().json().get().as_bytes())?;
                let string =
                    |field: &str| value.get(field).and_then(Value::as_str).ok_or(Error::Wire);
                let id = string("event_id")?;
                if !seen.insert((room.to_string(), id.to_owned())) {
                    return Err(Error::Conflict);
                }
                if value
                    .get("room_id")
                    .is_some_and(|v| v.as_str() != Some(room.as_str()))
                {
                    return Err(Error::Wire);
                }
                let proof = match &timeline.kind {
                    TimelineEventKind::UnableToDecrypt { .. } => return Err(Error::Unsupported),
                    TimelineEventKind::Decrypted(d) => {
                        let info = &d.encryption_info;
                        if !matches!(info.verification_state, VerificationState::Verified)
                            || info.sender.as_str() != string("sender")?
                            || info.forwarder.is_some()
                        {
                            return Err(Error::Unsupported);
                        }
                        let device = info
                            .sender_device
                            .as_ref()
                            .ok_or(Error::Unsupported)?
                            .to_string();
                        let session = match &info.algorithm_info {
                            AlgorithmInfo::MegolmV1AesSha2 {
                                session_id: Some(id),
                                ..
                            } => id.clone(),
                            _ => return Err(Error::Unsupported),
                        };
                        Proof::Verified {
                            sender: info.sender.to_string(),
                            device,
                            session,
                        }
                    }
                    TimelineEventKind::PlainText { .. } => Proof::Plain,
                };
                if string("type")? != "m.room.message" {
                    filtered += 1;
                    continue;
                }
                let content = value
                    .get("content")
                    .and_then(Value::as_object)
                    .ok_or(Error::Wire)?;
                let relation = content.get("m.relates_to");
                let thread = match relation
                    .and_then(|v| v.get("rel_type"))
                    .and_then(Value::as_str)
                {
                    Some("m.thread") => Some(
                        relation
                            .and_then(|v| v.get("event_id"))
                            .and_then(Value::as_str)
                            .ok_or(Error::Wire)?
                            .to_owned(),
                    ),
                    Some(_) => return Err(Error::Unsupported),
                    None => None,
                };
                let mut candidates = self
                    .targets
                    .iter()
                    .filter(|t| t.room_id == room.as_str() && t.thread_root == thread)
                    .collect::<Vec<_>>();
                if candidates.is_empty() && thread.is_none() {
                    candidates = self
                        .targets
                        .iter()
                        .filter(|t| {
                            t.room_id == room.as_str() && t.thread_root.as_deref() == Some(id)
                        })
                        .collect();
                }
                if candidates.len() > 1 {
                    return Err(Error::Conflict);
                }
                let Some(target) = candidates.first() else {
                    filtered += 1;
                    continue;
                };
                if target.encrypted && matches!(proof, Proof::Plain) {
                    return Err(Error::Unsupported);
                }
                let kind = content
                    .get("msgtype")
                    .and_then(Value::as_str)
                    .ok_or(Error::Wire)?;
                if !matches!(kind, "m.text" | "m.notice" | "m.emote") {
                    return Err(Error::Unsupported);
                }
                let mut mentions = BTreeSet::new();
                if let Some(ids) = content.get("m.mentions").and_then(|m| m.get("user_ids")) {
                    let ids = ids.as_array().ok_or(Error::Wire)?;
                    if ids.len() > 64 {
                        return Err(Error::Capacity);
                    }
                    for id in ids {
                        mentions.insert(id.as_str().ok_or(Error::Wire)?.to_owned());
                    }
                }
                let event = Event {
                    route: (*target).clone(),
                    input: Message {
                        server_name: target.server_name.clone(),
                        room_id: room.to_string(),
                        event_id: id.into(),
                        sender_mxid: string("sender")?.into(),
                        thread_root: thread,
                        body: content
                            .get("body")
                            .and_then(Value::as_str)
                            .ok_or(Error::Wire)?
                            .into(),
                        kind: kind.into(),
                        origin_ts: value
                            .get("origin_server_ts")
                            .and_then(Value::as_u64)
                            .ok_or(Error::Wire)?,
                    },
                    mentions,
                    proof,
                };
                event.observation().validate().map_err(|_| Error::Wire)?;
                events.push(event);
            }
        }
        // Every target body is bounded independently and the frozen projection as a
        // whole is bounded too. Oversize remains raw SDK custody, never truncated.
        if serde_json::to_vec(&events)
            .map_err(|_| Error::Storage)?
            .len()
            > 1024 * 1024
        {
            return Err(Error::Capacity);
        }
        self.events = events;
        self.filtered = filtered;
        self.phase = Phase::Derived;
        Ok(())
    }
    pub(crate) fn validate_restored(
        &self,
        identity: &str,
        user: &str,
        device: &str,
    ) -> Result<(), Error> {
        if self.sdk_identity != identity
            || self.targets.is_empty()
            || self.targets.len() > MAX_TARGETS
            || self
                .events
                .len()
                .checked_add(self.filtered)
                .is_none_or(|n| n > MAX_TIMELINE)
            || self.acknowledgements.len() > self.events.len()
            || self.raw.get("next_batch").and_then(Value::as_str) != Some(self.token.as_str())
            || canonical::transport_digest(&self.raw).map_err(|_| Error::Storage)? != self.digest
        {
            return Err(Error::Storage);
        }
        let mut targets = BTreeSet::new();
        for target in &self.targets {
            MatrixIngressScope::from(target)
                .validate()
                .map_err(|_| Error::Storage)?;
            if target.sender_mxid != user
                || target.device_id != device
                || !targets.insert((&target.room_id, &target.thread_root))
            {
                return Err(Error::Storage);
            }
        }
        for event in &self.events {
            event.observation().validate().map_err(|_| Error::Storage)?;
            if !self.targets.contains(&event.route) || event.input.room_id != event.route.room_id {
                return Err(Error::Storage);
            }
            match &event.proof {
                Proof::Plain if event.route.encrypted => return Err(Error::Storage),
                Proof::Verified {
                    sender,
                    device,
                    session,
                } if sender != &event.input.sender_mxid
                    || device.is_empty()
                    || session.is_empty() =>
                {
                    return Err(Error::Storage);
                }
                _ => {}
            }
        }
        for (event, ack) in self.events.iter().zip(&self.acknowledgements) {
            if ack.sequence == 0 || ack.session_id != event.route.session_id {
                return Err(Error::Storage);
            }
        }
        Ok(())
    }
    pub(crate) fn receipt(&self) -> Result<Receipt, Error> {
        Ok(Receipt {
            token: self.token.clone(),
            digest: self.digest.clone(),
            target_digest: canonical::transport_digest(
                &serde_json::to_value(&self.targets).map_err(|_| Error::Storage)?,
            )
            .map_err(|_| Error::Storage)?,
            acknowledgements: self.acknowledgements.clone(),
            filtered: self.filtered,
        })
    }
}
