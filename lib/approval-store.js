import { createHash, randomBytes } from 'crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import path from 'path';

const STORE_VERSION = 2;
const PROJECTION_PAYLOAD_MAX_BYTES = 64 * 1024;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
const EVENT_ID_RE = /^\$[^\s]{1,254}$/;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_AUDIT_LIMIT = 2000;
const MXID_RE = /^@[^:\s]+:[^\s]+$/;
const ROOM_ID_RE = /^![^:\s]+:[^\s]+$/;
const TERMINAL_STATES = new Set(['approved', 'denied', 'expired', 'consumed']);

export class ApprovalStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApprovalStoreError';
    this.code = code;
  }
}

function text(value, field, max = 512) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) {
    throw new ApprovalStoreError('bad_request', `${field} must be 1..${max} characters`);
  }
  return normalized;
}

function optionalText(value, max = 4096) {
  if (value === null || value === undefined) return '';
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length > max) {
    throw new ApprovalStoreError('bad_request', `text exceeds ${max} characters`);
  }
  return normalized;
}

function fullMxid(value, field = 'owner_mxid') {
  const normalized = text(value, field, 255);
  if (!MXID_RE.test(normalized)) {
    throw new ApprovalStoreError('bad_request', `${field} must be a full Matrix MXID`);
  }
  return normalized;
}

function roomId(value, field) {
  const normalized = text(value, field, 255);
  if (!ROOM_ID_RE.test(normalized)) {
    throw new ApprovalStoreError('bad_request', `${field} must be a full Matrix room id`);
  }
  return normalized;
}

function bindingKey(agent, projectRoomId) {
  return `${agent}\u0000${projectRoomId}`;
}

