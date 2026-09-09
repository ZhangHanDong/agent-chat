import { normalizeProjectAgentDefinition } from './project-agent-definition.js';

export const FLEET_PROBE_EVENT = 'com.hafleet.connection.probe.v1';
export const FLEET_REQUEST_EVENT = 'com.hafleet.engagement.request.v1';
const FIELDS = ['v', 'fleetId', 'requestId', 'requesterMxid', 'sourceRoomId', 'targetProjectId',
  'targetRoomId', 'ownerMxid', 'ownerDmRoomId', 'role', 'requestedTokens', 'ratePerDay', 'authVersion'];
const fullMxid = value => typeof value === 'string' && /^@[^:\s]+:[^\s]+$/.test(value);
const room = value => typeof value === 'string' && /^![^:\s]+:[^\s]+$/.test(value);
const serverOf = value => String(value).slice(String(value).indexOf(':') + 1).toLowerCase();
const fail = (code, message, status = 403) => { throw Object.assign(new Error(message), { code, status }); };

export function fleetIdForSender(senderLocalpart) {
  return /^(hf_[a-f0-9]{32})_representative$/.exec(senderLocalpart ?? '')?.[1] ?? null;
}

export function normalizeFleetRequest(input, { privateOwner = true } = {}) {
  const value = Object.fromEntries(FIELDS.filter(key => privateOwner || key !== 'ownerDmRoomId')
    .map(key => [key, input?.[key] ?? (key === 'ratePerDay' ? null : undefined)]));
  if (value.v !== 1 || value.authVersion !== 1 || !/^hf_[a-f0-9]{32}$/.test(value.fleetId ?? '')
    || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(value.requestId)
    || typeof value.targetProjectId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.targetProjectId)
    || !fullMxid(value.requesterMxid) || !fullMxid(value.ownerMxid)
    || !room(value.sourceRoomId) || !room(value.targetRoomId)
    || value.sourceRoomId === value.targetRoomId || privateOwner && (!room(value.ownerDmRoomId)
      || value.ownerDmRoomId === value.targetRoomId || value.ownerDmRoomId === value.sourceRoomId)
    || typeof value.role !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.role)
    || !Number.isSafeInteger(value.requestedTokens) || value.requestedTokens <= 0
    || value.ratePerDay !== null && (!Number.isSafeInteger(value.ratePerDay) || value.ratePerDay <= 0)) {
    fail('invalid_request', 'Invalid versioned fleet request.', 400);
  }
  // Omit the optional extension entirely for legacy request fingerprints.
  if (input?.agentDefinition !== undefined) value.agentDefinition = normalizeProjectAgentDefinition(input.agentDefinition);
  return value;
}

export function fleetRequestContext(input) {
  const value = normalizeFleetRequest(input);
  if (typeof input.sourceEventId !== 'string' || !/^\$\S{1,254}$/.test(input.sourceEventId)) {
    fail('invalid_request', 'A full source Matrix event ID is required.', 400);
  }
  return { ...value, sourceEventId: input.sourceEventId };
}

export function fleetRequestKey(context) {
  return `fleet-v1:${context.fleetId}:${context.requestId}`;
}

export async function verifyFleetTarget(context, side, readRoom) {
  const [membership, powers, binding, rules, encryption] = await Promise.all([
    readRoom(side, context.targetRoomId, 'joined_members'),
    readRoom(side, context.targetRoomId, 'state/m.room.power_levels/'),
    readRoom(side, context.targetRoomId, `state/com.hafleet.admin.binding.v1/${encodeURIComponent(side.fleetId)}`),
    readRoom(side, context.targetRoomId, 'state/m.room.join_rules/'),
    readRoom(side, context.targetRoomId, 'state/m.room.encryption/', { optional: true }),
  ]);
  if (binding.v !== 1 || binding.fleetId !== side.fleetId || binding.purpose !== 'project'
    || binding.projectId !== context.targetProjectId || binding.ownerMxid !== context.ownerMxid
    || binding.authVersion !== context.authVersion) fail('target_binding_mismatch', 'The registered project does not match this request.');
  const members = membership.joined ?? {};
  const power = mxid => powers?.users?.[mxid] ?? powers?.users_default ?? 0;
  if (rules.join_rule !== 'invite' || encryption?.algorithm
    || !members[context.requesterMxid] || !members[context.ownerMxid] || !members[side.representativeMxid]
    || power(context.requesterMxid) < (powers.invite ?? 0) || power(context.ownerMxid) < 100
    || power(side.representativeMxid) < (powers.invite ?? 0)
    || context.ownerMxid === side.representativeMxid || context.ownerMxid.startsWith(`@${side.fleetId}_`)) {
    fail('target_unauthorized', 'Requester, project owner or representative lacks target project authority.');
  }
}

