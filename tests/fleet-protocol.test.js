import { describe, expect, test, vi } from 'vitest';
import { createFleetProtocol, FLEET_PROBE_EVENT, FLEET_REQUEST_EVENT, fleetRequestContext } from '../lib/fleet-protocol.js';
import { createAppserviceRouter } from '../lib/appservice-receiver.js';
import { engagementApprovalContent } from '../lib/engagement-notice.js';

const fleetId = `hf_${'a'.repeat(32)}`;
const sideId = 'palpo.test';
const registration = 'palpo.test@generation1';
const representative = `@${fleetId}_representative:${sideId}`;
const requester = `@owner:${sideId}`;
const bot = `@privatebot:${sideId}`;
const reception = `!reception:${sideId}`;
const target = `!project:${sideId}`;
const dm = `!owner:${sideId}`;
const probe = { fleetId, sourceRoomId: reception, sourceEventId: '$probe', challenge: 'challenge_123456789' };
const context = { v: 1, fleetId, requestId: 'request_1', requesterMxid: requester, sourceRoomId: reception,
  sourceEventId: '$request', targetProjectId: 'project_1', targetRoomId: target, ownerMxid: requester,
  ownerDmRoomId: dm, role: 'coding', requestedTokens: 100000, ratePerDay: 20000, authVersion: 1 };

function fixture() {
  const side = { serverName: sideId, registration, representativeMxid: representative,
    senderLocalpart: `${fleetId}_representative` };
  const event = { type: FLEET_REQUEST_EVENT, event_id: '$request', sender: requester,
    content: Object.fromEntries(Object.entries(context).filter(([key]) => !['sourceEventId', 'ownerDmRoomId'].includes(key))) };
  const probeEvent = { type: FLEET_PROBE_EVENT, event_id: '$probe', room_id: reception, sender: representative,
    content: { fleetId, challenge: probe.challenge } };
  const roomMembers = { [reception]: { [requester]: {}, [representative]: {} },
    [target]: { [requester]: {}, [representative]: {} }, [dm]: { [requester]: {}, [bot]: {} } };
  const power = { users: { [requester]: 100, [representative]: 50 }, invite: 50 };
  const targetBinding = { v: 1, fleetId, purpose: 'project', projectId: 'project_1', ownerMxid: requester, authVersion: 1 };
  const backend = vi.fn(async input => ({ ok: true, fleetId, requestId: input.context?.requestId, state: 'pending' }));
  let persisted = {};
  const readRoom = vi.fn(async (_side, roomId, suffix, options) => {
    if (suffix.startsWith('event/')) return suffix.includes('%24probe') ? probeEvent : event;
    if (suffix === 'joined_members') {
      if (roomId === dm) expect(options.privateOwner).toBe(true);
      return { joined: roomMembers[roomId] ?? {} };
    }
    if (suffix === 'state/m.room.join_rules/') return { join_rule: 'invite' };
    if (suffix === 'state/m.room.encryption/') return roomId === dm ? { algorithm: 'm.megolm.v1.aes-sha2' } : null;
    if (suffix === 'state/m.room.power_levels/') return power;
    if (suffix.startsWith('state/com.hafleet.admin.binding.v1/')) return targetBinding;
    throw new Error(`Unexpected Matrix operation: ${suffix}`);
  });
  const make = () => createFleetProtocol({ load: () => persisted, save: next => { persisted = structuredClone(next); },
    sideFor: id => id === sideId ? side : null, readRoom, backend, approvalBotMxid: () => bot });
  const protocol = make();
  const call = (path, body, method = 'POST', current = protocol) => current.handle({ sideId, registration,
    method, path: `/api/fleet/v1/${path}`, body });
  const record = (mode = 'push') => protocol.recordEvent({ sideId, registration, event: probeEvent, mode });
  const ready = async () => { await record(); expect((await call('probe', probe)).status).toBe(200); };
  return { protocol, call, ready, record, make, event, probeEvent, roomMembers, power, targetBinding, backend, readRoom, side };
}

