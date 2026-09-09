import { afterEach, expect, test } from 'vitest';
import { createServer } from 'http';
import { existsSync, readFileSync, statSync } from 'fs';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const SIDE = 'palpo.test';
const ROOM = '!project:palpo.test';
const OWNER = '@private-owner:palpo.test';
const ownerEnv = { HAFLEET_OWNER_MXID: OWNER, HAFLEET_OWNER_DM_ROOM: '!private-dm:palpo.test' };
const preset = { id: 'p1', name: 'coding', framework: 'claude', model: 'claude-opus-5', ceiling: { tokens: 5000, period: 'monthly' } };
const agent = (name, side = SIDE, extra = {}) => ({ name, type: 'claude', server: 'local', online: true,
  projectSide: side, presetId: 'p1', runtimeProfile: { primary: { framework: 'claude', model: preset.model } }, ...extra });
let ctx;
let hs;
let bridgeTimer;
afterEach(async () => { clearInterval(bridgeTimer); hs?.releaseJoin(); await ctx?.cleanup(); ctx = null; if (hs) await new Promise((r) => hs.server.close(r)); hs = null; });

async function homeserver() {
  const calls = [];
  let leaveStatus = 200;
  let joinStatus = 200;
  let joinGate = null;
  let releaseJoin = () => {};
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const content = raw ? JSON.parse(raw) : {};
    calls.push({ path: url.pathname, user: url.searchParams.get('user_id'), auth: req.headers.authorization, body: content });
    if (url.pathname.includes('/join/') && joinGate) await joinGate;
    if (url.pathname.endsWith('/register')) {
      res.writeHead(content.auth ? 200 : 401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(content.auth ? { access_token: 'private-agent-token', user_id: `@${content.username}:${SIDE}` }
        : { session: 'uia-fixture', flows: [{ stages: ['m.login.registration_token'] }] }));
    }
    const status = url.pathname.endsWith('/leave') ? leaveStatus : url.pathname.includes('/join/') ? joinStatus : 200;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status !== 200 ? { errcode: 'M_UNAVAILABLE' }
      : url.pathname.endsWith('/whoami') ? { user_id: url.searchParams.get('user_id') }
        : url.pathname.includes('/join/') ? { room_id: ROOM }
          : url.pathname.includes('/send/m.room.message/') ? { event_id: '$fixture-notice' } : {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  hs = { server, calls, url: `http://127.0.0.1:${server.address().port}`,
    failLeave(value) { leaveStatus = value ? 503 : 200; }, failJoin(value) { joinStatus = value ? 503 : 200; },
    holdJoin() { joinGate = new Promise((r) => { releaseJoin = r; }); }, releaseJoin() { releaseJoin(); joinGate = null; } };
  return hs;
}

async function boot({ agents = { right: agent('right') }, env = ownerEnv, allocation = 5000, alerts = [], rawDataFiles = {} } = {}) {
  ctx = await createBackendTestContext('review-closure-', { agents, frameworkPresets: [preset], env, alerts, rawDataFiles });
  for (const side of [SIDE, 'other.test']) {
    await request(ctx.app).post('/api/project-sides').send({ server_name: side, api_base_url: hs?.url || 'http://127.0.0.1:1' }).expect(200);
    await request(ctx.app).put(`/api/project-sides/${side}/allocation`).send({ allocated_tokens: allocation }).expect(200);
  }
  if (env.HAFLEET_OWNER_MXID && env.HAFLEET_OWNER_DM_ROOM) ctx.internals.approvalStoreForTest.upsertBinding({
    agent: Object.keys(agents)[0] || 'room-bootstrap', project: 'review', project_room_id: ROOM,
    owner_mxid: env.HAFLEET_OWNER_MXID, owner_dm_room_id: env.HAFLEET_OWNER_DM_ROOM,
  });
  if (hs) await request(ctx.app).put(`/api/project-sides/${SIDE}/credential`).send({ credential: {
    kind: 'appservice', asToken: 'fixture-as', hsToken: 'fixture-hs', namespace: '@ac_.*', senderLocalpart: 'hafleet',
  } }).expect(200);
  return ctx.app;
}
const body = (extra = {}) => ({ project: 'review', projectRoomId: ROOM, requester: '@requester:palpo.test',
  role: 'coding', requestedTokens: 1000, requestId: '$request', ...extra });
const ask = (extra = {}) => request(ctx.app).post('/api/engagements').send(body(extra));
async function auto() {
  await request(ctx.app).post('/api/whitelist').send({ projectRoomId: ROOM }).expect(200);
  await request(ctx.app).put('/api/offers/coding').send({ published: true, count: 5, budgetCapPerEngagement: 5000 }).expect(200);
}

async function startBridgeWorker() {
  const bridgeUrl = new URL('../bridge-matrix.js', import.meta.url).href;
  const mod = await import(`${bridgeUrl}?review-work=${Date.now()}-${Math.random()}`);
  const bridge = new mod.MatrixBridge();
  bridge.callBackendApi = async (method, route, payload) => {
    const response = await request(ctx.app)[method.toLowerCase()](route).set('X-Bridge-Secret', 'bridge-fixture').send(payload);
    if (response.status !== 200) throw new Error(JSON.stringify(response.body));
    return response.body;
  };
  bridgeTimer = setInterval(() => bridge.pollMatrixWork(), 25);
  return mod;
}

test('engagement selection excludes foreign-side and retired agents', async () => {
  await boot({ agents: { foreign: agent('foreign', 'other.test'), retired: agent('retired', SIDE, { retiredAt: 1 }), right: agent('right') } });
  expect((await ask()).body.engagement.agent).toBe('right');
  for (const name of ['foreign', 'retired']) await ask({ requestId: `$${name}`, agent: name }).expect(400);
  await request(ctx.app).post(`/api/project-sides/${SIDE}/deactivate`).expect(200);
  const verdict = await request(ctx.app).post(`/api/engagements/${(await request(ctx.app).get('/api/engagements')).body.engagements[0].id}/verdict`).send({ approve: true });
  expect(verdict.status).toBe(409);
});

test('engagement admission preserves seat identity and unknown periods', async () => {
  await boot({ agents: Object.fromEntries(['one', 'two'].map((name) => [name, agent(name, SIDE, {
    runtimeProfile: { primary: { framework: 'claude', model: preset.model, apiKey: `private-${name}` } },
  })])) });
  const seats = (await request(ctx.app).get('/api/seats').expect(200)).body.seats;
  expect(seats).toHaveLength(2);
  expect(JSON.stringify(seats)).not.toMatch(/private-one|private-two|key:redacted/);
  for (const seat of seats) await request(ctx.app).put(`/api/seats/${seat.seatId}`).send({ quotaTokens: 5000, period: null }).expect(200);
  await auto();
  expect((await ask()).body.engagement).toMatchObject({ state: 'pending', autoJoined: false });
  for (const seat of seats) await request(ctx.app).put(`/api/seats/${seat.seatId}`).send({ quotaTokens: 0, period: 'monthly' }).expect(200);
  expect((await ask({ requestId: '$zero' })).body.engagement.state).toBe('pending');
});

test('missing engagement owner does not commit active success', async () => {
  await boot({ env: { HAFLEET_OWNER_MXID: '', HAFLEET_OWNER_DM_ROOM: '' } });
  const created = await ask();
  const res = await request(ctx.app).post(`/api/engagements/${created.body.engagement.id}/verdict`).send({ approve: true });
  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ ok: false, code: 'owner_unavailable', engagement: { state: 'pending', allocatedTokens: null } });
  await auto();
  expect((await ask({ requestId: '$auto-no-owner' })).status).toBe(409);
});

