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
import { deriveExecutionAuthorization, SCOPED_APPROVAL_ACTIONS } from './execution-authorization.js';

const STORE_VERSION = 1;
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
    ...(input.authorization ? { authorization: input.authorization, binding_authority: input.bindingAuthority } : {}),
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
    input_digest: record.inputDigest,
    status: record.status,
    decision: record.decision || null,
    decision_event_id: record.decisionEventId || (record.decision ? stableDecisionEventId(record) : null),
    denial_reason: record.denialReason || null,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    decided_at: record.decidedAt || null,
    consumed_at: record.consumedAt || null,
    ...(record.authorizationAction ? { authorization_action: record.authorizationAction } : {}),
    ...(record.grantId ? { grant_id: record.grantId } : {}),
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
    ...(record.authorization ? { reusable_scope: {
      description: record.authorization.scope.description,
      workspace: record.authorization.workspace,
      task_id: record.authorization.taskId,
    } } : {}),
  };
}

export class ApprovalStore {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
      ? Math.floor(options.ttlMs)
      : DEFAULT_TTL_MS;
    this.auditLimit = Number.isFinite(options.auditLimit) && options.auditLimit > 0
      ? Math.floor(options.auditLimit)
      : DEFAULT_AUDIT_LIMIT;
    this.isTaskActive = typeof options.isTaskActive === 'function' ? options.isTaskActive : () => false;
    this.getTaskEpoch = typeof options.getTaskEpoch === 'function' ? options.getTaskEpoch : () => 0;
    this.isAgentCurrent = typeof options.isAgentCurrent === 'function' ? options.isAgentCurrent : () => true;
    this.state = this._load();
  }

  _load() {
    if (!existsSync(this.filePath)) {
      return { version: STORE_VERSION, bindings: {}, requests: {}, grants: {}, audit: [] };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return {
        version: STORE_VERSION,
        bindings: parsed?.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {},
        requests: parsed?.requests && typeof parsed.requests === 'object' ? parsed.requests : {},
        grants: parsed?.grants && typeof parsed.grants === 'object' && !Array.isArray(parsed.grants) ? parsed.grants : {},
        audit: Array.isArray(parsed?.audit) ? parsed.audit.slice(-this.auditLimit) : [],
      };
    } catch (error) {
      throw new ApprovalStoreError('persistence_failed', `failed to load approval store: ${error.message}`);
    }
  }

  _save() {
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const bytes = JSON.stringify(this.state, null, 2) + '\n';
    let fd = null;
    try {
      writeFileSync(tmp, bytes, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      fd = openSync(tmp, 'r');
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tmp, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
      throw new ApprovalStoreError('persistence_failed', `failed to persist approval store: ${error.message}`);
    }
  }

  _audit(type, detail = {}) {
    this.state.audit.push({ type, at: this.now(), ...detail });
    if (this.state.audit.length > this.auditLimit) {
      this.state.audit.splice(0, this.state.audit.length - this.auditLimit);
    }
  }

  _withRollback(change) {
    const previous = structuredClone(this.state);
    try { return change(); } catch (error) { this.state = previous; throw error; }
  }

  _bindingAuthority(binding) {
    return binding.authorityId || createHash('sha256').update(JSON.stringify([
      binding.agent, binding.project, binding.projectRoomId, binding.ownerMxid,
      binding.ownerDmRoomId, binding.createdAt,
    ])).digest('hex');
  }

  _bindingCurrent(record) {
    const binding = this.state.bindings[bindingKey(record.agent, record.projectRoomId)];
    return binding && binding.active !== false && binding.project === record.project
      && binding.ownerMxid === record.ownerMxid && binding.ownerDmRoomId === record.ownerDmRoomId
      && (!record.bindingAuthority || record.bindingAuthority === this._bindingAuthority(binding));
  }

  _grantCurrent(grant) {
    return grant && grant.revokedAt == null && this._bindingCurrent(grant)
      && this.isAgentCurrent(grant.agent, grant.agentId)
      && (grant.scope === 'always' || (grant.scope === 'task' && this.isTaskActive(grant.taskId)
        && grant.taskEpoch === this.getTaskEpoch(grant.taskId)));
  }

  listGrants(agent, agentId = null) {
    return Object.values(this.state.grants).filter(g => g.agent === agent && (!agentId || g.agentId === agentId))
      .map(g => ({ ...g, active: Boolean(this._grantCurrent(g)) }));
  }

  revokeGrant(id, agent, actor) {
    return this._withRollback(() => {
      const grant = this.state.grants[id];
      if (!grant || grant.agent !== agent) return null;
      if (grant.revokedAt == null) {
        grant.revokedAt = this.now(); grant.revokedBy = text(actor, 'actor', 255);
        this._audit('authorization.revoked', { grantId: id, agent, actor: grant.revokedBy });
        this._save();
      }
      return { ...grant, active: false };
    });
  }

  _expire(record, now = this.now()) {
    if (record?.status !== 'pending' || now < Number(record.expiresAt || 0)) return false;
    record.status = 'expired';
    record.decision = 'deny';
    record.denialReason = 'approval_expired';
    record.decidedAt = now;
    record.decisionEventId = stableDecisionEventId(record);
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
      authorityId: previous && !changedOwner && previous.project === project && previous.active !== false
        ? this._bindingAuthority(previous) : randomBytes(16).toString('hex'),
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
    return this._withRollback(() => this._createRequest(input, options));
  }

  _createRequest(input, options) {
    const now = this.now();
    const agent = text(input?.agent, 'agent', 128);
    const runtime = text(input?.runtime, 'runtime', 32).toLowerCase();
    if (runtime !== 'claude' && runtime !== 'codex') {
      throw new ApprovalStoreError('bad_request', 'runtime must be claude or codex');
    }
    const upstreamRequestId = text(input?.upstream_request_id ?? input?.upstreamRequestId, 'upstream_request_id', 255);
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
    record.bindingAuthority = this._bindingAuthority(binding);
    // The optional second argument is only supplied by the backend's owned
    // runner callback. Agent HTTP fields never reach this authority path.
    record.authorization = runtime === 'codex' ? deriveExecutionAuthorization(options.execution) : null;
    if (record.authorization?.taskId && !this.isTaskActive(record.authorization.taskId)) record.authorization.taskId = null;
    if (record.authorization?.taskId) {
      const epoch = this.getTaskEpoch(record.authorization.taskId);
      if (Number.isSafeInteger(epoch) && epoch >= 0) record.authorization.taskEpoch = epoch;
      else record.authorization.taskId = null;
    }
    if (record.authorization && !this.isAgentCurrent(agent, record.authorization.agentId)) record.authorization = null;
    record.inputDigest = digestRequest(record);
    this.state.requests[id] = record;
    this._audit('approval.created', {
      requestId: id,
      agent,
      project: record.project,
      projectRoomId: record.projectRoomId,
      ownerMxid: record.ownerMxid,
    });
    const context = record.authorization;
    const grant = context && Object.values(this.state.grants).find(g => this._grantCurrent(g)
      && g.agent === agent && g.agentId === context.agentId && g.projectRoomId === record.projectRoomId
      && g.project === record.project && g.bindingAuthority === record.bindingAuthority
      && g.scopeKey === context.scope.key && (g.scope === 'always' || g.taskId === context.taskId));
    if (grant) {
      record.status = 'approved'; record.decision = 'allow'; record.decidedAt = now;
      record.grantId = grant.id; record.authorizationAction = `approve_${grant.scope}`;
      record.decisionEventId = stableDecisionEventId(record);
      this._audit('authorization.matched', { requestId: id, grantId: grant.id, agent });
    }
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
    return this._withRollback(() => this._submitMatrixVerdict(id, input));
  }

  _submitMatrixVerdict(id, input) {
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
    const context = record.authorization;
    const reusable = context && this.isAgentCurrent(record.agent, context.agentId);
    const invalidAction = !SCOPED_APPROVAL_ACTIONS.includes(action)
      || (['approve_task', 'approve_always'].includes(action) && !reusable)
      || (action === 'approve_task' && (!context?.taskId || !this.isTaskActive(context.taskId)
        || context.taskEpoch !== this.getTaskEpoch(context.taskId)));
    if (mismatch || invalidAction || !this._bindingCurrent(record)) {
      const reason = mismatch ? `${mismatch}_mismatch` : invalidAction ? 'invalid_action' : 'owner_binding_changed';
      this._audit('approval.verdict_rejected', {
        requestId: normalizedId,
        reason,
        senderMxid: typeof actual.senderMxid === 'string' ? actual.senderMxid : null,
        roomId: typeof actual.roomId === 'string' ? actual.roomId : null,
      });
      this._save();
      return { ok: false, code: reason, record: publicRecord(record) };
    }

    record.status = action !== 'deny' ? 'approved' : 'denied';
    record.decision = action !== 'deny' ? 'allow' : 'deny';
    record.authorizationAction = action;
    record.denialReason = action === 'deny' ? 'owner_denied' : null;
    record.decidedAt = now;
    record.decisionEventId = stableDecisionEventId(record);
    record.matrixEventId = optionalText(input?.event_id ?? input?.eventId, 255) || null;
    if (action === 'approve_task' || action === 'approve_always') {
      const grant = {
        id: `grant_${randomBytes(16).toString('hex')}`, agent: record.agent, agentId: context.agentId,
        project: record.project, projectRoomId: record.projectRoomId, ownerMxid: record.ownerMxid,
        ownerDmRoomId: record.ownerDmRoomId, bindingAuthority: record.bindingAuthority,
        workspace: context.workspace, scope: action === 'approve_task' ? 'task' : 'always',
        taskId: action === 'approve_task' ? context.taskId : null,
        taskEpoch: action === 'approve_task' ? context.taskEpoch : null,
        scopeKey: context.scope.key, kind: context.scope.kind, description: context.scope.description,
        createdAt: now, sourceRequestId: record.id, sourceEventId: record.matrixEventId, revokedAt: null,
      };
      this.state.grants[grant.id] = grant; record.grantId = grant.id;
      this._audit('authorization.created', { grantId: grant.id, requestId: record.id, agent: record.agent, scope: grant.scope });
    }
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

    if (record.decision === 'allow' && (!this._bindingCurrent(record)
      || (record.authorization && !this.isAgentCurrent(record.agent, record.authorization.agentId))
      || (record.grantId && !this._grantCurrent(this.state.grants[record.grantId])))) {
      record.decision = 'deny'; record.denialReason = 'authorization_no_longer_valid';
      record.decisionEventId = null;
      this._audit('authorization.invalidated_before_consume', { requestId: id, agent: record.agent });
    }
    const decision = record.decision === 'allow' ? 'allow' : 'deny';
    record.decisionEventId = stableDecisionEventId(record);
    record.status = 'consumed';
    record.consumedAt = now;
    this._audit('approval.consumed', { requestId: id, agent: record.agent, decision });
    this._save();
    return { ok: true, code: 'consumed', decision, decision_event_id: record.decisionEventId, record: publicRecord(record) };
  }

  listAudit() {
    return this.state.audit.map((entry) => ({ ...entry }));
  }
}

export function createApprovalStore(filePath, options = {}) {
  return new ApprovalStore(filePath, options);
}
