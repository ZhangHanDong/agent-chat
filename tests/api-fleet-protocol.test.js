import { afterEach, expect, test, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';
import { derivedRegistrationId } from '../lib/project-side-inbound.js';
import { createEngagementStore } from '../lib/engagement-store.js';
import { fleetRequestContext } from '../lib/fleet-protocol.js';

const fleetId = `hf_${'a'.repeat(32)}`;
const SIDE = 'palpo.test';
const bridgeSecret = 'fixture-bridge-secret';
const hsToken = 'fixture-own-hs-token';
const registration = derivedRegistrationId(SIDE, hsToken);
const target = `!target:${SIDE}`;
const source = `!reception:${SIDE}`;
const owner = `@owner:${SIDE}`;
const context = { v: 1, fleetId, requestId: 'request_1', sourceEventId: '$source-event',
  sourceRoomId: source, targetRoomId: target, targetProjectId: 'project_1', requesterMxid: owner,
  ownerMxid: owner, ownerDmRoomId: `!private:${SIDE}`, authVersion: 1,
  role: 'coding', requestedTokens: 100000, ratePerDay: 20000 };
let ctx;
afterEach(async () => { vi.unstubAllGlobals(); await ctx?.cleanup(); ctx = null; });

async function boot({ emptyAgents = false } = {}) {
  ctx = await createBackendTestContext('fleet-protocol-', {
    agents: emptyAgents ? {} : { worker: { name: 'worker', kind: 'agent', type: 'claude', role: 'coding', projectSide: SIDE,
      presetId: 'fixture-resource', server: 'local', online: true, manualDown: false,
      matrixIdentity: { mxid: `@${fleetId}_agent_worker:${SIDE}` },
      runtimeProfile: { primary: { framework: 'claude', model: 'claude-opus-5' } } } },
    frameworkPresets: [{ id: 'fixture-resource', name: 'Resource', framework: 'claude', model: 'claude-opus-5',
      ceiling: { tokens: 1000000, period: 'monthly' } }],
    env: { MATRIX_BRIDGE_SECRET: bridgeSecret, MATRIX_AGENT_PREFIX: 'ac_',
      HAFLEET_THREAD_SESSIONS: '0', HAFLEET_ROUTER_TASK_CUTOVER: '0' },
    rawDataFiles: { 'project-sides.json': JSON.stringify({ version: 1, audit: [], sides: {
      [SIDE]: { id: SIDE, serverName: SIDE, apiBaseUrl: 'http://127.0.0.1:1', label: 'Fixture',
        active: true, createdAt: 1, updatedAt: 1, projects: {}, allocatedTokens: 500000,
        representative: { mxid: `@${fleetId}_representative:${SIDE}` },
        credential: { kind: 'appservice', asToken: 'fixture-as-token', hsToken,
          senderLocalpart: `${fleetId}_representative`, namespace: `^@${fleetId}_[a-z0-9_]+:palpo\\.test$` } },
    } }) },
  });
  await request(ctx.app).post('/api/whitelist').send({ projectRoomId: source }).expect(200);
  await request(ctx.app).post('/api/whitelist').send({ projectRoomId: target }).expect(200);
  await request(ctx.app).put('/api/offers/coding').send({ published: true, count: 4,
    budgetCapPerEngagement: 200000, rateCap: 30000 }).expect(200);
  return body => request(ctx.app).post('/api/fleet-control').set('X-Bridge-Secret', bridgeSecret)
    .send({ sideId: SIDE, registration, ...body });
}

test('verified reception request remains pending and its context survives replay', async () => {
  const call = await boot();
  const created = await call({ action: 'request', context }).expect(200);
  expect(created.body).toMatchObject({ ok: true, fleetId, requestId: 'request_1', state: 'pending',
    targetRoomId: target, sourceRoomId: source, allocatedTokens: null, ready: false });
  expect(JSON.stringify(created.body)).not.toContain(context.ownerDmRoomId);
  expect(JSON.stringify(created.body)).not.toContain('fixture-as-token');
  const rows = (await request(ctx.app).get('/api/engagements').expect(200)).body.engagements;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ route: 'notWhitelisted', state: 'pending', requestContext: fleetRequestContext(context) });
  const replay = await call({ action: 'request', context }).expect(200);
  expect(replay.body.engagementId).toBe(created.body.engagementId);
  const persisted = JSON.parse(readFileSync(path.join(ctx.runtimeDir, 'data', 'engagements.json'), 'utf8'));
  const reloaded = createEngagementStore({ load: () => persisted });
  expect(reloaded.get(created.body.engagementId).requestContext).toEqual(fleetRequestContext(context));
  const status = await call({ action: 'status', requestId: context.requestId }).expect(200);
  expect(status.body).toEqual(created.body);
  const capabilities = await call({ action: 'capabilities' }).expect(200);
  expect(capabilities.body.offers).toContainEqual(expect.objectContaining({ role: 'coding', published: true }));
});