test('engagement replay succeeds after exhausting side allocation', async () => {
  await boot({ allocation: 1000 }); await auto();
  const first = await ask().expect(200);
  const replay = await ask().expect(200);
  expect(replay.body.engagement.id).toBe(first.body.engagement.id);
  expect(replay.body.engagement.state).toBe('active');
  await ask({ requestedTokens: 999 }).expect(409);
});

test('engagement replay canonicalizes padded room ids before its digest check', async () => {
  await boot();
  const first = await ask({ projectRoomId: ` ${ROOM} ` }).expect(200);
  const retry = await ask({ projectRoomId: ` ${ROOM} ` }).expect(200);
  expect(retry.body.engagement.id).toBe(first.body.engagement.id);
});

test('accepted engagement provisions a resource without a preexisting agent', async () => {
  await homeserver(); await boot({ agents: {} });
  const launches = [];
  ctx.internals.setEngagementLauncherForTest(async (row) => { launches.push(row.name); });
  const created = (await ask().expect(200)).body.engagement;
  expect(created.agent).toBeNull();
  const res = await request(ctx.app).post(`/api/engagements/${created.id}/verdict`).send({ approve: true }).expect(200);
  expect(res.body.engagement).toMatchObject({ state: 'active', fulfillment: { phase: 'complete', sideId: SIDE } });
  const name = res.body.engagement.agent;
  expect(name).toMatch(/^mx_palpo_test_coding_/);
  expect(launches).toEqual([name]);
  const roster = (await request(ctx.app).get(`/api/agents/${name}`).expect(200)).body;
  const row = roster.agent || roster;
  expect(row.projectSide).toBe(SIDE);
  expect(row.engagementProvisioningId).toBeUndefined();
  expect(existsSync(row.workdir)).toBe(true);
  expect(row.workdir.startsWith(ctx.runtimeDir)).toBe(true);
  expect(hs.calls.some((c) => c.path.endsWith('/whoami') && c.user === `@ac_${name}:${SIDE}`)).toBe(true);
  expect(hs.calls.some((c) => c.path.includes('/join/') && c.user === `@ac_${name}:${SIDE}`)).toBe(true);
  await request(ctx.app).post(`/api/engagements/${created.id}/verdict`).send({ approve: true }).expect(200);
  expect(launches).toHaveLength(1);
});