/** Narrow callback protocol. Matrix and local backend adapters are injected; tests
 * never need network or real credentials. save() must durably commit or throw. */
export function createFleetProtocol({ load = () => ({}), save, sideFor, readRoom, backend, approvalBotMxid }) {
  let state = structuredClone(load() ?? {});
  function commit(next) {
    if (save(next) === false) fail('persistence_failed', 'Connection evidence could not be saved.', 503);
    state = next;
  }
  function authority(sideId, registration) {
    const side = sideFor(sideId);
    const fleetId = fleetIdForSender(side?.senderLocalpart);
    if (!side || !fleetId || !registration || side.registration !== registration) {
      fail('fleet_unavailable', 'Fleet registration is unavailable.');
    }
    return { ...side, fleetId };
  }
  function sameSide(side, ...ids) {
    if (ids.some(id => serverOf(id) !== side.serverName.toLowerCase())) fail('wrong_server', 'Matrix authority belongs to another server.');
  }
  async function plaintextPrivate(side, roomId) {
    const [members, rules, encryption] = await Promise.all([
      readRoom(side, roomId, 'joined_members'), readRoom(side, roomId, 'state/m.room.join_rules/'),
      readRoom(side, roomId, 'state/m.room.encryption/', { optional: true }),
    ]);
    if (rules?.join_rule !== 'invite' || encryption?.algorithm) fail('room_policy', 'Reception and project rooms must be invite-only and unencrypted.');
    return members.joined ?? {};
  }
  return {
    async recordEvent({ sideId, registration, event, mode }) {
      if (![FLEET_PROBE_EVENT, FLEET_REQUEST_EVENT].includes(event?.type)) return false;
      // Custom protocol events are consumed here, never as chat or task input.
      const configuredOutbound = sideFor(sideId)?.credential?.transport?.mode === 'outbound';
      if (event.type !== FLEET_PROBE_EVENT || !(configuredOutbound ? mode === 'edge' : mode === 'push')) return true;
      if (!fleetIdForSender(sideFor(sideId)?.senderLocalpart)) return true;
      const side = authority(sideId, registration);
      if (event.sender !== side.representativeMxid || event.content?.fleetId !== side.fleetId
        || !room(event.room_id) || typeof event.event_id !== 'string'
        || !/^\$\S+$/.test(event.event_id) || typeof event.content?.challenge !== 'string'
        || !/^[a-zA-Z0-9_-]{16,128}$/.test(event.content.challenge)) return true;
      sameSide(side, event.room_id);
      const next = structuredClone(state);
      const record = next[side.fleetId] ??= { registration, receipts: {} };
      if (record.registration !== registration) { record.registration = registration; record.receipts = {}; delete record.receptionRoomId; }
      record.receipts[event.event_id] = { sourceRoomId: event.room_id, sourceEventId: event.event_id,
        challenge: event.content.challenge, receivedAt: Date.now(), mode,
        ...(configuredOutbound ? { generation: side.credential.transport.generation } : {}) };
      const ids = Object.keys(record.receipts);
      for (const id of ids.slice(0, Math.max(0, ids.length - 100))) delete record.receipts[id];
      commit(next);
      return true;
    },
    async handle({ sideId, registration, method, path, body = {}, generation }) {
      try {
        const side = authority(sideId, registration);
        const transportGeneration = side.credential?.transport?.generation;
        if (transportGeneration !== undefined && generation !== transportGeneration) fail('fleet_unavailable', 'Fleet transport generation is unavailable.');
        if (method === 'GET' && path === '/api/fleet/v1/capabilities') {
          const result = await backend({ action: 'capabilities', sideId, registration, ...(transportGeneration ? { transportGeneration } : {}) });
          return { status: 200, body: { ...result, v: 1, fleetId: side.fleetId,
            serverName: side.serverName, representativeMxid: side.representativeMxid,
            approvalBotMxid: approvalBotMxid() ?? null } };
        }
        if (method === 'POST' && path === '/api/fleet/v1/probe') {
          if (body.fleetId !== side.fleetId) fail('wrong_fleet', 'Fleet scope does not match.');
          const receipt = state[side.fleetId]?.registration === registration
            && state[side.fleetId]?.receipts?.[body.sourceEventId];
          if (!receipt || receipt.challenge !== body.challenge || receipt.sourceRoomId !== body.sourceRoomId
            || transportGeneration && receipt.generation !== transportGeneration) {
            fail('probe_pending', 'The matching authenticated Palpo delivery has not been received.', 409);
          }
          const event = await readRoom(side, receipt.sourceRoomId, `event/${encodeURIComponent(receipt.sourceEventId)}`);
          if (event.type !== FLEET_PROBE_EVENT || event.sender !== side.representativeMxid
            || event.content?.fleetId !== side.fleetId || event.content?.challenge !== receipt.challenge
            || event.event_id !== receipt.sourceEventId) fail('probe_mismatch', 'Probe event does not match the delivery receipt.');
          const members = await plaintextPrivate(side, receipt.sourceRoomId);
          if (!members[side.representativeMxid]) fail('representative_absent', 'The representative has not joined the reception.');
          const oldReception = state[side.fleetId].receptionRoomId;
          if (oldReception && oldReception !== receipt.sourceRoomId) fail('reception_conflict', 'This registration is already bound to another reception.', 409);
          const next = structuredClone(state);
          next[side.fleetId].receptionRoomId = receipt.sourceRoomId;
          if (transportGeneration) next[side.fleetId].receptionGeneration = transportGeneration;
          commit(next);
          return { status: 200, body: { v: 1, received: true, fleetId: side.fleetId, ...receipt } };
        }
        if (method === 'POST' && path === '/api/fleet/v1/requests') {
          const context = fleetRequestContext(body);
          if (context.fleetId !== side.fleetId) fail('wrong_fleet', 'Fleet scope does not match.');
          sameSide(side, context.sourceRoomId, context.targetRoomId, context.ownerDmRoomId, context.ownerMxid, context.requesterMxid);
          if (state[side.fleetId]?.registration !== registration
            || state[side.fleetId]?.receptionRoomId !== context.sourceRoomId
            || transportGeneration && state[side.fleetId]?.receptionGeneration !== transportGeneration) fail('reception_unverified', 'Verify this fleet reception before requesting an agent.');
          const event = await readRoom(side, context.sourceRoomId, `event/${encodeURIComponent(context.sourceEventId)}`);
          if (event.type !== FLEET_REQUEST_EVENT || event.event_id !== context.sourceEventId
            || event.sender !== context.requesterMxid
            || JSON.stringify(normalizeFleetRequest(event.content, { privateOwner: false })) !== JSON.stringify(normalizeFleetRequest(context, { privateOwner: false }))) {
            fail('source_mismatch', 'Request content does not match its authenticated Matrix source event.');
          }
          const [sourceMembers] = await Promise.all([
            plaintextPrivate(side, context.sourceRoomId), verifyFleetTarget(context, side, readRoom),
          ]);
          if (!sourceMembers[context.requesterMxid] || !sourceMembers[side.representativeMxid]) fail('source_unauthorized', 'Requester and representative must remain joined in the reception.');
          const bot = approvalBotMxid();
          if (!fullMxid(bot) || context.ownerMxid === bot) fail('owner_unavailable', 'The private approval bot is unavailable.', 409);
          const [dmMembers, dmRules, dmEncryption] = await Promise.all([
            readRoom(side, context.ownerDmRoomId, 'joined_members', { privateOwner: true }),
            readRoom(side, context.ownerDmRoomId, 'state/m.room.join_rules/', { privateOwner: true }),
            readRoom(side, context.ownerDmRoomId, 'state/m.room.encryption/', { privateOwner: true }),
          ]);
          const joined = Object.keys(dmMembers.joined ?? {}).sort();
          if (JSON.stringify(joined) !== JSON.stringify([bot, context.ownerMxid].sort())
            || dmRules.join_rule !== 'invite' || dmEncryption.algorithm !== 'm.megolm.v1.aes-sha2') {
            fail('private_owner_required', 'The approval room must be encrypted, invite-only, and contain only the owner and approval bot.');
          }
          const result = await backend({ action: 'request', sideId, registration, context, ...(transportGeneration ? { transportGeneration } : {}) });
          return { status: 200, body: result };
        }
        const match = /^\/api\/fleet\/v1\/requests\/([a-zA-Z0-9_-]{1,96})$/.exec(path ?? '');
        if (method === 'GET' && match) {
          const result = await backend({ action: 'status', sideId, registration, requestId: match[1], ...(transportGeneration ? { transportGeneration } : {}) });
          let ready = false;
          if (result.state === 'active' && result.bound && fullMxid(result.agentMxid)) {
            const membership = await readRoom(side, result.targetRoomId, 'joined_members');
            ready = Boolean(membership.joined?.[result.agentMxid]);
          }
          return { status: 200, body: { ...result, ready } };
        }
        return { status: 404, body: { code: 'not_found', error: 'Unknown fleet protocol endpoint.' } };
      } catch (error) {
        return { status: error.status ?? 503, body: { ok: false, code: error.code ?? 'fleet_unavailable',
          error: error.status ? error.message : 'Fleet operation is unavailable; retry after connectivity recovers.' } };
      }
    },
  };
}
