//! Single-writer upload registry. Historical observations never restart a POST.
use super::{DomainRepository, execution, matrix_routes, owned_dispatch, serialize};
use crate::Error;
use hagency_core::{
    canonical,
    replies::ReplyRoute,
    tasks::{RunnerCapability, TaskState, clock},
    uploads::*,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::json;

/// Historical identity, not permission to capture, stage or send. No raw ctor.
#[derive(Clone)]
pub struct UploadIdentity {
    id: String,
    request: String,
    capability: String,
}
impl UploadIdentity {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub(crate) fn queue_value(&self) -> serde_json::Value {
        json!([self.id, self.request, self.capability])
    }
}
/// Only the first committed reservation yields this value. Never restored.
pub struct UploadPreparation {
    identity: UploadIdentity,
    secret: String,
}
impl UploadPreparation {
    pub(crate) fn queue_value(&self) -> serde_json::Value {
        json!([self.identity.queue_value(), self.secret])
    }
}
pub struct UploadAdmission {
    pub identity: UploadIdentity,
    pub receipt: UploadReceipt,
    pub preparation: Option<UploadPreparation>,
}
#[derive(Clone)]
pub struct UploadClaim {
    identity: UploadIdentity,
    fence: u64,
    secret: String,
}
impl UploadClaim {
    pub fn fence(&self) -> u64 {
        self.fence
    }
    pub(crate) fn queue_value(&self) -> serde_json::Value {
        json!([self.identity.queue_value(), self.fence, self.secret])
    }
}
/// Returned only after durable WritePossible. A lost return cannot be recreated.
/// Borrowed metadata is host-only; this is not a room-send authorization.
pub struct UploadSend {
    identity: UploadIdentity,
    fence: u64,
    stage: StageCommitment,
    route: ReplyRoute,
}
impl UploadSend {
    pub fn identity(&self) -> &UploadIdentity {
        &self.identity
    }
    pub fn fence(&self) -> u64 {
        self.fence
    }
    pub fn stage(&self) -> &StageCommitment {
        &self.stage
    }
    pub fn route(&self) -> &ReplyRoute {
        &self.route
    }
}
struct Row {
    identity: UploadIdentity,
    scope: String,
    route: ReplyRoute,
    preparation_hash: String,
    stage: Option<StageCommitment>,
    stage_state: UploadStageState,
    state: UploadState,
    fence: u64,
    claim_hash: Option<String>,
    until: Option<u64>,
    cancelled: bool,
    unknown: bool,
    acceptance: Option<String>,
}
impl Row {
    fn receipt(&self, replayed: bool) -> UploadReceipt {
        UploadReceipt {
            id: self.identity.id.clone(),
            stage: self.stage_state,
            upload: self.state,
            cancel_requested: self.cancelled,
            outcome_unknown: self.unknown,
            replayed,
        }
    }
}
fn read(db: &Connection, id: &str) -> Result<Row, Error> {
    let value: Option<String> = db.query_row("SELECT json_object('id',id,'request',request_digest,'capability',capability_digest,'scope',scope_fingerprint,'route',json(route),'preparation',preparation_hash,'stage',json(stage),'stage_state',stage_state,'state',upload_state,'fence',claim_fence,'hash',claim_hash,'until',claim_until,'cancelled',cancel_requested,'unknown',outcome_unknown,'acceptance',acceptance) FROM file_uploads WHERE id=?1",[id],|r|r.get(0)).optional()?;
    let v: serde_json::Value = serde_json::from_str(&value.ok_or(Error::NotFound)?)?;
    let field =
        |key: &str| -> Result<String, Error> { Ok(v[key].as_str().ok_or(Error::Schema)?.into()) };
    Ok(Row {
        identity: UploadIdentity {
            id: field("id")?,
            request: field("request")?,
            capability: field("capability")?,
        },
        scope: field("scope")?,
        route: serde_json::from_value(v["route"].clone())?,
        preparation_hash: field("preparation")?,
        stage: serde_json::from_value(v["stage"].clone())?,
        stage_state: serde_json::from_value(v["stage_state"].clone())?,
        state: serde_json::from_value(v["state"].clone())?,
        fence: v["fence"].as_u64().ok_or(Error::Schema)?,
        claim_hash: v["hash"].as_str().map(str::to_owned),
        until: v["until"].as_u64(),
        cancelled: v["cancelled"] == 1,
        unknown: v["unknown"] == 1,
        acceptance: v["acceptance"].as_str().map(str::to_owned),
    })
}
fn identity(db: &Connection, expected: &UploadIdentity) -> Result<Row, Error> {
    let row = read(db, &expected.id)?;
    if row.identity.request != expected.request || row.identity.capability != expected.capability {
        return Err(Error::RunnerAuthority);
    }
    Ok(row)
}
fn cap_digest(cap: &RunnerCapability) -> Result<String, Error> {
    Ok(canonical::digest(&json!(["upload_cap_v1", cap]))?)
}
fn original(cap: &RunnerCapability, request: &UploadRequest) -> Result<UploadIdentity, Error> {
    request.validate()?;
    hagency_core::project::identifier(&cap.dispatch_id, 128)?;
    hagency_core::project::identifier(&cap.runner_id, 128)?;
    digest(&cap.secret)?;
    Ok(UploadIdentity {
        id: format!(
            "upload_{}",
            &canonical::digest(&json!(["upload_v1", cap.dispatch_id, request.call_id]))?[..32]
        ),
        request: canonical::payload_digest(&json!(["upload_request_v1", request]))?,
        capability: cap_digest(cap)?,
    })
}
fn current_scope(
    db: &Connection,
    cap: &RunnerCapability,
    now: u64,
) -> Result<(String, ReplyRoute), Error> {
    let scope = owned_dispatch::scope(db, cap, now, &["started"])?;
    if scope.task().status == TaskState::Done
        || scope.input().resources.len() != 1
        || !scope.input().resources[0].exclusive
    {
        return Err(Error::RunnerAuthority);
    }
    let route = matrix_routes::route(db, &scope.input().session_id)?;
    if !route.encrypted {
        return Err(Error::RunnerAuthority);
    }
    Ok((scope.fingerprint().into(), route))
}
fn current(db: &Connection, cap: &RunnerCapability, row: &Row, now: u64) -> Result<(), Error> {
    if row.cancelled || cap_digest(cap)? != row.identity.capability {
        return Err(Error::RunnerAuthority);
    }
    let (scope, route) = current_scope(db, cap, now)?;
    if scope != row.scope || route != row.route {
        return Err(Error::RunnerAuthority);
    }
    Ok(())
}
fn secret() -> Result<String, Error> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| Error::Unavailable)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn token(db: &Connection, claim: &UploadClaim, now: u64) -> Result<Row, Error> {
    let row = identity(db, &claim.identity)?;
    if row.fence != claim.fence
        || row.until.is_none_or(|v| v <= now)
        || !execution::matches_secret(row.claim_hash.as_deref().unwrap_or(""), &claim.secret)?
    {
        return Err(Error::RunnerAuthority);
    }
    Ok(row)
}
pub(crate) fn reserve(
    tx: &Transaction<'_>,
    cap: &RunnerCapability,
    request: &UploadRequest,
    now: u64,
) -> Result<UploadAdmission, Error> {
    let id = original(cap, request)?;
    match read(tx, &id.id) {
        Ok(row) => {
            if row.identity.capability != id.capability {
                return Err(Error::RunnerAuthority);
            }
            if row.identity.request != id.request {
                return Err(Error::Conflict);
            }
            return Ok(UploadAdmission {
                identity: id,
                receipt: row.receipt(true),
                preparation: None,
            });
        }
        Err(Error::NotFound) => (),
        Err(e) => return Err(e),
    }
    let (scope, route) = current_scope(tx, cap, now)?;
    let (all, own): (usize, usize) = tx.query_row(
        "SELECT COUNT(*),COUNT(*) FILTER(WHERE dispatch_id=?1) FROM file_uploads",
        [&cap.dispatch_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if all >= MAX_UPLOADS || own >= MAX_DISPATCH_UPLOADS {
        return Err(Error::Capacity);
    }
    let secret = secret()?;
    tx.execute("INSERT INTO file_uploads(id,dispatch_id,call_id,request_digest,capability_digest,scope_fingerprint,route,preparation_hash,stage_state,upload_state,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'unbound','pending',?9,?9)",params![id.id,cap.dispatch_id,request.call_id,id.request,id.capability,scope,serialize(&route)?,canonical::digest(&json!(secret))?,now])?;
    Ok(UploadAdmission {
        receipt: read(tx, &id.id)?.receipt(false),
        identity: id.clone(),
        preparation: Some(UploadPreparation {
            identity: id,
            secret,
        }),
    })
}
pub(crate) fn bind(
    tx: &Transaction<'_>,
    cap: &RunnerCapability,
    preparation: &UploadPreparation,
    stage: &StageCommitment,
    now: u64,
) -> Result<UploadReceipt, Error> {
    stage.validate()?;
    let row = identity(tx, &preparation.identity)?;
    if !execution::matches_secret(&row.preparation_hash, &preparation.secret)? {
        return Err(Error::RunnerAuthority);
    }
    current(tx, cap, &row, now)?;
    if let Some(old) = row.stage {
        if old != *stage {
            return Err(Error::Conflict);
        }
        return Ok(read(tx, &row.identity.id)?.receipt(true));
    }
    let duplicate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM file_uploads WHERE json_extract(stage,'$.namespace_digest')=?1 AND json_extract(stage,'$.operation_id')=?2)",params![stage.namespace_digest,stage.operation_id],|r|r.get(0))?;
    if duplicate {
        return Err(Error::Conflict);
    }
    tx.execute(
        "UPDATE file_uploads SET stage=?2,stage_state='bound',updated_at=?3 WHERE id=?1",
        params![row.identity.id, serialize(stage)?, now],
    )?;
    Ok(read(tx, &row.identity.id)?.receipt(false))
}
pub(crate) fn staged(
    tx: &Transaction<'_>,
    id: &UploadIdentity,
    stage: &StageCommitment,
    observation: UploadStageObservation,
    now: u64,
) -> Result<UploadReceipt, Error> {
    stage.validate()?;
    let row = identity(tx, id)?;
    if row.stage.as_ref() != Some(stage) {
        return Err(Error::Conflict);
    }
    let state = match observation {
        UploadStageObservation::FileAndDirectorySynced => "staged",
        UploadStageObservation::OutcomeUnknown => "unknown",
    };
    // Positive sync remains an exact historical fact. A later missing response
    // cannot erase it, including after upload has begun or been accepted.
    if row.stage_state == UploadStageState::Staged {
        return Ok(row.receipt(true));
    }
    if row.state != UploadState::Pending {
        return Err(Error::State);
    }
    let replayed = serialize(&row.stage_state)? == serialize(&state)?;
    tx.execute(
        "UPDATE file_uploads SET stage_state=?2,updated_at=?3 WHERE id=?1",
        params![id.id, state, now],
    )?;
    Ok(read(tx, &id.id)?.receipt(replayed))
}
pub(crate) fn claim(
    tx: &Transaction<'_>,
    cap: &RunnerCapability,
    id: &UploadIdentity,
    now: u64,
    lease_ms: u64,
) -> Result<Option<UploadClaim>, Error> {
    if !(1..=60_000).contains(&lease_ms) {
        return Err(hagency_core::InvalidInput("invalid upload claim lease").into());
    }
    let row = identity(tx, id)?;
    current(tx, cap, &row, now)?;
    if row.stage_state != UploadStageState::Staged
        || matches!(
            row.state,
            UploadState::WritePossible | UploadState::Accepted
        )
        || row.state == UploadState::Claimed && row.until.is_some_and(|v| v > now)
    {
        return Ok(None);
    }
    let until = now
        .checked_add(lease_ms)
        .filter(|v| *v <= hagency_core::JSON_SAFE_MAX)
        .ok_or(Error::Capacity)?;
    let fence = row
        .fence
        .checked_add(1)
        .filter(|v| *v <= hagency_core::JSON_SAFE_MAX)
        .ok_or(Error::Capacity)?;
    let secret = secret()?;
    tx.execute("UPDATE file_uploads SET upload_state='claimed',claim_fence=?2,claim_hash=?3,claim_until=?4,updated_at=?5 WHERE id=?1",params![id.id,fence,canonical::digest(&json!(secret))?,until,now])?;
    Ok(Some(UploadClaim {
        identity: id.clone(),
        fence,
        secret,
    }))
}
pub(crate) fn begin(
    tx: &Transaction<'_>,
    cap: &RunnerCapability,
    claim: &UploadClaim,
    now: u64,
) -> Result<UploadSend, Error> {
    let row = token(tx, claim, now)?;
    current(tx, cap, &row, now)?;
    if row.state != UploadState::Claimed {
        return Err(Error::State);
    }
    let stage = row.stage.ok_or(Error::Schema)?;
    tx.execute("UPDATE file_uploads SET upload_state='write_possible',outcome_unknown=1,updated_at=?2 WHERE id=?1",params![row.identity.id,now])?;
    Ok(UploadSend {
        identity: row.identity,
        fence: row.fence,
        stage,
        route: row.route,
    })
}
pub(crate) fn validate(
    tx: &Transaction<'_>,
    cap: &RunnerCapability,
    claim: &UploadClaim,
    now: u64,
) -> Result<(), Error> {
    let row = token(tx, claim, now)?;
    current(tx, cap, &row, now)?;
    if row.state != UploadState::WritePossible {
        return Err(Error::State);
    }
    Ok(())
}
pub(crate) fn accept(
    tx: &Transaction<'_>,
    id: &UploadIdentity,
    fence: u64,
    stage: &StageCommitment,
    observed: &UploadAcceptance,
    now: u64,
) -> Result<UploadReceipt, Error> {
    stage.validate()?;
    observed.validate()?;
    let row = identity(tx, id)?;
    if row.fence != fence || row.stage.as_ref() != Some(stage) {
        return Err(Error::RunnerAuthority);
    }
    let evidence = serialize(observed)?;
    if let Some(old) = row.acceptance {
        if old != evidence {
            return Err(Error::Conflict);
        }
        return Ok(read(tx, &id.id)?.receipt(true));
    }
    if row.state != UploadState::WritePossible {
        return Err(Error::State);
    }
    tx.execute("UPDATE file_uploads SET upload_state='accepted',acceptance=?2,outcome_unknown=0,claim_hash=NULL,claim_until=NULL,updated_at=?3 WHERE id=?1",params![id.id,evidence,now])?;
    Ok(read(tx, &id.id)?.receipt(false))
}
pub(crate) fn cancel(
    tx: &Transaction<'_>,
    id: &UploadIdentity,
    now: u64,
) -> Result<UploadReceipt, Error> {
    let row = identity(tx, id)?;
    tx.execute("UPDATE file_uploads SET cancel_requested=1,claim_hash=NULL,claim_until=NULL,updated_at=?2 WHERE id=?1",params![id.id,now])?;
    Ok(read(tx, &id.id)?.receipt(row.cancelled))
}
pub(crate) fn uncertain(
    tx: &Transaction<'_>,
    id: &UploadIdentity,
    fence: u64,
    now: u64,
) -> Result<UploadReceipt, Error> {
    let row = identity(tx, id)?;
    if row.fence != fence || row.state != UploadState::WritePossible {
        return Err(Error::State);
    }
    tx.execute("UPDATE file_uploads SET outcome_unknown=1,claim_hash=NULL,claim_until=NULL,updated_at=?2 WHERE id=?1",params![id.id,now])?;
    Ok(read(tx, &id.id)?.receipt(true))
}
impl DomainRepository {
    pub(crate) fn upload_transaction<T>(
        &mut self,
        time: impl FnOnce() -> Result<u64, Error>,
        operation: impl FnOnce(&Transaction<'_>, u64) -> Result<T, Error>,
    ) -> Result<T, Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let now = time()?;
        clock(now)?;
        let result = operation(&tx, now)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn reserve_upload(
        &mut self,
        cap: &RunnerCapability,
        request: &UploadRequest,
        now: u64,
    ) -> Result<UploadAdmission, Error> {
        self.upload_transaction(|| Ok(now), |tx, now| reserve(tx, cap, request, now))
    }
    pub fn restore_upload(
        &self,
        cap: &RunnerCapability,
        request: &UploadRequest,
    ) -> Result<Option<UploadIdentity>, Error> {
        let id = original(cap, request)?;
        match read(&self.db, &id.id) {
            Ok(row) => {
                if row.identity.capability != id.capability {
                    return Err(Error::RunnerAuthority);
                }
                if row.identity.request != id.request {
                    return Err(Error::Conflict);
                }
                Ok(Some(id))
            }
            Err(Error::NotFound) => Ok(None),
            Err(e) => Err(e),
        }
    }
    pub fn inspect_upload(&self, id: &UploadIdentity) -> Result<UploadReceipt, Error> {
        Ok(identity(&self.db, id)?.receipt(true))
    }
    /// Historical protected storage commitment; no preparation or send capability.
    pub fn upload_stage_commitment(
        &self,
        id: &UploadIdentity,
    ) -> Result<Option<StageCommitment>, Error> {
        Ok(identity(&self.db, id)?.stage)
    }
    /// Exact known fence is a historical observation index, never a send token.
    pub fn upload_fence(&self, id: &UploadIdentity) -> Result<u64, Error> {
        Ok(identity(&self.db, id)?.fence)
    }
    pub fn bind_upload_stage(
        &mut self,
        cap: &RunnerCapability,
        p: &UploadPreparation,
        s: &StageCommitment,
        now: u64,
    ) -> Result<UploadReceipt, Error> {
        self.upload_transaction(|| Ok(now), |tx, n| bind(tx, cap, p, s, n))
    }
    pub fn observe_upload_staged(
        &mut self,
        id: &UploadIdentity,
        s: &StageCommitment,
        o: UploadStageObservation,
        now: u64,
    ) -> Result<UploadReceipt, Error> {
        self.upload_transaction(|| Ok(now), |tx, n| staged(tx, id, s, o, n))
    }
    pub fn claim_upload(
        &mut self,
        cap: &RunnerCapability,
        id: &UploadIdentity,
        now: u64,
        lease: u64,
    ) -> Result<Option<UploadClaim>, Error> {
        self.upload_transaction(|| Ok(now), |tx, n| claim(tx, cap, id, n, lease))
    }
    pub fn begin_upload(
        &mut self,
        cap: &RunnerCapability,
        c: &UploadClaim,
        now: u64,
    ) -> Result<UploadSend, Error> {
        self.upload_transaction(|| Ok(now), |tx, n| begin(tx, cap, c, n))
    }
    pub fn validate_upload_send(
        &mut self,
        cap: &RunnerCapability,
        c: &UploadClaim,
        now: u64,
    ) -> Result<(), Error> {
        self.upload_transaction(|| Ok(now), |tx, n| validate(tx, cap, c, n))
    }
    pub fn record_upload_acceptance(
        &mut self,
        id: &UploadIdentity,
        fence: u64,
        s: &StageCommitment,
        o: &UploadAcceptance,
        now: u64,
    ) -> Result<UploadReceipt, Error> {
        self.upload_transaction(|| Ok(now), |tx, n| accept(tx, id, fence, s, o, n))
    }
    pub fn cancel_upload(&mut self, id: &UploadIdentity, now: u64) -> Result<UploadReceipt, Error> {
        self.upload_transaction(|| Ok(now), |tx, n| cancel(tx, id, n))
    }
    pub fn mark_upload_uncertain(
        &mut self,
        id: &UploadIdentity,
        fence: u64,
        now: u64,
    ) -> Result<UploadReceipt, Error> {
        self.upload_transaction(|| Ok(now), |tx, n| uncertain(tx, id, fence, n))
    }
}