test('a new role request provisions a fresh agent after operator Stop without rewriting old admission', async () => {
  await homeserver();
  await boot({ agents: {}, env: { ...ownerEnv, HAFLEET_THREAD_SESSIONS: '1', HAFLEET_ROUTER_TASK_CUTOVER: '1' } });
  ctx.internals.stopRouterPumpForTest();
  const launches = [];
  ctx.internals.setEngagementLauncherForTest(async (row) => { launches.push(row.name); });
  await auto();
  const original = (await ask().expect(200)).body.engagement;
  expect(original).toMatchObject({ state: 'active', fulfillment: { phase: 'complete' } });
  const oldName = original.agent;
  const binding = ctx.internals.approvalStoreForTest.listBindings({ agent: oldName });
  expect(binding).toHaveLength(1);
  expect((await request(ctx.app).post(`/api/agents/${oldName}/stop`).expect(200)).body.stopped).toBe(true);

  const capability = (await request(ctx.app).get('/api/capability').expect(200)).body;
  expect(capability.roles.find((row) => row.role === 'coding')).toMatchObject({ able: [], fillable: 1 });
  const offers = (await request(ctx.app).get(`/api/offer-book?projectRoomId=${encodeURIComponent(ROOM)}`).expect(200)).body;
  expect(offers.roles.find((row) => row.role === 'coding').serving).toMatchObject({ agent: null, provisioningRequired: true });
  await ask({ requestId: '$stopped-hint', agent: oldName }).expect(400);

  const fresh = (await ask({ requestId: '$fresh-after-stop' }).expect(200)).body.engagement;
  expect(fresh).toMatchObject({ state: 'active', fulfillment: { phase: 'complete', presetId: 'p1' } });
  expect(fresh.agent).not.toBe(oldName);
  expect(launches).toEqual([oldName, fresh.agent]);
  const oldRow = (await request(ctx.app).get(`/api/agents/${oldName}`).expect(200)).body;
  const freshRow = (await request(ctx.app).get(`/api/agents/${fresh.agent}`).expect(200)).body;
  expect(oldRow).toMatchObject({ manualDown: true, offlineReason: 'operator-stopped' });
  expect(freshRow).toMatchObject({ manualDown: false, online: false, offlineReason: 'provisioned' });
  expect(freshRow.workdir).not.toBe(oldRow.workdir);
  expect(ctx.internals.approvalStoreForTest.listBindings({ agent: oldName })).toEqual(binding);
  expect((await ask().expect(200)).body.engagement).toEqual(original);

  // An idle provisioned home is usable: lack of a currently running model is
  // different from the operator's durable stop/cleanup fences.
  const reused = (await ask({ requestId: '$reuse-idle-fresh' }).expect(200)).body.engagement;
  expect(reused).toMatchObject({ state: 'active', agent: fresh.agent });
  expect(launches).toEqual([oldName, fresh.agent]);
});