function digestRequest(input) {
  const canonical = JSON.stringify({
    agent: input.agent,
    runtime: input.runtime,
    project: input.project,
    project_room_id: input.projectRoomId,
    owner_mxid: input.ownerMxid,
    owner_dm_room_id: input.ownerDmRoomId,
    upstream_request_id: input.upstreamRequestId,
    tool_name: input.toolName,
    description: input.description,
    input_preview: input.inputPreview,
    router_approval_id: input.routerApprovalId || null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function stableDecisionEventId(record) {
  if (record.decisionEventId) return record.decisionEventId;
  const material = JSON.stringify({
    request_id: record.id,
    decision: record.decision === 'allow' ? 'allow' : 'deny',
    decided_at: record.decidedAt || record.expiresAt || record.createdAt,
    input_digest: record.inputDigest || null,
  });
  return `approval_decision_${createHash('sha256').update(material).digest('hex')}`;
}

function publicRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    agent: record.agent,
    runtime: record.runtime,
    project: record.project,
    project_room_id: record.projectRoomId,
    owner_mxid: record.ownerMxid,
    owner_dm_room_id: record.ownerDmRoomId,
    upstream_request_id: record.upstreamRequestId,
    router_approval_id: record.routerApprovalId || null,
    input_digest: record.inputDigest,
    status: record.status,
    decision: record.decision || null,
    decision_event_id: record.decisionEventId || (record.decision ? stableDecisionEventId(record) : null),
    denial_reason: record.denialReason || null,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    decided_at: record.decidedAt || null,
    consumed_at: record.consumedAt || null,
  };
}

function matrixRecord(record) {
  const safe = publicRecord(record);
  if (!safe) return null;
  return {
    ...safe,
    tool_name: record.toolName,
    description: record.description,
    input_preview: record.inputPreview,
  };
}

export class ApprovalStore {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
      ? Math.floor(options.ttlMs)
      : DEFAULT_TTL_MS;
    this.fsFault = typeof options.fsFault === 'function' ? options.fsFault : () => {};
    this.migrationBatchSize = Number.isFinite(options.migrationBatchSize) ? Math.max(1, Math.floor(options.migrationBatchSize)) : 100;
    this._persistenceHealth = { degraded: false, error: null };
    this.auditLimit = Number.isFinite(options.auditLimit) && options.auditLimit > 0
      ? Math.floor(options.auditLimit)
      : DEFAULT_AUDIT_LIMIT;
    this.state = this._load();
    this._persistedState = structuredClone(this.state);
    this._migrateLegacy();
    if (this._migrationChanged) { this._save(); this._migrationChanged = false; }
  }

  _load() {
    if (!existsSync(this.filePath)) {
      return { version: STORE_VERSION, bindings: {}, requests: {}, audit: [], projectionOutbox: [], migration: { cursor: null } };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return {
        version: Number(parsed?.version) || 1,
        bindings: parsed?.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {},
        requests: parsed?.requests && typeof parsed.requests === 'object' ? parsed.requests : {},
        audit: Array.isArray(parsed?.audit) ? parsed.audit.slice(-this.auditLimit) : [],
        projectionOutbox: Array.isArray(parsed?.projectionOutbox) ? parsed.projectionOutbox : [],
        migration: parsed?.migration && typeof parsed.migration === 'object' ? parsed.migration : { cursor: null },
      };
    } catch (error) {
      throw new ApprovalStoreError('persistence_failed', `failed to load approval store: ${error.message}`);
    }
  }

  _save() {
    const before = structuredClone(this._persistedState || this.state);
    if (this._persistenceHealth.degraded) {
      this.state = before;
      throw new ApprovalStoreError('persistence_degraded', 'approval store requires reload after a post-commit durability failure');
    }
    const dir = path.dirname(this.filePath);
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const bytes = JSON.stringify(this.state, null, 2) + '\n';
    let fd = null;
    let committed = false;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, bytes, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      fd = openSync(tmp, 'r'); fsyncSync(fd); closeSync(fd); fd = null;
      this.fsFault('beforeRename');
      renameSync(tmp, this.filePath);
      committed = true;
      this._persistedState = structuredClone(this.state);
      this.fsFault('afterRename');
      const dirFd = openSync(dir, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      this._persistenceHealth = { degraded: false, error: null };
      return { committed: true, durabilityError: null };
    } catch (error) {
      if (fd !== null) try { closeSync(fd); } catch {}
      if (!committed) {
        this.state = before;
        throw new ApprovalStoreError('persistence_failed', `failed to persist approval store: ${error.message}`);
      }
      this._persistenceHealth = { degraded: true, error: String(error.message || error) };
      return { committed: true, durabilityError: this._persistenceHealth.error };
    }
  }

  persistenceHealth() { return { ...this._persistenceHealth }; }

  _migrateLegacy() {
    if (this.state.version >= STORE_VERSION) return 0;
    const cursor = this.state.migration?.cursor || null;
    let afterCursor = cursor === null;
    let examined = 0;
    let migrated = 0;
    let lastId = cursor;
    let reachedEnd = true;
    for (const id in this.state.requests) {
      if (!afterCursor) { if (id === cursor) afterCursor = true; continue; }
      if (examined >= this.migrationBatchSize) { reachedEnd = false; break; }
      examined += 1; lastId = id;
      const record = this.state.requests[id];
      if (record.projectionRevision) continue;
      record.projectionRevision = 1;
      record.projectionMigration = 'legacy_v1';
      if (record.status === 'pending' && this.now() >= Number(record.expiresAt || 0)) {
        record.status = 'expired'; record.decision = 'deny'; record.denialReason = 'approval_expired';
        record.decidedAt = this.now(); record.decisionEventId = stableDecisionEventId(record);
      }
      this._enqueueProjection(record, 'private_status', record.status, 'legacy_v1');
      migrated += 1;
    }
    this.state.version = reachedEnd ? STORE_VERSION : 1;
    this.state.migration = { cursor: reachedEnd ? null : lastId };
    this._migrationChanged = examined > 0 || reachedEnd;
    return migrated;
  }

  migrateLegacyBatch() {
    const count = this._migrateLegacy();
    if (this._migrationChanged) { this._save(); this._migrationChanged = false; }
    return { migrated: count, cursor: this.state.migration?.cursor || null, complete: this.state.version === STORE_VERSION };
  }

  _enqueueProjection(record, channel, state = record.status, migrationKind = 'native_v2') {
    this.state.projectionOutbox ||= [];
    const revision = record.projectionRevision;
    const targetRoomId = channel === 'public_notice' ? record.projectRoomId : record.ownerDmRoomId;
    if (!targetRoomId) return;
    const identity = `${record.id}\0${revision}\0${channel}`;
    if (this.state.projectionOutbox.some((row) => row.identity === identity)) return;
    this.state.projectionOutbox.push({ identity, casToken: createHash('sha256').update(identity).digest('hex'), requestId: record.id,
      revision, channel, state, targetRoomId,
      migrationKind, plan: null, attemptState: 'unprepared', eventId: null, nextAttemptAt: 0 });
  }

  _advanceProjection(record, state) {
    for (const row of this.state.projectionOutbox || []) {
      if (row.requestId === record.id
        && row.migrationKind === 'legacy_v1'
        && row.state === 'pending'
        && !row.eventId) {
        row.superseded = true;
      }
    }
    record.projectionRevision = (record.projectionRevision || 1) + 1;
    this._enqueueProjection(record, 'private_status', state, record.projectionMigration || 'native_v2');
  }

  _audit(type, detail = {}) {
    this.state.audit.push({ type, at: this.now(), ...detail });
    if (this.state.audit.length > this.auditLimit) {
      this.state.audit.splice(0, this.state.audit.length - this.auditLimit);
    }
  }

  _expire(record, now = this.now()) {
    if (record?.status !== 'pending' || now < Number(record.expiresAt || 0)) return false;
    record.status = 'expired';
    record.decision = 'deny';
    record.denialReason = 'approval_expired';
    record.decidedAt = now;
    record.decisionEventId = stableDecisionEventId(record);
    this._advanceProjection(record, 'expired');
    this._audit('approval.expired', { requestId: record.id, agent: record.agent });
    return true;
  }

  /**
   * Record whether the agent is actually joined to a bound room.
   *
   * SEPARATE FROM upsertBinding ON PURPOSE. Upserting a binding is a governance act — it asserts a
   * project may reach an agent, and it can deny pending requests when the owner changes. Observing
   * membership asserts nothing about permission; it reports what the homeserver says. Folding the
   * observation into the binding write would let a routine liveness check carry the authority of a
   * governance decision, and would make an unreachable room look like a withdrawn binding.
   *
   * Returns null when no such binding exists — an observation about a binding nobody made is not
   * something to store.
   */
  observeBindingMembership(input) {
    const agent = text(input?.agent, 'agent', 128);
    const projectRoomId = roomId(input?.project_room_id ?? input?.projectRoomId, 'project_room_id');
    const key = bindingKey(agent, projectRoomId);
    const binding = this.state.bindings[key];
    if (!binding) return null;
    const joined = input?.agent_joined ?? input?.agentJoined;
    if (typeof joined !== 'boolean') {
      throw new ApprovalStoreError('bad_request', 'agent_joined must be a boolean');
    }
    binding.agentJoined = joined;
    binding.membershipCheckedAt = this.now();
    // `_save()`, the convention every other mutator here uses. My first version called a
    // `persist()` that does not exist on this class — an error `node --check` cannot see, and the
    // same shape as the ReferenceError that killed the bot invite poll.
    this._save();
    return binding;
  }

  upsertBinding(input) {
    const now = this.now();
    const agent = text(input?.agent, 'agent', 128);
    const project = text(input?.project, 'project', 255);
    const projectRoomId = roomId(input?.project_room_id ?? input?.projectRoomId, 'project_room_id');
    const ownerMxid = fullMxid(input?.owner_mxid ?? input?.ownerMxid);
    const ownerDmRoomId = roomId(input?.owner_dm_room_id ?? input?.ownerDmRoomId, 'owner_dm_room_id');
    const key = bindingKey(agent, projectRoomId);
    const previous = this.state.bindings[key] || null;
    const changedOwner = previous && (
      previous.ownerMxid !== ownerMxid || previous.ownerDmRoomId !== ownerDmRoomId
    );
    const binding = {
      agent,
      project,
      projectRoomId,
      ownerMxid,
      ownerDmRoomId,
      active: true,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
      /*
       * MEMBERSHIP IS CARRIED FORWARD, NOT RESET, by a binding write.
       *
       * A binding says a project may reach an agent. Whether the agent is actually IN that room is
       * a separate fact, owned by the bridge and observed against the homeserver — and the two can
       * disagree, which is the whole reason this field exists. Re-pushing a binding must not erase
       * the last observation, or every push would reset reachability to unknown and the console
       * would flicker between "confirmed" and "never checked".
       */
      agentJoined: previous?.agentJoined ?? null,
      membershipCheckedAt: previous?.membershipCheckedAt ?? null,
    };
    this.state.bindings[key] = binding;
    if (changedOwner) {
      for (const record of Object.values(this.state.requests)) {
        if (record.status !== 'pending' || record.agent !== agent || record.projectRoomId !== projectRoomId) continue;
        record.status = 'denied';
        record.decision = 'deny';
        record.denialReason = 'owner_binding_changed';
        record.decidedAt = now;
        record.decisionEventId = stableDecisionEventId(record);
        this._advanceProjection(record, 'denied');
        this._audit('approval.denied', { requestId: record.id, agent, reason: 'owner_binding_changed' });
      }
    }
    this._audit(previous ? 'binding.updated' : 'binding.created', {
      agent,
      project,
      projectRoomId,
      ownerMxid,
    });
    this._save();
    return { ...binding };
  }

  /**
   * Deactivate a binding without forgetting it.
   *
   * The compliance-correct shape, and the operator stated the rule: 「记录要留存，只是停用退役，删除
   * 会有合规问题」. A binding is evidence of who invited what (ADR-002), so it is kept; what changes
   * is that it stops CLAIMING the project can reach the agent.
   *
   * `listBindings` already filters on `active !== false`, so deactivation is enough to remove it from
   * every read — nothing had to learn a new state. `reason` is recorded because a binding that went
   * quiet without one is indistinguishable from a contributor withdrawing permission, and only they
   * may do that.
   */
  deactivateBinding(agentValue, projectRoomIdValue, reason = null) {
    const agent = text(agentValue, 'agent', 128);
    const projectRoomId = roomId(projectRoomIdValue, 'project_room_id');
    const record = this.state.bindings[bindingKey(agent, projectRoomId)];
    if (!record) return null;
    if (record.active === false) return record;
    record.active = false;
    record.deactivatedAt = this.now();
    record.deactivatedReason = reason ? String(reason).slice(0, 256) : null;
    this._audit('binding_deactivated', { agent, projectRoomId, reason: record.deactivatedReason });
    this._save();
    return record;
  }

  removeBinding(agentValue, projectRoomIdValue) {
    const agent = text(agentValue, 'agent', 128);
    const projectRoomId = roomId(projectRoomIdValue, 'project_room_id');
    const key = bindingKey(agent, projectRoomId);
    const binding = this.state.bindings[key];
    if (!binding) return null;
    const now = this.now();
    delete this.state.bindings[key];
    for (const record of Object.values(this.state.requests)) {
      if (record.status !== 'pending' || record.agent !== agent || record.projectRoomId !== projectRoomId) continue;
      record.status = 'denied';
      record.decision = 'deny';
      record.denialReason = 'owner_binding_removed';
      record.decidedAt = now;
      record.decisionEventId = stableDecisionEventId(record);
      this._advanceProjection(record, 'denied');
    }
    this._audit('binding.removed', { agent, projectRoomId, ownerMxid: binding.ownerMxid });
    this._save();
    return { ...binding };
  }

  listBindings(filters = {}) {
    const agent = typeof filters.agent === 'string' ? filters.agent.trim() : '';
    const project = typeof filters.project === 'string' ? filters.project.trim() : '';
    const projectRoomId = typeof filters.project_room_id === 'string'
      ? filters.project_room_id.trim()
      : (typeof filters.projectRoomId === 'string' ? filters.projectRoomId.trim() : '');
    /*
     * INACTIVE BINDINGS ARE HIDDEN BY DEFAULT, and that default is load-bearing: every existing caller
     * asks "which projects can reach this agent right now", and a deactivated binding is no longer an
     * answer to that. `includeInactive` is opt-in for the one caller that asks a different question —
     * "who has EVER served this project" — which decision 7 exists to keep answerable, since it
     * deactivates rather than deletes.
     */
    const includeInactive = filters.includeInactive === true;
    return Object.values(this.state.bindings)
      .filter((binding) => includeInactive || binding?.active !== false)
      .filter((binding) => !agent || binding.agent === agent)
      .filter((binding) => !project || binding.project === project || binding.projectRoomId === project)
      .filter((binding) => !projectRoomId || binding.projectRoomId === projectRoomId)
      .map((binding) => ({ ...binding }));
  }

  createRequest(input, options = {}) {
    const now = this.now();
    const agent = text(input?.agent, 'agent', 128);
    const runtime = text(input?.runtime, 'runtime', 32).toLowerCase();
    if (runtime !== 'claude' && runtime !== 'codex') {
      throw new ApprovalStoreError('bad_request', 'runtime must be claude or codex');
    }
    const upstreamRequestId = text(input?.upstream_request_id ?? input?.upstreamRequestId, 'upstream_request_id', 255);
    const routerApprovalId = optionalText(options?.routerApprovalId, 255);
    if (routerApprovalId && routerApprovalId !== upstreamRequestId) {
      throw new ApprovalStoreError('bad_request', 'router approval origin must match upstream_request_id');
    }
    const requestedProject = optionalText(input?.project, 255);
    const requestedProjectRoomIdRaw = optionalText(
      input?.project_room_id ?? input?.projectRoomId,
      255,
    );
    const requestedProjectRoomId = requestedProjectRoomIdRaw
      ? roomId(requestedProjectRoomIdRaw, 'project_room_id')
      : '';
    const toolName = text(input?.tool_name ?? input?.toolName, 'tool_name', 255);
    const description = optionalText(input?.description, 4096);
    const inputPreview = optionalText(input?.input_preview ?? input?.inputPreview, 8192);

    for (const record of Object.values(this.state.requests)) {
      this._expire(record, now);
      if (record.status === 'pending'
        && record.agent === agent
        && record.runtime === runtime
        && record.upstreamRequestId === upstreamRequestId) {
        if ((record.routerApprovalId || '') !== routerApprovalId) {
          throw new ApprovalStoreError('conflict', 'pending upstream request already belongs to a different approval origin');
        }
        this._save();
        return publicRecord(record);
      }
    }

    const bindings = this.listBindings({
      agent,
      project: requestedProject,
      project_room_id: requestedProjectRoomId,
    });
    const binding = bindings.length === 1 ? bindings[0] : null;
    const id = `approval_${randomBytes(16).toString('hex')}`;
    const expiresAtRaw = Number(input?.expires_at ?? input?.expiresAt);
    const expiresAt = Number.isFinite(expiresAtRaw) && expiresAtRaw > now
      ? Math.min(Math.floor(expiresAtRaw), now + this.ttlMs)
      : now + this.ttlMs;

    if (!binding) {
      const reason = bindings.length === 0 ? 'owner_binding_missing' : 'owner_binding_ambiguous';
      const denied = {
        id,
        agent,
        runtime,
        project: requestedProject || null,
        projectRoomId: null,
        ownerMxid: null,
        ownerDmRoomId: null,
        upstreamRequestId,
        routerApprovalId: routerApprovalId || null,
        toolName,
        description,
        inputPreview,
        inputDigest: null,
        status: 'denied',
        decision: 'deny',
        denialReason: reason,
        createdAt: now,
        expiresAt,
        decidedAt: now,
        consumedAt: null,
      };
      denied.decisionEventId = stableDecisionEventId(denied);
      this.state.requests[id] = denied;
      this._audit('approval.denied', { requestId: id, agent, reason });
      this._save();
      return publicRecord(denied);
    }

    const record = {
      id,
      agent,
      runtime,
      project: binding.project,
      projectRoomId: binding.projectRoomId,
      ownerMxid: binding.ownerMxid,
      ownerDmRoomId: binding.ownerDmRoomId,
      upstreamRequestId,
      routerApprovalId: routerApprovalId || null,
      toolName,
      description,
      inputPreview,
      status: 'pending',
      decision: null,
      denialReason: null,
      createdAt: now,
      expiresAt,
      decidedAt: null,
      consumedAt: null,
    };
    record.inputDigest = digestRequest(record);
    record.projectionRevision = 1;
    record.projectionMigration = 'native_v2';
    this.state.requests[id] = record;
    this._enqueueProjection(record, 'private_request', 'pending');
    this._enqueueProjection(record, 'public_notice', 'pending');
    this._audit('approval.created', {
      requestId: id,
      agent,
      project: record.project,
      projectRoomId: record.projectRoomId,
      ownerMxid: record.ownerMxid,
    });
    this._save();
    return publicRecord(record);
  }

  getRequest(id, options = {}) {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    const record = this.state.requests[normalizedId];
    if (!record) return null;
    if (this._expire(record)) this._save();
    return options.matrix === true ? matrixRecord(record) : publicRecord(record);
  }

  listRequests(filters = {}) {
    const status = typeof filters.status === 'string' ? filters.status.trim() : '';
    const upstreamPrefix = typeof filters.upstream_request_prefix === 'string'
      ? filters.upstream_request_prefix.trim()
      : '';
    let changed = false;
    const rows = [];
    for (const record of Object.values(this.state.requests)) {
      if (this._expire(record)) changed = true;
      if (status && record.status !== status) continue;
      if (upstreamPrefix && !record.upstreamRequestId.startsWith(upstreamPrefix)) continue;
      rows.push(publicRecord(record));
    }
    if (changed) this._save();
    return rows;
  }

  submitMatrixVerdict(id, input) {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    const record = this.state.requests[normalizedId];
    if (!record) return { ok: false, code: 'not_found', record: null };
    const now = this.now();
    if (this._expire(record, now)) {
      this._audit('approval.verdict_rejected', { requestId: normalizedId, reason: 'expired' });
      this._save();
      return { ok: false, code: 'expired', record: publicRecord(record) };
    }
    if (record.status !== 'pending') {
      this._audit('approval.verdict_rejected', { requestId: normalizedId, reason: 'not_pending', status: record.status });
      this._save();
      return { ok: false, code: 'not_pending', record: publicRecord(record) };
    }

    const action = typeof input?.action === 'string' ? input.action.trim() : '';
    const submittedEventId = optionalText(input?.event_id ?? input?.eventId, 255) || null;
    const expected = {
      senderMxid: record.ownerMxid,
      roomId: record.ownerDmRoomId,
      agent: record.agent,
      project: record.project,
      projectRoomId: record.projectRoomId,
      inputDigest: record.inputDigest,
    };
    const actual = {
      senderMxid: input?.sender_mxid ?? input?.senderMxid,
      roomId: input?.room_id ?? input?.roomId,
      agent: input?.agent,
      project: input?.project,
      projectRoomId: input?.project_room_id ?? input?.projectRoomId,
      inputDigest: input?.input_digest ?? input?.inputDigest,
    };
    const mismatch = Object.keys(expected).find((key) => expected[key] !== actual[key]);
    if (mismatch || (action !== 'approve_once' && action !== 'deny')) {
      const reason = mismatch ? `${mismatch}_mismatch` : 'invalid_action';
      this._audit('approval.verdict_rejected', {
        requestId: normalizedId,
        reason,
        senderMxid: typeof actual.senderMxid === 'string' ? actual.senderMxid : null,
        roomId: typeof actual.roomId === 'string' ? actual.roomId : null,
      });
      this._save();
      return { ok: false, code: reason, record: publicRecord(record) };
    }

    record.status = action === 'approve_once' ? 'approved' : 'denied';
    record.decision = action === 'approve_once' ? 'allow' : 'deny';
    record.denialReason = action === 'deny' ? 'owner_denied' : null;
    record.decidedAt = now;
    record.decisionEventId = stableDecisionEventId(record);
    this._advanceProjection(record, record.status);
    record.matrixEventId = submittedEventId;
    this._audit('approval.verdict_accepted', {
      requestId: normalizedId,
      agent: record.agent,
      decision: record.decision,
      senderMxid: record.ownerMxid,
      roomId: record.ownerDmRoomId,
      eventId: record.matrixEventId,
    });
    this._save();
    return { ok: true, code: record.status, record: publicRecord(record) };
  }

  denyPending(id, reason = 'delivery_failed') {
    const record = this.state.requests[id];
    if (!record) return null;
    const now = this.now();
    if (this._expire(record, now)) {
      this._save();
      return publicRecord(record);
    }
    if (record.status !== 'pending') return publicRecord(record);
    record.status = 'denied';
    record.decision = 'deny';
    record.denialReason = optionalText(reason, 255) || 'delivery_failed';
    record.decidedAt = now;
    record.decisionEventId = stableDecisionEventId(record);
    this._advanceProjection(record, record.status);
    this._audit('approval.denied', { requestId: id, agent: record.agent, reason: record.denialReason });
    this._save();
    return publicRecord(record);
  }

  consumeDecision(id, agentValue, inputDigestValue = null) {
    const record = this.state.requests[id];
    if (!record) return { ok: false, code: 'not_found', record: null };
    const now = this.now();
    if (this._expire(record, now)) {
      this._save();
      return { ok: false, code: 'expired', record: publicRecord(record) };
    }
    if (record.agent !== agentValue) return { ok: false, code: 'agent_mismatch', record: publicRecord(record) };
    if (inputDigestValue && record.inputDigest !== inputDigestValue) {
      return { ok: false, code: 'input_digest_mismatch', record: publicRecord(record) };
    }
    if (record.status === 'pending') return { ok: false, code: 'pending', record: publicRecord(record) };
    if (record.status === 'consumed') return { ok: false, code: 'consumed', record: publicRecord(record) };
    if (!TERMINAL_STATES.has(record.status)) return { ok: false, code: 'invalid_state', record: publicRecord(record) };

    const decision = record.decision === 'allow' ? 'allow' : 'deny';
    record.decisionEventId = stableDecisionEventId(record);
    record.status = 'consumed';
    record.consumedAt = now;
    this._advanceProjection(record, 'consumed');
    this._audit('approval.consumed', { requestId: id, agent: record.agent, decision });
    this._save();
    return { ok: true, code: 'consumed', decision, decision_event_id: record.decisionEventId, record: publicRecord(record) };
  }


  sweepExpired(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 200);
    const pending = Object.values(this.state.requests).filter((r) => r.status === 'pending')
      .sort((a, b) => Number(a.expiresAt) - Number(b.expiresAt) || a.id.localeCompare(b.id));
    const now = this.now(); let expired = 0;
    for (const record of pending.slice(0, limit)) if (this._expire(record, now)) expired += 1;
    if (expired) this._save();
    return { scanned: Math.min(limit, pending.length), expired };
  }

  listDueProjections(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 200);
    const now = this.now();
    const pending = (this.state.projectionOutbox || []).filter((r) => !r.eventId && !r.superseded);
    const minimum = new Map();
    for (const row of pending) minimum.set(row.requestId, Math.min(minimum.get(row.requestId) ?? Infinity, row.revision));
    return pending.filter((r) => Number(r.nextAttemptAt || 0) <= now && r.revision === minimum.get(r.requestId))
      .sort((a, b) => Number(a.nextAttemptAt) - Number(b.nextAttemptAt)
        || a.requestId.localeCompare(b.requestId)
        || a.revision - b.revision
        || a.channel.localeCompare(b.channel))
      .slice(0, limit).map((r) => this._projectionView(r));
  }

  _projectionView(row) {
    return { request_id: row.requestId, revision: row.revision, channel: row.channel, state: row.state,
      target_room_id: row.targetRoomId, migration_kind: row.migrationKind, cas_token: row.casToken,
      plan: row.plan ? { ...structuredClone(row.plan), cas_token: row.planCasToken, attempt_state: row.attemptState } : null };
  }

  _planRow(planToken, input = {}) {
    const row = this.state.projectionOutbox.find((r) => r.planCasToken === planToken && r.plan);
    const p = row?.plan;
    if (!row || input.publisher_mxid !== p.publisher_mxid
      || input.room_id !== row.targetRoomId
      || input.credential_generation !== p.credential_generation
      || input.transaction_id !== p.transaction_id) {
      throw new ApprovalStoreError('conflict', 'projection plan identity mismatch');
    }
    return row;
  }

  prepareProjection(casToken, input) {
    const row = this.state.projectionOutbox.find((r) => r.casToken === casToken && !r.eventId && !r.superseded);
    if (!row) throw new ApprovalStoreError('conflict', 'projection row changed');
    if (!row.plan) {
      const payload = input?.prepared_payload;
      if (Buffer.byteLength(JSON.stringify(payload ?? null)) > PROJECTION_PAYLOAD_MAX_BYTES) {
        throw new ApprovalStoreError('bad_request', 'prepared payload too large');
      }
      const plan = {
        publisher_mxid: fullMxid(input?.publisher_mxid, 'publisher_mxid'),
        homeserver: text(input?.homeserver, 'homeserver', 255),
        credential_kind: text(input?.credential_kind, 'credential_kind', 64),
        credential_generation: text(input?.credential_generation, 'credential_generation', 255),
        payload_version: Number(input?.payload_version) || 1,
        prepared_event_type: text(input?.prepared_event_type, 'prepared_event_type', 255),
        prepared_payload: structuredClone(payload),
      };
      const transactionMaterial = `${row.identity}\0${plan.publisher_mxid}\0${plan.credential_generation}`;
      plan.transaction_id = `hafleet_${createHash('sha256').update(transactionMaterial).digest('hex').slice(0, 32)}`;
      row.planCasToken = createHash('sha256').update(JSON.stringify([row.identity,row.targetRoomId,plan])).digest('hex');
      row.plan = plan; row.attemptState = 'ready'; this._save();
    }
    return { plan: { ...structuredClone(row.plan), cas_token: row.planCasToken, attempt_state: row.attemptState } };
  }

  beginProjectionSend(planToken, input = {}) {
    const row = this._planRow(planToken, input);
    if (row.eventId) return { plan: { ...structuredClone(row.plan), cas_token: row.planCasToken, attempt_state: 'receipted' } };
    if (row.attemptState === 'ready' || row.attemptState === 'uncertain') { row.attemptState = 'attempted'; this._save(); }
    return { plan: { ...structuredClone(row.plan), cas_token: row.planCasToken, attempt_state: row.attemptState } };
  }

  receiptProjection(planToken, input) {
    const eventId = text(input?.event_id, 'event_id', 255);
    if (!EVENT_ID_RE.test(eventId)) throw new ApprovalStoreError('bad_request', 'event_id must be a Matrix event id');
    const row = this._planRow(planToken, input);
    if (row.eventId) {
      if (row.eventId === eventId) return { event_id: eventId };
      throw new ApprovalStoreError('conflict', 'projection already receipted');
    }
    if (row.attemptState !== 'attempted' && row.attemptState !== 'uncertain') {
      throw new ApprovalStoreError('conflict', 'projection receipt mismatch');
    }
    row.eventId = eventId; this._save(); return { event_id: row.eventId };
  }

  retryProjection(planToken, input = {}) {
    const row = this._planRow(planToken, input);
    if (row.eventId) throw new ApprovalStoreError('conflict', 'projection already receipted');
    const requested = Number(input.retry_at); const now = this.now();
    row.attemptState = 'uncertain';
    row.nextAttemptAt = Number.isFinite(requested)
      ? Math.min(Math.max(now, requested), now + MAX_RETRY_DELAY_MS)
      : now;
    row.lastErrorCode = optionalText(input.error_code, 128); this._save();
    return { attempt_state: row.attemptState, retry_at: row.nextAttemptAt };
  }

  listAudit() {
    return this.state.audit.map((entry) => ({ ...entry }));
  }
}

export function createApprovalStore(filePath, options = {}) {
  return new ApprovalStore(filePath, options);
}