test('fleet backend rejects forged generation cross-fleet requests and conflicting source replays', async () => {
  const call = await boot();
  await request(ctx.app).post('/api/fleet-control').send({ action: 'request', context, sideId: SIDE, registration }).expect(403);
  expect((await call({ action: 'request', context, registration: 'stale-generation' })).body).toMatchObject({ ok: false, status: 403 });
  expect((await call({ action: 'request', context: { ...context, fleetId: `hf_${'b'.repeat(32)}` } })).body).toMatchObject({ ok: false, status: 403 });
  const created = await call({ action: 'request', context }).expect(200);
  const conflict = await call({ action: 'request', context: { ...context, sourceEventId: '$another-source' } });
  expect(conflict.body.status).toBe(409);
  expect(conflict.body.code).toBe('conflict');
  const rows = (await request(ctx.app).get('/api/engagements').expect(200)).body.engagements;
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(created.body.engagementId);
  expect(rows[0].allocatedTokens).toBeNull();
});

test('fleet approval rechecks current target authority before allocating', async () => {
  const call = await boot();
  const created = await call({ action: 'request', context }).expect(200);
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(input);
    expect(url.pathname).toContain(encodeURIComponent(target));
    let value;
    if (url.pathname.endsWith('/joined_members')) value = { joined: { [owner]: {}, [`@${fleetId}_representative:${SIDE}`]: {} } };
    else if (url.pathname.endsWith('/m.room.power_levels/')) value = { users: { [owner]: 0 } };
    else if (url.pathname.endsWith('/m.room.join_rules/')) value = { join_rule: 'invite' };
    else if (url.pathname.endsWith('/m.room.encryption/')) return { ok: false, status: 404 };
    else value = { v: 1, fleetId, purpose: 'project', projectId: context.targetProjectId, ownerMxid: owner, authVersion: 1 };
    return { ok: true, status: 200, json: async () => value };
  }));
  const verdict = await request(ctx.app).post(`/api/engagements/${created.body.engagementId}/verdict`)
    .send({ approve: true, allocatedTokens: 100000, owner: { ownerMxid: owner, ownerDmRoomId: context.ownerDmRoomId } });
  expect(verdict.status).toBe(409);
  expect(verdict.body).toMatchObject({ code: 'owner_unavailable', engagement: { state: 'pending', allocatedTokens: null } });
});