test('unconfirmed cleanup excludes an agent from new admission even without manualDown', async () => {
  await homeserver();
  await boot({ agents: { fenced: agent('fenced', SIDE, {
    online: false, manualDown: false, stopUnconfirmedDispatches: ['unconfirmed-old-dispatch'],
  }) } });
  const launches = [];
  ctx.internals.setEngagementLauncherForTest(async (row) => { launches.push(row.name); });
  await auto();
  const capability = (await request(ctx.app).get('/api/capability').expect(200)).body;
  expect(capability.roles.find((row) => row.role === 'coding').able).toEqual([]);
  expect((await request(ctx.app).get(`/api/engagements/preview?role=coding&projectRoomId=${encodeURIComponent(ROOM)}`)
    .expect(200)).body.agent).toBeNull();
  await ask({ requestId: '$unconfirmed-hint', agent: 'fenced' }).expect(400);
  const fresh = (await ask().expect(200)).body.engagement;
  expect(fresh).toMatchObject({ state: 'active', fulfillment: { phase: 'complete', presetId: 'p1' } });
  expect(fresh.agent).not.toBe('fenced');
  expect(launches).toEqual([fresh.agent]);
  expect(JSON.parse(readFileSync(`${ctx.runtimeDir}/data/agents.json`, 'utf8')).fenced).toMatchObject({
    manualDown: false, stopUnconfirmedDispatches: ['unconfirmed-old-dispatch'],
  });
});

test('partial provisioning retains its allocation and retries the same identity', async () => {
  await homeserver(); await boot({ agents: {}, allocation: 1000 });
  ctx.internals.setEngagementLauncherForTest(async () => {});
  const created = (await ask()).body.engagement;
  hs.failJoin(true);
  const failed = await request(ctx.app).post(`/api/engagements/${created.id}/verdict`).send({ approve: true }).expect(503);
  expect(failed.body.engagement).toMatchObject({ state: 'pending', allocatedTokens: 1000 });
  await ask({ requestId: '$overbook' }).expect(409);
  hs.failJoin(false);
  const retried = await request(ctx.app).post(`/api/engagements/${created.id}/verdict`).send({ approve: true }).expect(200);
  expect(retried.body.engagement.agent).toBe(failed.body.engagement.agent);
  expect(hs.calls.filter((c) => c.path.endsWith('/whoami'))).toHaveLength(1);
});

test('requester token cannot claim a whitelisted room', async () => {
  await boot({ env: { ...ownerEnv, HAFLEET_REQUESTER_TOKEN: 'requester-fixture', MATRIX_BRIDGE_SECRET: 'bridge-fixture' } }); await auto();
  const req = await request(ctx.app).post('/api/engagements').set('Authorization', 'Bearer requester-fixture').send(body()).expect(200);
  expect(req.body.engagement).toMatchObject({ state: 'pending', route: 'notWhitelisted', autoJoined: false });
  const verified = await request(ctx.app).post('/api/engagements').set('X-Bridge-Secret', 'bridge-fixture')
    .send(body({ requestId: '$verified' })).expect(200);
  expect(verified.body.engagement.state).toBe('active');
});

test('external budget refusals do not reveal private allocations or raise submit-only alarms', async () => {
  await boot({ allocation: 987, env: { ...ownerEnv, HAFLEET_REQUESTER_TOKEN: 'requester-fixture', MATRIX_BRIDGE_SECRET: 'bridge-fixture' } });
  const pending = await request(ctx.app).post('/api/engagements').set('Authorization', 'Bearer requester-fixture')
    .send(body({ requestedTokens: 1234 })).expect(200);
  expect(pending.body.engagement.state).toBe('pending');
  expect((await request(ctx.app).get('/api/alerts')).body).toHaveLength(0);
  const refusal = await request(ctx.app).post('/api/engagements').set('X-Bridge-Secret', 'bridge-fixture')
    .send(body({ requestId: '$matrix', requestedTokens: 1234 })).expect(409);
  expect(refusal.body.reason).toBe('contribution_unavailable');
  expect(JSON.stringify(refusal.body)).not.toMatch(/987|1234|remainingTokens|committedTokens|allocatedTokens/);
});