describe('fleet protocol authorization', () => {
  test('fleet source verification binds the project Agent definition', async () => {
    const f = fixture(); await f.ready();
    const agentDefinition = { name: 'fast-one', resourceId: `resource_${'a'.repeat(24)}` };
    f.event.content.agentDefinition = agentDefinition;
    for (const changed of [{ name: 'fast-two', resourceId: agentDefinition.resourceId },
      { name: agentDefinition.name, resourceId: `resource_${'b'.repeat(24)}` }]) {
      expect((await f.call('requests', { ...context, agentDefinition: changed })).body.code).toBe('source_mismatch');
    }
    expect((await f.call('requests', context)).body.code).toBe('source_mismatch');
    expect((await f.call('requests', { ...context, agentDefinition: { ...agentDefinition, sandbox: 'unrestricted' } })).status).toBe(400);
    expect(f.backend).not.toHaveBeenCalled();
    expect((await f.call('requests', { ...context, agentDefinition })).status).toBe(200);
    expect(f.backend.mock.calls[0][0].context.agentDefinition).toEqual(agentDefinition);
  });
  test('fleet probe requires exact durable push receipt and never dispatches a task', async () => {
    const f = fixture();
    expect((await f.call('probe', probe)).body.code).toBe('probe_pending');
    await f.record('sync');
    expect((await f.call('probe', probe)).status).toBe(409);
    await f.record('push');
    expect((await f.call('probe', { ...probe, challenge: 'another_challenge_123' })).status).toBe(409);
    const received = await f.call('probe', probe, 'POST', f.make());
    expect(received).toMatchObject({ status: 200, body: { received: true, ...probe, mode: 'push' } });
    expect(f.backend).not.toHaveBeenCalled();
    expect(await f.protocol.recordEvent({ sideId, registration, event: f.event, mode: 'push' })).toBe(true);
    expect(f.backend).not.toHaveBeenCalled();
    f.side.registration = 'generation2';
    expect((await f.call('probe', probe)).status).toBe(403);
  });

  test('verified request forwards only the exact Matrix authorization context', async () => {
    const f = fixture();
    await f.ready();
    const result = await f.call('requests', context);
    expect(result).toMatchObject({ status: 200, body: { state: 'pending' } });
    expect(f.backend).toHaveBeenCalledWith({ action: 'request', sideId, registration, context: fleetRequestContext(context) });
  });

  test('fleet requests reject source target owner and cross-fleet tampering', async () => {
    const mutations = [
      f => { f.event.sender = '@owner:another.test'; },
      f => { delete f.roomMembers[target][requester]; },
      f => { f.power.users[requester] = 49; },
      f => { f.power.users[representative] = 0; },
      f => { f.roomMembers[dm]['@outsider:palpo.test'] = {}; },
      f => { f.targetBinding.projectId = 'another_project'; },
      f => { f.targetBinding.authVersion = 2; },
      f => { delete f.roomMembers[reception][requester]; },
    ];
    for (const mutate of mutations) {
      const f = fixture(); await f.ready(); mutate(f);
      expect((await f.call('requests', context)).status).toBe(403);
      expect(f.backend).not.toHaveBeenCalled();
    }
    for (const change of [{ fleetId: `hf_${'b'.repeat(32)}` }, { targetRoomId: '!unauthorized:palpo.test' },
      { ownerMxid: '@stranger:palpo.test' }, { authVersion: 2 }, { sourceEventId: '$swapped' },
      { requesterMxid: '@owner:other.test' }, { requestedTokens: 100001 }]) {
      const f = fixture(); await f.ready();
      expect((await f.call('requests', { ...context, ...change })).status).toBeGreaterThanOrEqual(400);
      expect(f.backend).not.toHaveBeenCalled();
    }
  });

  test('fleet callback routes require their own appservice token and expose no generic proxy', async () => {
    const a = fixture(); const b = vi.fn(async () => ({ status: 200, body: { fleet: 'b' } }));
    const router = createAppserviceRouter({ logger: {}, sides: [
      { sideId, hsToken: 'token-a', onEvents: async () => {},
        onFleetRequest: request => a.protocol.handle({ ...request, sideId, registration }) },
      { sideId: 'another.test', hsToken: 'token-b', onEvents: async () => {}, onFleetRequest: b },
    ] });
    const request = { method: 'POST', path: '/api/fleet/v1/requests', body: { ...context, fleetId: `hf_${'b'.repeat(32)}` } };
    expect((await router.handle(request)).status).toBe(403);
    expect((await router.handle({ ...request, headers: { authorization: 'Bearer operator-token' } })).status).toBe(403);
    expect((await router.handle({ ...request, headers: { authorization: 'Bearer token-a' } })).body.code).toBe('wrong_fleet');
    expect(b).not.toHaveBeenCalled();
    expect((await router.handle({ ...request, path: '/api/agents', headers: { authorization: 'Bearer token-a' } })).status).toBe(404);
    expect((await router.handle({ ...request, path: '/api/fleet/v1/operator', headers: { authorization: 'Bearer token-a' } })).status).toBe(404);
  });

  test('reception approval receipts name the target and contain no private owner data', () => {
    const content = engagementApprovalContent({ id: 'en_1', requestId: 'fleet-v1:opaque', requestContext: context,
      projectRoomId: target, role: 'coding', allocatedTokens: 100000 },
    { framework: 'codex', model: 'gpt-5.6-sol' }, `@${fleetId}_agent_one:palpo.test`);
    expect(content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: '$request' } });
    expect(content.body).toContain(target);
    expect(content.body).toContain('target project room');
    expect(JSON.stringify(content)).not.toContain(dm);
    expect(JSON.stringify(content)).not.toContain(requester);
    expect(content['m.mentions']).toEqual({ user_ids: [] });
  });
});