test('approved fleet engagement admits the target and queues its result only in reception', async () => {
  const call = await boot();
  const created = await call({ action: 'request', context }).expect(200);
  const rep = `@${fleetId}_representative:${SIDE}`;
  const agent = `@${fleetId}_agent_worker:${SIDE}`;
  const writes = [];
  vi.stubGlobal('fetch', vi.fn(async (input, options) => {
    const url = new URL(input);
    let value;
    if (options.method === 'POST') {
      writes.push({ path: url.pathname, user: url.searchParams.get('user_id'), body: JSON.parse(options.body) });
      value = { room_id: target };
    } else if (url.pathname.endsWith('/joined_members')) value = { joined: { [owner]: {}, [rep]: {} } };
    else if (url.pathname.endsWith('/m.room.power_levels/')) value = { invite: 0, users: { [owner]: 100 } };
    else if (url.pathname.endsWith('/m.room.join_rules/')) value = { join_rule: 'invite' };
    else if (url.pathname.endsWith('/m.room.encryption/')) return { ok: false, status: 404 };
    else value = { v: 1, fleetId, purpose: 'project', projectId: context.targetProjectId, ownerMxid: owner, authVersion: 1 };
    return { ok: true, status: 200, json: async () => value };
  }));
  const verdict = await request(ctx.app).post(`/api/engagements/${created.body.engagementId}/verdict`)
    .send({ approve: true, allocatedTokens: 100000, owner: { ownerMxid: owner, ownerDmRoomId: context.ownerDmRoomId } }).expect(200);
  expect(verdict.body).toMatchObject({ engagement: { state: 'active', bound: true }, roomAdmission: { admitted: true } });
  expect(writes).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: `/_matrix/client/v3/rooms/${encodeURIComponent(target)}/invite`, user: rep, body: { user_id: agent } }),
    expect.objectContaining({ path: `/_matrix/client/v3/join/${encodeURIComponent(target)}`, user: agent }),
  ]));
  const claimed = await request(ctx.app).post('/api/matrix-work/claim').set('X-Bridge-Secret', bridgeSecret).send({}).expect(200);
  expect(claimed.body.job).toMatchObject({ action: 'engagement-approved', roomId: source,
    engagementId: created.body.engagementId, content: { 'm.relates_to': { 'm.in_reply_to': { event_id: context.sourceEventId } } } });
  expect(claimed.body.job.content.body).toContain(target);
  expect(JSON.stringify(claimed.body.job.content)).not.toContain(context.ownerDmRoomId);
});

test('default prefix backend mints and admits the imported fleet identity', async () => {
  const call = await boot({ emptyAgents: true });
  const launches = [];
  ctx.internals.setEngagementLauncherForTest(async row => { launches.push(row.name); });
  const created = await call({ action: 'request', context }).expect(200);
  expect(created.body.agentMxid).toBeNull();
  const rep = `@${fleetId}_representative:${SIDE}`;
  const writes = [];
  const identities = [];
  vi.stubGlobal('fetch', vi.fn(async (input, options) => {
    const url = new URL(input);
    let value;
    if (url.pathname.endsWith('/whoami')) {
      const mxid = url.searchParams.get('user_id');
      identities.push(mxid);
      value = { user_id: mxid };
    } else if (options.method === 'POST') {
      writes.push({ path: url.pathname, user: url.searchParams.get('user_id'), body: JSON.parse(options.body) });
      value = { room_id: target };
    } else if (url.pathname.endsWith('/joined_members')) value = { joined: { [owner]: {}, [rep]: {} } };
    else if (url.pathname.endsWith('/m.room.power_levels/')) value = { invite: 0, users: { [owner]: 100 } };
    else if (url.pathname.endsWith('/m.room.join_rules/')) value = { join_rule: 'invite' };
    else if (url.pathname.endsWith('/m.room.encryption/')) return { ok: false, status: 404 };
    else value = { v: 1, fleetId, purpose: 'project', projectId: context.targetProjectId, ownerMxid: owner, authVersion: 1 };
    return { ok: true, status: 200, json: async () => value };
  }));
  const verdict = await request(ctx.app).post(`/api/engagements/${created.body.engagementId}/verdict`)
    .send({ approve: true, allocatedTokens: 100000, owner: { ownerMxid: owner, ownerDmRoomId: context.ownerDmRoomId } });
  expect(verdict.status, JSON.stringify(verdict.body)).toBe(200);
  expect(verdict.body).toMatchObject({ engagement: { state: 'active', bound: true }, roomAdmission: { admitted: true } });
  const name = verdict.body.engagement.agent;
  const mxid = `@${fleetId}_agent_${name}:${SIDE}`;
  expect(launches).toEqual([name]);
  expect(identities).toContain(mxid);
  expect(identities.some(identity => identity?.startsWith('@ac_'))).toBe(false);
  expect(writes).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: `/_matrix/client/v3/rooms/${encodeURIComponent(target)}/invite`, user: rep, body: { user_id: mxid } }),
    expect.objectContaining({ path: `/_matrix/client/v3/join/${encodeURIComponent(target)}`, user: mxid }),
  ]));
  const status = await call({ action: 'status', requestId: context.requestId }).expect(200);
  expect(status.body).toMatchObject({ agentMxid: mxid, bound: true, state: 'active' });
});