test('requester engagement responses redact private ownership and configuration', async () => {
  await boot({ env: { ...ownerEnv, HAFLEET_REQUESTER_TOKEN: 'requester-fixture' } }); await auto();
  const first = await ask().expect(200);
  expect(first.body.engagement.state).toBe('active');
  const replay = await request(ctx.app).post('/api/engagements').set('Authorization', 'Bearer requester-fixture').send(body()).expect(200);
  expect(replay.body.engagement.id).toBe(first.body.engagement.id);
  expect(JSON.stringify(replay.body)).not.toMatch(/private-owner|private-dm|HAFLEET_OWNER|boundOwnerMxid|bindError|ownerMxid/);
});

test('side removal preserves unrelated alerts and withdraws memberships', async () => {
  await homeserver();
  await boot({ alerts: [SIDE, 'other.test'].map((side, i) => ({
    id: `identity-${i}`, alertType: 'agent_identity_unminted', dedupeKey: `agent_identity_unminted:right:${side}`,
    severity: 'warning', source: 'backend', summary: `identity unavailable on ${side}`, status: 'open', createdAt: Date.now(),
  })).concat([{ id: 'budget-prefix-neighbor', alertType: 'project_side_budget', dedupeKey: `project_side_budget:${SIDE}2`,
    severity: 'warning', source: 'backend', summary: 'neighbor budget', status: 'open', createdAt: Date.now() }]) });
  await auto(); await ask().expect(200);
  hs.failLeave(true);
  const failed = await request(ctx.app).delete(`/api/project-sides/${SIDE}?force=true`).expect(409);
  expect(failed.body.code).toBe('cleanup_incomplete');
  expect(failed.body.side).toMatchObject({ active: false, hasCredential: true });
  hs.failLeave(false);
  const removed = await request(ctx.app).delete(`/api/project-sides/${SIDE}?force=true`).expect(200);
  expect(removed.body.withdrawals).toContainEqual(expect.objectContaining({ agent: 'right', left: true }));
  expect(hs.calls.some((c) => c.path.endsWith('/leave') && c.user === '@ac_right:palpo.test')).toBe(true);
  const alerts = (await request(ctx.app).get('/api/alerts').expect(200)).body;
  expect(alerts.find((a) => a.dedupeKey.endsWith(':other.test')).status).not.toBe('resolved');
  expect(alerts.find((a) => a.dedupeKey.endsWith(`:${SIDE}`)).status).toBe('resolved');
  expect(alerts.find((a) => a.id === 'budget-prefix-neighbor').status).toBe('open');
});

test('registration-token fulfillment persists the bridge credential before activation and uses it to leave', async () => {
  await homeserver(); await boot({ agents: {}, env: { ...ownerEnv, MATRIX_BRIDGE_SECRET: 'bridge-fixture' } });
  await request(ctx.app).put(`/api/project-sides/${SIDE}/credential`).send({ credential: {
    kind: 'registrationToken', registrationToken: 'private-registration-token', representativeToken: 'private-representative-token',
  } }).expect(200);
  await startBridgeWorker();
  ctx.internals.setEngagementLauncherForTest(async () => {});
  const created = (await ask().expect(200)).body.engagement;
  const approved = await request(ctx.app).post(`/api/engagements/${created.id}/verdict`).send({ approve: true }).expect(200);
  const name = approved.body.engagement.agent;
  const file = `${ctx.runtimeDir}/data/matrix/bridge-state.json`;
  expect(JSON.parse(readFileSync(file)).agentTokens[name]).toMatchObject({ accessToken: 'private-agent-token', homeserver: hs.url });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(`${ctx.runtimeDir}/data/matrix-work.json`, 'utf8')).not.toMatch(/private-agent-token|private-registration-token/);
  await request(ctx.app).post(`/api/engagements/${created.id}/revoke`).send({}).expect(200);
  expect(hs.calls.filter((c) => c.path.includes('/join/') || c.path.endsWith('/leave')))
    .toEqual(expect.arrayContaining([expect.objectContaining({ auth: 'Bearer private-agent-token', user: null })]));
  expect(hs.calls.some((c) => c.path.endsWith('/leave') && c.auth === 'Bearer private-agent-token')).toBe(true);
  const removed = await request(ctx.app).delete(`/api/project-sides/${SIDE}?force=true`).expect(200);
  expect(removed.body.revocations).toContainEqual(expect.objectContaining({ agent: name, revoked: true }));
  expect(JSON.parse(readFileSync(file)).agentTokens[name]).toBeUndefined();
  expect(hs.calls.filter((c) => c.path.endsWith('/logout')).map((c) => c.auth)).toEqual([
    'Bearer private-agent-token', 'Bearer private-representative-token',
  ]);
  await request(ctx.app).post('/api/matrix-work/claim').send({}).expect(403);
});

