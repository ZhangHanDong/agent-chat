use super::{ApprovalHost, ApprovalNotice, Reservation};
use crate::Failure;
use hagency_core::approvals::*;
use hagency_runtime::{
    codex::{
        RequestId, approval::ApprovalRequest, session::PreparedApproval, transport::TransportWrite,
    },
    owned::OwnedSession,
};
use hagency_store::{ApprovalResponseGrant, OwnedApprovalScope};
use std::{
    collections::BTreeMap,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::mpsc, time::Instant};

pub(super) struct Pending {
    pub request: ApprovalRequest,
    pub input: HostApprovalRequest,
    pub id: Option<String>,
    pub owner_deadline: Instant,
    pub response_deadline: Instant,
    pub owner_expires_at: u64,
    pub selected: Option<bool>,
    pub prepared: Option<PreparedApproval>,
    pub grant: Option<ApprovalResponseGrant>,
    pub write: Option<TransportWrite>,
    pub admitted: bool,
    pub recorded: bool,
    pub resolved: bool,
}
#[derive(Default)]
pub(super) struct AdmissionBatch {
    pub ids: Vec<RequestId>,
    pub grants: Vec<ApprovalResponseGrant>,
}
pub(super) struct Callbacks {
    pub host: ApprovalHost,
    pub notices: Option<mpsc::Sender<ApprovalNotice>>,
    pub context: Option<HostApprovalContext>,
    pub entries: BTreeMap<RequestId, Pending>,
    pub parked: Option<Reservation>,
    #[cfg(test)]
    pub fault: Option<super::Fault>,
    #[cfg(test)]
    pub gate: Option<std::sync::Arc<super::Gate>>,
    #[cfg(test)]
    pub receipt_observer: Option<std::sync::Arc<super::Gate>>,
}
pub(super) struct Sending {
    pub id: RequestId,
    pub prepared: PreparedApproval,
    pub grant: ApprovalResponseGrant,
}
pub(crate) struct ApprovalRun {
    pub(super) callbacks: Callbacks,
    pub(super) scope: Option<OwnedApprovalScope>,
    pub(super) batch: AdmissionBatch,
    pub(super) sending: Option<Sending>,
}
impl ApprovalRun {
    pub(crate) fn new(host: ApprovalHost, notices: mpsc::Sender<ApprovalNotice>) -> Self {
        Self {
            callbacks: Callbacks {
                host,
                notices: Some(notices),
                context: None,
                entries: BTreeMap::new(),
                parked: None,
                #[cfg(test)]
                fault: None,
                #[cfg(test)]
                gate: None,
                #[cfg(test)]
                receipt_observer: None,
            },
            scope: None,
            batch: AdmissionBatch::default(),
            sending: None,
        }
    }
    #[cfg(test)]
    pub(crate) fn set_fault(
        &mut self,
        fault: Option<super::Fault>,
        gate: Option<std::sync::Arc<super::Gate>>,
    ) {
        self.callbacks.fault = fault;
        self.callbacks.receipt_observer = gate.clone();
        self.callbacks.gate = gate;
    }
    pub(crate) fn finish_notices(&mut self) {
        self.callbacks.notices.take();
    }
    pub(crate) fn stopped(&mut self) {
        if let Some(parked) = &mut self.callbacks.parked {
            parked.release();
        }
        self.callbacks.parked = None;
    }
}
impl Callbacks {
    pub(super) fn retain(
        &mut self,
        runner: &OwnedSession,
        request: ApprovalRequest,
        until: Instant,
    ) -> Result<RequestId, Failure> {
        if self.entries.len() >= 16 || self.entries.contains_key(request.id()) {
            return Err(Failure::ApprovalCapacity);
        }
        let owner_deadline = runner
            .approval_deadline(request.id())
            .map_err(|_| Failure::Protocol)?;
        let response_deadline =
            owner_deadline + Duration::from_millis(self.host.policy().response_reserve_ms);
        if response_deadline > until || owner_deadline <= Instant::now() {
            return Err(Failure::Deadline);
        }
        let sampled = Instant::now();
        let wall = wall_now()?;
        let owner_expires_at = wall
            .checked_add(
                u64::try_from(
                    owner_deadline
                        .saturating_duration_since(sampled)
                        .as_millis(),
                )
                .map_err(|_| Failure::Deadline)?,
            )
            .ok_or(Failure::Deadline)?;
        let expires_at = wall
            .checked_add(
                u64::try_from(
                    response_deadline
                        .saturating_duration_since(sampled)
                        .as_millis(),
                )
                .map_err(|_| Failure::Deadline)?,
            )
            .ok_or(Failure::Deadline)?;
        let input = HostApprovalRequest {
            context_id: self.context.as_ref().ok_or(Failure::Admission)?.id.clone(),
            upstream_id: rpc_id(request.id())?,
            item_id: request.item_id().into(),
            method: request.method().into(),
            params: request.params().clone(),
            expires_at,
        };
        let key = request.id().clone();
        if self.parked.is_none() {
            self.parked = Some(self.host.reserve_parked()?);
        }
        self.entries.insert(
            key.clone(),
            Pending {
                request,
                input,
                id: None,
                owner_deadline,
                response_deadline,
                owner_expires_at,
                selected: None,
                prepared: None,
                grant: None,
                write: None,
                admitted: false,
                recorded: false,
                resolved: false,
            },
        );
        // Original reservation and callback are retained before request submission.
        self.parked
            .as_mut()
            .ok_or(Failure::ApprovalCapacity)?
            .possible();
        Ok(key)
    }
    pub(super) fn acknowledged(
        &mut self,
        key: &RequestId,
        summary: ApprovalSummary,
    ) -> Result<(), Failure> {
        let entry = self.entries.get_mut(key).ok_or(Failure::Protocol)?;
        entry.id = Some(summary.id.clone());
        if summary.choice.is_some() {
            return Ok(());
        }
        self.notices
            .as_ref()
            .ok_or(Failure::ApprovalCapacity)?
            .try_send(ApprovalNotice {
                request_id: summary.id,
                owner_expires_at: entry.owner_expires_at,
            })
            .map_err(|_| Failure::ApprovalCapacity)
    }
    pub(super) fn release_written(&mut self) {
        if !self.entries.is_empty() && self.entries.values().all(|e| e.recorded) {
            if let Some(parked) = &mut self.parked {
                parked.release();
            }
            self.parked = None;
        }
    }
}
pub(super) fn rpc_id(id: &RequestId) -> Result<ApprovalRpcId, Failure> {
    let value = match id {
        RequestId::Number(n) => {
            ApprovalRpcId::Number((*n).try_into().map_err(|_| Failure::Protocol)?)
        }
        RequestId::String(s) => ApprovalRpcId::String(s.clone()),
    };
    value.validate().map_err(|_| Failure::Protocol)?;
    Ok(value)
}
pub(crate) fn wall_now() -> Result<u64, Failure> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|v| u64::try_from(v.as_millis()).ok())
        .ok_or(Failure::Deadline)
}
pub(super) fn matches(
    grant: &ApprovalResponseGrant,
    entry: &Pending,
    context: &HostApprovalContext,
) -> Result<(), Failure> {
    let application = grant.application();
    if entry.id.as_deref() != Some(application.id.as_str())
        || application.connection_id != context.connection_id
        || application.upstream_id != rpc_id(entry.request.id())?
        || application.thread_id != entry.request.thread_id()
        || application.turn_id != entry.request.turn_id()
        || application.item_id != entry.request.item_id()
        || entry.selected != Some(application.allow)
    {
        return Err(Failure::LostAuthority);
    }
    Ok(())
}

#[cfg(test)]
impl ApprovalRun {
    pub(crate) fn custody(&self) -> (usize, usize, usize, usize) {
        (
            self.callbacks.entries.len(),
            self.callbacks
                .entries
                .values()
                .filter(|e| e.prepared.is_some())
                .count()
                + usize::from(self.sending.is_some()),
            self.callbacks
                .entries
                .values()
                .filter(|e| e.grant.is_some())
                .count()
                + self.batch.grants.len()
                + usize::from(self.sending.is_some()),
            self.callbacks
                .entries
                .values()
                .filter(|e| e.write.is_some())
                .count(),
        )
    }
}
