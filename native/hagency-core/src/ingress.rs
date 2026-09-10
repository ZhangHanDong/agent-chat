//! Only authenticated host adapters construct ingress and anchor observations.
//! Message fields remain data; exact stored route generations determine scope.
use crate::{
    InvalidInput,
    messages::InboundMessage,
    project::identifier,
    replies::*,
    task_intents::*,
    tasks::{clock, text},
};
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Clone, Serialize)]
pub struct MatrixIngressScope {
    pub session_id: String,
    pub session_generation: u64,
    pub registration_generation: u64,
    pub room_generation: u64,
    pub transport_generation: u64,
}
impl MatrixIngressScope {
    pub fn validate(&self) -> Result<(), InvalidInput> {
        identifier(&self.session_id, 128)?;
        for value in [
            self.session_generation,
            self.registration_generation,
            self.room_generation,
            self.transport_generation,
        ] {
            generation(value)?;
        }
        Ok(())
    }
    pub fn matches(&self, route: &ReplyRoute) -> bool {
        self.session_id == route.session_id
            && self.session_generation == route.session_generation
            && self.registration_generation == route.registration_generation
            && self.room_generation == route.room_generation
            && self.transport_generation == route.transport_generation
    }
}
impl From<&ReplyRoute> for MatrixIngressScope {
    fn from(route: &ReplyRoute) -> Self {
        Self {
            session_id: route.session_id.clone(),
            session_generation: route.session_generation,
            registration_generation: route.registration_generation,
            room_generation: route.room_generation,
            transport_generation: route.transport_generation,
        }
    }
}
#[derive(Clone, Serialize)]
pub struct MatrixEventObservation {
    pub scope: MatrixIngressScope,
    pub event: InboundMessage,
    /// Full MXIDs from authenticated Matrix mention content, not parsed body text.
    pub mentions: BTreeSet<String>,
    pub encrypted: bool,
}
impl MatrixEventObservation {
    pub fn validate(&self) -> Result<(), InvalidInput> {
        self.scope.validate()?;
        self.event.validate()?;
        if self.mentions.len() > 64 {
            return Err(InvalidInput("too many Matrix mentions"));
        }
        for id in &self.mentions {
            text(id, 255)?;
            ruma_common::UserId::parse(id).map_err(|_| InvalidInput("invalid mention MXID"))?;
        }
        Ok(())
    }
}
#[derive(Clone, Serialize)]
pub struct MatrixIngressReceipt {
    pub sequence: u64,
    pub session_id: String,
    pub wake: bool,
    pub created: bool,
    pub projected: bool,
}
#[derive(Clone, Serialize)]
pub struct VerifiedTaskRequest {
    pub scope: MatrixIngressScope,
    pub request_key: String,
    pub source_sequence: u64,
    pub definition: TaskDefinition,
}
impl VerifiedTaskRequest {
    pub fn validate(&self) -> Result<(), InvalidInput> {
        self.scope.validate()?;
        identifier(&self.request_key, 512)?;
        clock(self.source_sequence)?;
        if self.source_sequence == 0 {
            return Err(InvalidInput("source sequence must be positive"));
        }
        self.definition.validate()
    }
}
/// Host scheduling result, not permission for live transport. M5 must add
/// begin-send/uncertain custody before transmitting this frozen private route.
#[derive(Clone, Serialize)]
pub struct VerifiedNoticeClaim {
    pub claim: NoticeClaim,
    pub route: ReplyRoute,
    pub source_event_id: String,
    pub digest: String,
}