test('cancelling a fulfillment during Matrix join withdraws again after the late join', async () => {
  await homeserver(); await boot({ agents: {} });
  hs.holdJoin();
  ctx.internals.setEngagementLauncherForTest(async () => { throw new Error('cancelled agent must never launch'); });
  const created = (await ask()).body.engagement;
  const approval = request(ctx.app).post(`/api/engagements/${created.id}/verdict`).send({ approve: true }).then((r) => r);
  await expect.poll(() => hs.calls.some((c) => c.path.includes('/join/'))).toBe(true);
  await request(ctx.app).post(`/api/engagements/${created.id}/verdict`).send({ approve: false }).expect(200);
  const earlyLeaves = hs.calls.filter((c) => c.path.endsWith('/leave')).length;
  hs.releaseJoin();
  expect((await approval).status).toBe(503);
  expect(hs.calls.filter((c) => c.path.endsWith('/leave')).length).toBeGreaterThan(earlyLeaves);
  expect((await request(ctx.app).get('/api/engagements')).body.engagements[0].state).toBe('ended');
  const ended = (await request(ctx.app).get('/api/engagements')).body.engagements[0];
  await ask({ agent: ended.agent, requestId: '$cancelled-reuse' }).expect(400);
});

test('an unprovisioned reservation prevents another side from overbooking the same seat', async () => {
  await homeserver();
  await boot({ agents: {}, rawDataFiles: { 'engagements.json': JSON.stringify({ engagements: {
    reserved: { id: 'reserved', projectRoomId: '!other:other.test', role: 'coding', agent: 'still-provisioning',
      state: 'pending', allocatedTokens: 4000, fulfillment: { presetId: 'p1', sideId: 'other.test', phase: 'reserved' } },
  } }) } });
  const created = (await ask({ requestedTokens: 2000 })).body.engagement;
  const response = await request(ctx.app).post(`/api/engagements/${created.id}/verdict`).send({ approve: true }).expect(409);
  expect(response.body.code).toBe('no_ceiling');
  expect(hs.calls.some((c) => c.path.endsWith('/whoami'))).toBe(false);
});

test('one-family review offers, preview and admission agree that the role is unavailable', async () => {
  await boot(); await auto();
  await request(ctx.app).put('/api/offers/review').send({ published: true, count: 2, budgetCapPerEngagement: 5000 }).expect(200);
  const result = await ask({ role: 'review' }).expect(200);
  expect(result.body.engagement).toMatchObject({ state: 'pending', route: 'crossFamilyUnavailable' });
  const preview = await request(ctx.app).get('/api/engagements/preview').query({ role: 'review', projectRoomId: ROOM, requestedTokens: 1000 }).expect(200);
  expect(preview.body).toMatchObject({ autoJoin: false, route: 'crossFamilyUnavailable' });
  const offers = await request(ctx.app).get('/api/offer-book').query({ projectRoomId: ROOM }).expect(200);
  expect(offers.body.roles.find((r) => r.role === 'review')).toMatchObject({ crossFamilyOk: false, serving: null });
  const verdict = await request(ctx.app).post(`/api/engagements/${result.body.engagement.id}/verdict`).send({ approve: true });
  expect(verdict.body.code).toBe('cross_family_unavailable');
  expect(verdict.status).toBe(409);
});

test('a configured provider owner never replaces an absent borrower binding on a project side', async () => {
  await boot();
  ctx.internals.approvalStoreForTest.removeBinding('right', ROOM);
  const created = (await ask()).body.engagement;
  await request(ctx.app).post(`/api/engagements/${created.id}/verdict`).send({ approve: true }).expect(409);
  const explicit = await request(ctx.app).post(`/api/engagements/${created.id}/verdict`).send({ approve: true,
    owner: { ownerMxid: '@borrower:palpo.test', ownerDmRoomId: '!borrower-dm:palpo.test' } }).expect(200);
  expect(explicit.body.binding.ownerMxid).toBe('@borrower:palpo.test');
});

