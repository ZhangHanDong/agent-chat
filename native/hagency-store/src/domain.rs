//! M2 allocation and the future canonical router share this one database owner.
use crate::{Error, database};
use hagency_core::{
    InvalidInput, JSON_SAFE_MAX,
    allocation::{self, Budget},
    authority::{Registration, VerifiedRequest},
    canonical,
    project::{
        self, CatalogResource, CleanupState, ConfiguredResource, Engagement, EngagementState,
        Resource, Seat,
    },
    qualification,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fs::File, path::Path};

pub struct DomainRepository {
    db: Connection,
    _ownership: File,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectState {
    Pending,
    Started,
    Uncertain,
    Complete,
    Failed,
    Cancelled,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Effect {
    pub id: String,
    pub engagement_id: String,
    pub kind: String,
    pub state: EffectState,
    pub fence: u64,
    /// Adapter-only. Never project this into the operator console or catalog.
    pub payload: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum EffectOutcome {
    /// The adapter observed the exact intended effect and supplies a stable receipt.
    Applied {
        receipt: String,
    },
    /// Definitive observation that nothing was applied. A timeout is not this case.
    NotApplied {
        receipt: String,
    },
    Unknown,
}
fn serialize<T: Serialize>(value: &T) -> Result<String, Error> {
    Ok(serde_json::to_string(value)?)
}
fn state_name(state: &EngagementState) -> &'static str {
    match state {
        EngagementState::Pending => "pending",
        EngagementState::Reserved => "reserved",
        EngagementState::Active => "active",
        EngagementState::Rejected => "rejected",
        EngagementState::Revoked => "revoked",
        EngagementState::Failed => "failed",
    }
}
fn read_engagement(db: &Connection, id: &str) -> Result<Engagement, Error> {
    let value: String = db
        .query_row(
            "SELECT projection FROM engagements WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(Error::NotFound)?;
    Ok(serde_json::from_str(&value)?)
}
fn write_engagement(tx: &Transaction<'_>, value: &Engagement) -> Result<(), Error> {
    tx.execute(
        "UPDATE engagements SET state=?2,projection=?3 WHERE id=?1",
        params![value.id, state_name(&value.state), serialize(value)?],
    )?;
    Ok(())
}
fn read_resource(db: &Connection, id: &str) -> Result<Resource, Error> {
    let value: String = db
        .query_row("SELECT config FROM resources WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()?
        .ok_or(Error::NotFound)?;
    Ok(serde_json::from_str(&value)?)
}
fn role_available(db: &Connection, role: &str, fleet: Option<&str>) -> Result<bool, Error> {
    qualification::check_role(role)?;
    let publication: Option<bool> = db
        .query_row(
            "SELECT published FROM role_publications WHERE role=?1",
            [role],
            |r| r.get(0),
        )
        .optional()?;
    if publication == Some(false) {
        return Ok(false);
    }
    if !qualification::cross_family(role) {
        return Ok(true);
    }
    let mut query=db.prepare("SELECT json_extract(f.payload,'$.resource') FROM engagements e JOIN registrations r ON r.fleet_id=e.fleet_id JOIN effects f ON f.engagement_id=e.id AND f.kind='provision' WHERE e.state='active' AND e.generation=r.generation AND (?1 IS NULL OR e.fleet_id=?1)")?;
    let rows = query.query_map([fleet], |r| r.get::<_, String>(0))?;
    let mut families = std::collections::BTreeSet::new();
    let need =
        qualification::default_tier(role).ok_or(hagency_core::InvalidInput("unknown role"))?;
    for row in rows {
        let resource: Resource = serde_json::from_str(&row?)?;
        let (tier, family) = qualification::model(&resource.profile());
        if tier.is_some_and(|got| got >= need)
            && let Some(family) = family
        {
            families.insert(family);
        }
        if families.len() >= 2 {
            return Ok(true);
        }
    }
    Ok(false)
}
fn authority(db: &Connection, proof: &VerifiedRequest, now: u64) -> Result<(), Error> {
    proof.check_fresh(now)?;
    let value: String = db
        .query_row(
            "SELECT config FROM registrations WHERE fleet_id=?1",
            [&proof.request().fleet_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(Error::NotFound)?;
    if serde_json::from_str::<Registration>(&value)? != *proof.registration() {
        return Err(Error::Generation);
    }
    Ok(())
}

fn project_authority(db: &Connection, proof: &VerifiedRequest) -> Result<(), Error> {
    let request = proof.request();
    let existing: Option<(u64,String,String,String)> = db.query_row("SELECT generation,room_id,owner_mxid,owner_room_id FROM projects WHERE fleet_id=?1 AND id=?2",
        params![request.fleet_id,request.target_project_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    if let Some((generation, room, owner, owner_room)) = existing
        && (generation != proof.registration().generation
            || room != request.target_room_id
            || owner != request.owner_mxid
            || owner_room != request.owner_dm_room_id)
    {
        return Err(Error::Generation);
    }
    Ok(())
}

fn bounded_row(
    db: &Connection,
    table: &'static str,
    key: &str,
    value: &str,
    limit: i64,
) -> Result<(), Error> {
    // Callers supply only literal table/column names. Values remain SQL parameters.
    let exists: bool = db.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {key}=?1)"),
        [value],
        |r| r.get(0),
    )?;
    if !exists {
        let count: i64 =
            db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
        if count >= limit {
            return Err(Error::Capacity);
        }
    }
    Ok(())
}
fn decision_digest(kind: &str, engagement: &str) -> Result<String, Error> {
    Ok(canonical::digest(&json!([kind, engagement]))?)
}
fn replay_decision(db: &Connection, id: &str, digest: &str) -> Result<Option<Engagement>, Error> {
    project::identifier(id, 128)?;
    let prior: Option<(String, String)> = db
        .query_row(
            "SELECT digest,result FROM decisions WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    prior
        .map(|(old, result)| {
            if old != digest {
                Err(Error::Conflict)
            } else {
                Ok(serde_json::from_str(&result)?)
            }
        })
        .transpose()
}
fn record_decision(
    tx: &Transaction<'_>,
    id: &str,
    digest: &str,
    value: &Engagement,
) -> Result<(), Error> {
    tx.execute(
        "INSERT INTO decisions(id,digest,result) VALUES(?1,?2,?3)",
        params![id, digest, serialize(value)?],
    )?;
    Ok(())
}
fn budget(db: &Connection, resource: &Resource) -> Result<Budget, Error> {
    let declaration: Option<String> = db
        .query_row(
            "SELECT config FROM seats WHERE id=?1",
            [&resource.seat_id],
            |r| r.get(0),
        )
        .optional()?;
    let declaration = declaration
        .map(|s| serde_json::from_str::<Seat>(&s))
        .transpose()?
        .and_then(|s| s.declaration);
    // Aggregate in SQLite, not by cloning or scanning the whole lifetime store in Rust.
    // SQLite SUM fails rather than wrapping; Tokens also enforces JSON-safe precision.
    let mut statement = db.prepare("SELECT preset_id,seat_id,SUM(tokens) FROM engagements WHERE state IN ('reserved','active') AND (preset_id=?1 OR seat_id=?2) GROUP BY preset_id,seat_id")?;
    let rows = statement.query_map(params![resource.preset_id, resource.seat_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, u64>(2)?,
        ))
    })?;
    let mut commitments = Vec::new();
    for row in rows {
        let (preset, seat, tokens) = row?;
        commitments.push(allocation::Commitment {
            id: format!("{}", commitments.len()),
            preset_id: Some(preset),
            seat_id: Some(seat),
            allocated_tokens: Some(tokens.try_into()?),
            state: "active".into(),
            fulfillment: None,
        });
    }
    Ok(allocation::resource_budget(&allocation::Input {
        preset: allocation::Preset {
            id: resource.preset_id.clone(),
            ceiling: resource.ceiling.clone(),
        },
        seat_id: resource.seat_id.clone(),
        declaration,
        commitments,
        exclude_engagement_id: None,
        for_auto_join: false,
    })?)
}

impl DomainRepository {
    pub fn set_role_publication(&mut self, role: &str, published: bool) -> Result<(), Error> {
        qualification::check_role(role)?;
        self.db.execute("INSERT INTO role_publications(role,published) VALUES(?1,?2) ON CONFLICT(role) DO UPDATE SET published=excluded.published",params![role,published])?;
        Ok(())
    }
    pub fn role_publications(&self) -> Result<Vec<Value>, Error> {
        let mut query = self
            .db
            .prepare("SELECT config FROM resources WHERE json_extract(config,'$.published')=1")?;
        let resources: Vec<Resource> = query
            .query_map([], |r| r.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect::<Result<_, Error>>()?;
        qualification::roles().map(|role| {
            let explicit:Option<bool>=self.db.query_row("SELECT published FROM role_publications WHERE role=?1",[role],|r|r.get(0)).optional()?;
            let available=role_available(&self.db,role,None)? && resources.iter().any(|r|r.qualifies(role));
            Ok(json!({"role":role,"explicitPublication":explicit,"available":available,"crossFamily":qualification::cross_family(role),"defaultTier":qualification::default_tier(role)}))
        }).collect()
    }
    pub fn open(directory: &Path) -> Result<Self, Error> {
        let mut database = database::open(
            directory,
            database::Schema {
                name: "domain.sqlite3",
                lock: "domain.lock",
                application_id: 0x48414732,
                version: 2,
                migrations: &[(2, include_str!("migrations/002-role-publication.sql"))],
                sql: include_str!("domain.sql"),
                verify: "SELECT e.id,e.context,e.evidence,e.projection,f.payload,p.owner_mxid,r.config,s.config,d.result,g.config,rp.role FROM engagements e LEFT JOIN effects f ON f.engagement_id=e.id CROSS JOIN projects p CROSS JOIN resources r CROSS JOIN seats s CROSS JOIN decisions d CROSS JOIN registrations g CROSS JOIN role_publications rp LIMIT 0",
            },
        )?;
        // A previous owner died after an intent became externally executable. Inspection,
        // not automatically repeating that effect, is the only safe default.
        let tx = database
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("UPDATE engagements SET projection=json_set(projection,'$.cleanup','uncertain') WHERE id IN (SELECT engagement_id FROM effects WHERE kind='retire' AND state='started')",[])?;
        tx.execute(
            "UPDATE effects SET state='uncertain' WHERE state='started'",
            [],
        )?;
        tx.commit()?;
        Ok(Self {
            db: database.connection,
            _ownership: database.ownership,
        })
    }
    pub fn register(&mut self, registration: &Registration) -> Result<(), Error> {
        registration.validate()?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        bounded_row(
            &tx,
            "registrations",
            "fleet_id",
            &registration.fleet_id,
            1024,
        )?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT config FROM registrations WHERE fleet_id=?1",
                [&registration.fleet_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(previous) = previous {
            let old: Registration = serde_json::from_str(&previous)?;
            if old == *registration {
                return Ok(());
            }
            if registration.generation <= old.generation {
                return Err(Error::Generation);
            }
            // Rotation fences execution immediately. Existing allocations stay observable
            // and reserved until explicit revoke/reconciliation; rotation cannot erase spend.
        }
        tx.execute("INSERT INTO registrations(fleet_id,generation,config) VALUES(?1,?2,?3) ON CONFLICT(fleet_id) DO UPDATE SET generation=excluded.generation,config=excluded.config",
            params![registration.fleet_id,registration.generation,serialize(registration)?])?;
        tx.commit()?;
        Ok(())
    }
    pub fn put_resource(&mut self, resource: &Resource) -> Result<CatalogResource, Error> {
        self.edit_resource(resource, Some(resource.published))
    }
    pub fn edit_resource(
        &mut self,
        resource: &Resource,
        publication: Option<bool>,
    ) -> Result<CatalogResource, Error> {
        resource.validate()?;
        let mut resource = resource.clone();
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        bounded_row(&tx, "resources", "id", &resource.id(), 2048)?;
        let previous = match read_resource(&tx, &resource.id()) {
            Ok(old) => Some(old),
            Err(Error::NotFound) => None,
            Err(error) => return Err(error),
        };
        resource.published = publication
            .or_else(|| previous.as_ref().map(|r| r.published))
            .unwrap_or(true);
        if let Some(old) = previous
            && (old.seat_id != resource.seat_id
                || old.framework != resource.framework
                || old.model != resource.model
                || old.provider != resource.provider
                || old.reasoning != resource.reasoning)
        {
            let count:i64=tx.query_row("SELECT COUNT(*) FROM engagements WHERE resource_id=?1 AND state IN ('reserved','active')",[resource.id()],|r|r.get(0))?;
            if count != 0 {
                return Err(Error::State);
            }
        }
        resource.roles = resource.eligible_roles();
        tx.execute("INSERT INTO resources(id,preset_id,config) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET config=excluded.config",params![resource.id(),resource.preset_id,serialize(&resource)?])?;
        tx.commit()?;
        Ok(resource.catalog())
    }
    pub fn put_seat(&mut self, seat: &Seat) -> Result<(), Error> {
        seat.validate()?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        bounded_row(&tx, "seats", "id", &seat.id, 2048)?;
        tx.execute("INSERT INTO seats(id,config) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET config=excluded.config", params![seat.id,serialize(seat)?])?;
        tx.commit()?;
        Ok(())
    }
    pub fn catalog(&self, after: &str, limit: usize) -> Result<Vec<CatalogResource>, Error> {
        self.catalog_for(None, after, limit)
    }
    pub fn catalog_for(
        &self,
        fleet: Option<&str>,
        after: &str,
        limit: usize,
    ) -> Result<Vec<CatalogResource>, Error> {
        if limit == 0 || limit > 100 {
            return Err(InvalidInput("page limit must be 1..100").into());
        }
        // At most 2,048 configurations exist. Iterate until enough *qualified*
        // rows are found; filtering a short SQL page would incorrectly hide later IDs.
        let mut query = self.db.prepare("SELECT config FROM resources WHERE id>?1 AND json_extract(config,'$.published')=1 ORDER BY id")?;
        let rows = query.query_map([after], |r| r.get::<_, String>(0))?;
        let allowed: std::collections::BTreeSet<_> = qualification::roles()
            .filter_map(|role| match role_available(&self.db, role, fleet) {
                Ok(true) => Some(Ok(role)),
                Ok(false) => None,
                Err(e) => Some(Err(e)),
            })
            .collect::<Result<_, _>>()?;
        let mut output = Vec::new();
        for row in rows {
            let resource: Resource = serde_json::from_str(&row?)?;
            let mut public = resource.catalog();
            public.roles.retain(|role| allowed.contains(role.as_str()));
            if !public.roles.is_empty() {
                output.push(public);
            }
            if output.len() == limit {
                break;
            }
        }
        Ok(output)
    }
    pub fn resource_configurations(
        &self,
        after: &str,
        limit: usize,
    ) -> Result<Vec<ConfiguredResource>, Error> {
        if limit == 0 || limit > 100 {
            return Err(InvalidInput("page limit must be 1..100").into());
        }
        let mut query = self
            .db
            .prepare("SELECT id,config FROM resources WHERE id>?1 ORDER BY id LIMIT ?2")?;
        query
            .query_map(params![after, limit as i64], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .map(|row| {
                let (id, config) = row?;
                let mut config: Resource = serde_json::from_str(&config)?;
                config.roles = config.eligible_roles();
                Ok(ConfiguredResource { id, config })
            })
            .collect()
    }
    pub fn seats(&self, after: &str, limit: usize) -> Result<Vec<Seat>, Error> {
        if limit == 0 || limit > 100 {
            return Err(InvalidInput("page limit must be 1..100").into());
        }
        let mut query = self
            .db
            .prepare("SELECT config FROM seats WHERE id>?1 ORDER BY id LIMIT ?2")?;
        query
            .query_map(params![after, limit as i64], |r| r.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect()
    }
    pub fn engagements(&self, after: &str, limit: usize) -> Result<Vec<Engagement>, Error> {
        if limit == 0 || limit > 100 {
            return Err(InvalidInput("page limit must be 1..100").into());
        }
        let mut query = self
            .db
            .prepare("SELECT projection FROM engagements WHERE id>?1 ORDER BY id LIMIT ?2")?;
        query
            .query_map(params![after, limit as i64], |r| r.get::<_, String>(0))?
            .map(|s| Ok(serde_json::from_str(&s?)?))
            .collect()
    }
    pub fn get(&self, id: &str) -> Result<Engagement, Error> {
        read_engagement(&self.db, id)
    }
    pub fn resource_budget(&self, id: &str) -> Result<Budget, Error> {
        budget(&self.db, &read_resource(&self.db, id)?)
    }

    pub fn admit(&mut self, proof: &VerifiedRequest, now: u64) -> Result<Engagement, Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        authority(&tx, proof, now)?;
        project_authority(&tx, proof)?;
        let request = proof.request();
        let id = request.engagement_id()?;
        let digest = request.digest()?;
        let previous: Option<String> = tx
            .query_row("SELECT digest FROM engagements WHERE id=?1", [&id], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(old) = previous {
            if old != digest {
                return Err(Error::Conflict);
            }
            return read_engagement(&tx, &id); // Exact replay survives withdrawal.
        }
        bounded_row(&tx, "engagements", "id", &id, 10_000)?;
        let resource = read_resource(&tx, &request.agent_definition.resource_id)?;
        if !resource.qualifies(&request.role)
            || !role_available(&tx, &request.role, Some(&request.fleet_id))?
        {
            return Err(Error::Unqualified);
        }
        let collision: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM engagements WHERE fleet_id=?1 AND project_id=?2 AND name=?3 AND state IN ('pending','reserved','active'))",
            params![request.fleet_id,request.target_project_id,request.agent_definition.name.as_str()], |r| r.get(0))?;
        if collision {
            return Err(Error::Conflict);
        }
        let value = Engagement {
            id,
            request_id: request.request_id.clone(),
            project_id: request.target_project_id.clone(),
            project_room_id: request.target_room_id.clone(),
            project_name: proof.project_name().map(str::to_owned),
            agent_name: request.agent_definition.name.clone(),
            runtime_name: request.agent_definition.runtime_name(
                &request.fleet_id,
                &request.target_project_id,
                &request.request_id,
            )?,
            resource_id: resource.id(),
            role: request.role.clone(),
            requested_tokens: request.requested_tokens,
            state: EngagementState::Pending,
            cleanup: CleanupState::NotRequired,
        };
        tx.execute("INSERT INTO projects(fleet_id,id,generation,room_id,owner_mxid,owner_room_id) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(fleet_id,id) DO NOTHING",
            params![request.fleet_id,request.target_project_id,proof.registration().generation,request.target_room_id,request.owner_mxid,request.owner_dm_room_id])?;
        // The request row itself is the domain inbox marker: same transaction and unique key.
        tx.execute("INSERT INTO engagements(id,fleet_id,generation,request_id,digest,context,evidence,project_id,name,resource_id,tokens,state,projection) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'pending',?12)",
            params![value.id,request.fleet_id,proof.registration().generation,request.request_id,digest,serialize(request)?,serialize(proof.audit())?,request.target_project_id,request.agent_definition.name.as_str(),resource.id(),u64::from(request.requested_tokens),serialize(&value)?])?;
        tx.commit()?;
        Ok(value)
    }
    /// Only an authenticated operator command calls this, after the Matrix adapter
    /// re-verifies current owner/room authority. No production HTTP route exists yet.
    pub fn approve(
        &mut self,
        command_id: &str,
        proof: &VerifiedRequest,
        now: u64,
    ) -> Result<Engagement, Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        authority(&tx, proof, now)?;
        project_authority(&tx, proof)?;
        let request = proof.request();
        let id = request.engagement_id()?;
        let (stored_digest, generation): (String, u64) = tx
            .query_row(
                "SELECT digest,generation FROM engagements WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        if stored_digest != request.digest()? {
            return Err(Error::Conflict);
        }
        if generation != proof.registration().generation {
            return Err(Error::Generation);
        }
        let digest = decision_digest("approve", &id)?;
        if let Some(value) = replay_decision(&tx, command_id, &digest)? {
            return Ok(value);
        }
        let mut value = read_engagement(&tx, &id)?;
        if value.state != EngagementState::Pending {
            return Err(Error::State);
        }
        let resource = read_resource(&tx, &value.resource_id)?;
        if !resource.qualifies(&value.role)
            || !role_available(&tx, &value.role, Some(&request.fleet_id))?
        {
            return Err(Error::Unqualified);
        }
        let remaining = budget(&tx, &resource)?
            .remaining_tokens
            .ok_or(Error::InsufficientCapacity)?;
        if remaining < value.requested_tokens {
            return Err(Error::InsufficientCapacity);
        }
        value.state = EngagementState::Reserved;
        value.project_name = proof.project_name().map(str::to_owned);
        write_engagement(&tx, &value)?;
        tx.execute(
            "UPDATE engagements SET preset_id=?2,seat_id=?3 WHERE id=?1",
            params![id, resource.preset_id, resource.seat_id],
        )?;
        let payload = json!({"request":request,"registrationGeneration":generation,"runtimeName":value.runtime_name,"resource":resource,"approvalEvidence":proof.audit()});
        tx.execute("INSERT INTO effects(id,engagement_id,kind,state,payload) VALUES(?1,?2,'provision','pending',?3)", params![format!("provision_{id}"),id,serialize(&payload)?])?;
        record_decision(&tx, command_id, &digest, &value)?;
        tx.commit()?;
        Ok(value)
    }
    pub fn reject(&mut self, command_id: &str, id: &str) -> Result<Engagement, Error> {
        self.end(command_id, id, false)
    }
    pub fn revoke(&mut self, command_id: &str, id: &str) -> Result<Engagement, Error> {
        self.end(command_id, id, true)
    }
    /// A definitive retirement failure can be retried explicitly. An uncertain
    /// retirement must first be inspected via observe_effect, never blindly replayed.
    pub fn retry_cleanup(&mut self, command_id: &str, id: &str) -> Result<Engagement, Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let digest = decision_digest("retry_cleanup", id)?;
        if let Some(value) = replay_decision(&tx, command_id, &digest)? {
            return Ok(value);
        }
        let value = read_engagement(&tx, id)?;
        if value.state != EngagementState::Revoked {
            return Err(Error::State);
        }
        let changed=tx.execute("UPDATE effects SET state='pending',outcome_digest=NULL WHERE engagement_id=?1 AND kind='retire' AND state='failed'",[id])?;
        if changed != 1 {
            return Err(Error::State);
        }
        record_decision(&tx, command_id, &digest, &value)?;
        tx.commit()?;
        Ok(value)
    }
    fn end(&mut self, command_id: &str, id: &str, revoke: bool) -> Result<Engagement, Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let digest = decision_digest(if revoke { "revoke" } else { "reject" }, id)?;
        if let Some(value) = replay_decision(&tx, command_id, &digest)? {
            return Ok(value);
        }
        let mut value = read_engagement(&tx, id)?;
        if !matches!(
            value.state,
            EngagementState::Pending | EngagementState::Reserved | EngagementState::Active
        ) || !revoke && value.state != EngagementState::Pending
        {
            return Err(Error::State);
        }
        let effect: Option<(String, String)> = tx
            .query_row(
                "SELECT state,payload FROM effects WHERE engagement_id=?1 AND kind='provision'",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((state, payload)) = effect {
            tx.execute("UPDATE effects SET state='cancelled',fence=fence+1 WHERE engagement_id=?1 AND kind='provision'", [id])?;
            if state != "pending" {
                value.cleanup = CleanupState::Pending;
                tx.execute("INSERT INTO effects(id,engagement_id,kind,state,payload) VALUES(?1,?2,'retire','pending',?3)", params![format!("retire_{id}"),id,payload])?;
            }
        }
        value.state = if revoke {
            EngagementState::Revoked
        } else {
            EngagementState::Rejected
        };
        write_engagement(&tx, &value)?;
        record_decision(&tx, command_id, &digest, &value)?;
        tx.commit()?;
        Ok(value)
    }
    pub fn effect(&self, id: &str) -> Result<Effect, Error> {
        read_effect(&self.db, id)
    }
    pub fn claim_effect(&mut self) -> Result<Option<Effect>, Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id: Option<String> = tx.query_row("SELECT f.id FROM effects f JOIN engagements e ON e.id=f.engagement_id JOIN registrations r ON r.fleet_id=e.fleet_id WHERE f.state='pending' AND e.generation=r.generation AND ((f.kind='provision' AND e.state='reserved') OR (f.kind='retire' AND e.state='revoked')) ORDER BY f.id LIMIT 1", [], |r| r.get(0)).optional()?;
        let Some(id) = id else {
            return Ok(None);
        };
        tx.execute(
            "UPDATE effects SET state='started',fence=fence+1 WHERE id=?1 AND fence<?2",
            params![id, JSON_SAFE_MAX],
        )?;
        let effect = read_effect(&tx, &id)?;
        if effect.state != EffectState::Started {
            return Err(Error::State);
        }
        tx.commit()?;
        Ok(Some(effect))
    }
    pub fn observe_effect(
        &mut self,
        id: &str,
        fence: u64,
        outcome: &EffectOutcome,
    ) -> Result<Engagement, Error> {
        match outcome {
            EffectOutcome::Applied { receipt } | EffectOutcome::NotApplied { receipt }
                if receipt.is_empty()
                    || receipt.len() > 2048
                    || receipt.chars().any(char::is_control) =>
            {
                return Err(InvalidInput("observed effect receipt required").into());
            }
            _ => {}
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let effect = read_effect(&tx, id)?;
        let digest = canonical::digest(&serde_json::to_value(outcome)?)?;
        if effect.fence != fence {
            return Err(Error::Generation);
        }
        let old: Option<String> = tx.query_row(
            "SELECT outcome_digest FROM effects WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        if old.as_ref() == Some(&digest) {
            return read_engagement(&tx, &effect.engagement_id);
        }
        if !matches!(effect.state, EffectState::Started | EffectState::Uncertain) {
            return Err(Error::State);
        }
        let mut value = read_engagement(&tx, &effect.engagement_id)?;
        let current: bool = tx.query_row("SELECT e.generation=r.generation FROM engagements e JOIN registrations r ON r.fleet_id=e.fleet_id WHERE e.id=?1", [&value.id], |r| r.get(0))?;
        if !current {
            return Err(Error::Generation);
        }
        let state = match outcome {
            EffectOutcome::Applied { .. } => {
                if effect.kind == "provision" {
                    value.state = EngagementState::Active;
                } else {
                    value.cleanup = CleanupState::Complete;
                }
                "complete"
            }
            EffectOutcome::NotApplied { .. } => {
                if effect.kind == "provision" {
                    value.state = EngagementState::Failed;
                    "failed"
                } else {
                    value.cleanup = CleanupState::Pending;
                    "failed"
                }
            }
            EffectOutcome::Unknown => {
                if effect.kind == "retire" {
                    value.cleanup = CleanupState::Uncertain;
                }
                "uncertain"
            }
        };
        tx.execute(
            "UPDATE effects SET state=?2,outcome_digest=?3 WHERE id=?1",
            params![id, state, digest],
        )?;
        write_engagement(&tx, &value)?;
        tx.commit()?;
        Ok(value)
    }
}
fn read_effect(db: &Connection, id: &str) -> Result<Effect, Error> {
    let row: (String, String, String, u64, String) = db
        .query_row(
            "SELECT engagement_id,kind,state,fence,payload FROM effects WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?
        .ok_or(Error::NotFound)?;
    Ok(Effect {
        id: id.into(),
        engagement_id: row.0,
        kind: row.1,
        state: serde_json::from_value(Value::String(row.2))?,
        fence: row.3,
        payload: serde_json::from_str(&row.4)?,
    })
}