test('side removal retains credentials on retirement persistence failure and succeeds on retry', async () => {
  await homeserver(); await boot();
  ctx.internals.setJsonSaveFailureForTest('agents.json', true);
  await request(ctx.app).delete(`/api/project-sides/${SIDE}?force=true`).expect(500);
  expect((await request(ctx.app).get(`/api/project-sides/${SIDE}`).expect(200)).body.side.hasCredential).toBe(true);
  ctx.internals.setJsonSaveFailureForTest('agents.json', false);
  await request(ctx.app).delete(`/api/project-sides/${SIDE}?force=true`).expect(200);
});

test('permanently unavailable Matrix credentials require explicit audited cleanup abandonment', async () => {
  await homeserver(); await boot({ env: { ...ownerEnv, MATRIX_BRIDGE_SECRET: 'bridge-fixture' } });
  await request(ctx.app).put(`/api/project-sides/${SIDE}/credential`).send({ credential: {
    kind: 'registrationToken', registrationToken: 'registration-fixture', representativeToken: 'representative-fixture',
  } }).expect(200);
  const mod = await startBridgeWorker();
  mod.agentTokenStateForTest().right = { homeserver: 'https://old.invalid', serverName: 'old.invalid', mxid: '@ac_right:old.invalid', accessToken: 'old-private' };
  const failed = await request(ctx.app).delete(`/api/project-sides/${SIDE}?force=true`).expect(409);
  expect(failed.body.code).toBe('cleanup_incomplete');
  const result = await request(ctx.app).delete(`/api/project-sides/${SIDE}?force=true&abandon_unreachable=true`).expect(200);
  expect(result.body.cascade).toBe('partial');
  expect(result.body.withdrawals).toContainEqual(expect.objectContaining({ agent: 'right', left: false, reason: 'credential_side_mismatch' }));
  const audit = JSON.parse(readFileSync(`${ctx.runtimeDir}/data/project-sides.json`)).audit;
  expect(audit.find((entry) => entry.type === 'side_removed').cleanup.abandonedUnreachable).toBe(true);
  expect(hs.calls.some((c) => c.auth === 'Bearer old-private')).toBe(false);
});

test('forced abandonment accepts classified unreachable App Service withdrawals', async () => {
  await homeserver(); await boot();
  hs.failLeave(true);
  const failed = await request(ctx.app).delete(`/api/project-sides/${SIDE}?force=true`).expect(409);
  expect(failed.body.withdrawals).toContainEqual(expect.objectContaining({ state: 'unreachable', left: false }));
  await request(ctx.app).delete(`/api/project-sides/${SIDE}?abandon_unreachable=true`).expect(409);
  const removed = await request(ctx.app).delete(`/api/project-sides/${SIDE}?force=true&abandon_unreachable=true`).expect(200);
  expect(removed.body.cascade).toBe('partial');
  expect(removed.body.withdrawals.some(row => row.left === false && row.state === 'unreachable')).toBe(true);
  const audit = JSON.parse(readFileSync(`${ctx.runtimeDir}/data/project-sides.json`)).audit;
  expect(audit.find(row => row.type === 'side_removed').cleanup.abandonedUnreachable).toBe(true);
});

test('null Agent owner resolution refuses conflicting room bindings', async () => {
  await homeserver(); await boot({ agents: {} });
  const store = ctx.internals.approvalStoreForTest;
  store.upsertBinding({ agent: 'former-one', project: 'project', project_room_id: ROOM,
    owner_mxid: '@one:palpo.test', owner_dm_room_id: '!one-private:palpo.test' });
  store.upsertBinding({ agent: 'former-two', project: 'project', project_room_id: ROOM,
    owner_mxid: '@two:palpo.test', owner_dm_room_id: '!two-private:palpo.test' });
  const created = (await ask().expect(200)).body.engagement;
  expect(created.agent).toBeNull();
  const denied = await request(ctx.app).post(`/api/engagements/${created.id}/verdict`).send({ approve: true }).expect(409);
  expect(denied.body.error).toMatch(/owner/i);
  expect(hs.calls.some(row => row.path.endsWith('/register'))).toBe(false);
});
