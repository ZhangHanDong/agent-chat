import { afterEach, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';
import { derivedRegistrationId } from '../lib/project-side-inbound.js';
import { publicResourceId } from '../lib/project-agent-definition.js';
import { createEngagementStore } from '../lib/engagement-store.js';

const fleetId = `hf_${'d'.repeat(32)}`, side = 'palpo.test', hsToken = 'fixture-hs', bridgeSecret = 'fixture-bridge';
const room = `!project:${side}`, ownerMxid = `@owner:${side}`, rep = `@${fleetId}_representative:${side}`;
const owner = { ownerMxid, ownerDmRoomId: `!private:${side}` };
const presets = ['strong', 'medium'].map(id => ({ id, name: `${id} resource`, framework: 'codex', model: 'gpt-5.6-sol',
  reasoning: id === 'medium' ? 'medium' : 'high', catalogPublished: id === 'medium', ceiling: { tokens: 10000, period: 'monthly' } }));
let ctx, server, joined, allowOwner, outboundGeneration, retirementRequests, retirementFailures;
afterEach(async () => { await ctx?.cleanup(); ctx = null; if (server) await new Promise(resolve => server.close(resolve)); server = null; });
const askContext = (name, requestId = name) => ({ v: 1, fleetId, requestId, sourceEventId: `$${requestId}`,
  sourceRoomId: `!reception:${side}`, targetProjectId: 'project_1', targetRoomId: room,
  requesterMxid: ownerMxid, ...owner, authVersion: 1, role: 'coding', requestedTokens: 1000, ratePerDay: 100,
  agentDefinition: { name, resourceId: publicResourceId(presets[1]) } });
const call = context => request(ctx.app).post('/api/fleet-control').set('X-Bridge-Secret', bridgeSecret)
  .send({ action: 'request', sideId: side, registration: derivedRegistrationId(side, hsToken), context,
    ...(outboundGeneration ? { transportGeneration: outboundGeneration } : {}) });
const approve = (id, body = {}) => request(ctx.app).post(`/api/engagements/${id}/verdict`).send({ approve: true, owner, ...body });
const rows = async () => (await request(ctx.app).get('/api/engagements').expect(200)).body.engagements;
test('verified fleet project labels populate console metadata without changing request identity', async () => {
  await boot();
  const context = askContext('named-project');
  const send = projectName => request(ctx.app).post('/api/fleet-control').set('X-Bridge-Secret', bridgeSecret)
    .send({ action: 'request', sideId: side, registration: derivedRegistrationId(side, hsToken), context, projectName });
  const first = (await send('项目规划群').expect(200)).body;
  expect(first).toMatchObject({ ok: true, state: 'pending' });
  const projects = (await request(ctx.app).get('/api/project-sides').expect(200)).body.sides[0].projects;
  expect(projects).toContainEqual(expect.objectContaining({ id: 'project_1', name: '项目规划群', roomId: room }));
  const retry = (await send('Renamed project').expect(200)).body;
  expect(retry.engagementId).toBe(first.engagementId);
  const [record] = await rows();
  expect(record.project).toBe('project_1');
  expect(record.requestContext).toEqual(context);
  expect(record.requestContext).not.toHaveProperty('projectName');
  const wrongRoom = (await request(ctx.app).post('/api/fleet-control').set('X-Bridge-Secret', bridgeSecret)
    .send({ action: 'request', sideId: side, registration: derivedRegistrationId(side, hsToken),
      context: { ...context, targetRoomId: `!different:${side}` }, projectName: 'Cannot move this project' }).expect(200)).body;
  expect(wrongRoom).toMatchObject({ ok: false, status: 409, code: 'project_metadata_conflict' });
  expect((await request(ctx.app).get('/api/project-sides')).body.sides[0].projects[0].roomId).toBe(room);
});

async function boot({ manualOffers = true, outbound = false } = {}) {
  joined = []; allowOwner = true;
  outboundGeneration = outbound ? 1 : null; retirementRequests = []; retirementFailures = 0;
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture'); req.resume(); res.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/retire-agent')) {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw); retirementRequests.push({ body, headers: req.headers });
        if (retirementFailures-- > 0) { res.statusCode = 503; res.end(JSON.stringify({ code: 'retirement_unavailable' })); return; }
        res.end(JSON.stringify({ fleetId, requestId: body.requestId,
          agent: { mxid: body.agentMxid, state: 'retired', matrixIdentity: 'deactivated', joinedRooms: [], appserviceAccess: 'revoked' } }));
      });
      return;
    }
    let value = {};
    if (url.pathname.endsWith('/whoami')) value = { user_id: url.searchParams.get('user_id') };
    else if (url.pathname.includes('/join/')) { joined.push(url.searchParams.get('user_id')); value = { room_id: room }; }
    else if (url.pathname.endsWith('/joined_members')) value = { joined: { [ownerMxid]: {}, [rep]: {} } };
    else if (url.pathname.endsWith('/m.room.power_levels/')) value = { users: { [ownerMxid]: allowOwner ? 100 : 0 }, invite: 0 };
    else if (url.pathname.endsWith('/m.room.join_rules/')) value = { join_rule: 'invite' };
    else if (url.pathname.endsWith('/m.room.encryption/')) { res.statusCode = 404; }
    else if (url.pathname.includes('/com.hafleet.admin.binding.v1/')) value = { v: 1, fleetId, purpose: 'project', projectId: 'project_1', ownerMxid, authVersion: 1 };
    res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx = await createBackendTestContext('palpo-definitions-', { frameworkPresets: structuredClone(presets),
    agents: { original: { name: 'original', kind: 'agent', type: 'codex', projectSide: side, presetId: 'strong',
      runtimeProfile: { primary: { framework: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' } } } },
    env: { MATRIX_BRIDGE_SECRET: bridgeSecret, HAFLEET_THREAD_SESSIONS: '1', HAFLEET_ROUTER_TASK_CUTOVER: '1' },
    rawDataFiles: { 'project-sides.json': JSON.stringify({ version: 1, audit: [], sides: { [side]: {
      id: side, serverName: side, active: true, apiBaseUrl: `http://127.0.0.1:${server.address().port}`, projects: {},
      allocatedTokens: 20000, representative: { mxid: rep }, credential: { kind: 'appservice', asToken: 'fixture-as', hsToken,
        ...(outbound ? { transport: { mode: 'outbound', url: `http://127.0.0.1:${server.address().port}/api/fleet/v2/${fleetId}`, token: 'fixture-machine-token-long', generation: 1 } } : {}),
        senderLocalpart: `${fleetId}_representative`, namespace: `^@${fleetId}_[a-z0-9_]+:palpo\\.test$` },
    } } }) },
  });
  ctx.internals.stopRouterPumpForTest(); ctx.internals.setEngagementLauncherForTest(async () => {});
  if (manualOffers) await request(ctx.app).put('/api/offers/coding').send({ published: true, count: 10 }).expect(200);
}

test('last Palpo allocation retirement fences admission and verifies remote removal', async () => {
  await boot({ outbound: true });
  const submitted = (await call(askContext('retire-edison')).expect(200)).body;
  const approved = (await approve(submitted.engagementId).expect(200)).body.engagement;
  const response = (await request(ctx.app).post(`/api/engagements/${approved.id}/revoke`).send({ reason: 'operator revoke' }).expect(200)).body;
  expect(response.engagement).toMatchObject({ state: 'ended', bound: false, withdrawal: { scope: 'agent', state: 'complete', retirement: { localStopped: true, remote: { state: 'retired' } } } });
  expect(retirementRequests).toHaveLength(1);
  expect(retirementRequests[0]).toMatchObject({ headers: { authorization: 'Bearer fixture-machine-token-long', 'x-hafleet-generation': '1' }, body: { requestId: 'retire-edison', localStopped: true } });
  expect((await request(ctx.app).get('/api/agents?view=names')).body).not.toContain(approved.agent);
  expect((await request(ctx.app).get('/api/contributions')).body.contributions.some(row => row.agent === approved.agent && row.active)).toBe(false);
  expect((await request(ctx.app).get('/api/agents/original')).body.retiredAt).toBeUndefined();
});

test('incomplete Palpo retirement stays fenced and retries the original identity', async () => {
  await boot({ outbound: true });
  const submitted = (await call(askContext('retry-retirement')).expect(200)).body;
  const approved = (await approve(submitted.engagementId).expect(200)).body.engagement;
  retirementFailures = 1;
  const revoke = () => request(ctx.app).post(`/api/engagements/${approved.id}/revoke`).send({});
  const first = (await revoke().expect(200)).body.engagement;
  expect(first.withdrawal).toMatchObject({ state: 'failed', scope: 'agent' });
  expect((await request(ctx.app).get('/api/agents?view=names')).body).not.toContain(approved.agent);
  const second = (await revoke().expect(200)).body.engagement;
  expect(second).toMatchObject({ endedAt: first.endedAt, withdrawal: { state: 'complete' } });
  expect(retirementRequests[1].body).toEqual(retirementRequests[0].body);
});

test('revoking one of two allocations keeps the Agent on Matrix', async () => {
  await boot({ outbound: true });
  const submitted = (await call(askContext('shared-edison')).expect(200)).body;
  const first = (await approve(submitted.engagementId).expect(200)).body.engagement;
  const next = (await request(ctx.app).post('/api/engagements').send({
    project: 'project_1', projectRoomId: room, role: 'coding', agent: first.agent, requester: ownerMxid,
    requestedTokens: 1000, requestId: 'second-funded-allocation',
  }).expect(200)).body.engagement;
  await approve(next.id).expect(200);
  const ended = (await request(ctx.app).post(`/api/engagements/${first.id}/revoke`).send({}).expect(200)).body;
  expect(ended.engagement.withdrawal.state).toBe('retained');
  expect(retirementRequests).toHaveLength(0);
  expect((await request(ctx.app).get('/api/agents?view=names')).body).toContain(first.agent);
});

const catalog = async () => (await request(ctx.app).post('/api/fleet-control').set('X-Bridge-Secret', bridgeSecret)
  .send({ action: 'capabilities', sideId: side, registration: derivedRegistrationId(side, hsToken) }).expect(200)).body.offers;
const rolesFor = async id => (await catalog()).filter(o => o.published && o.resources.some(r => r.id === id)).map(o => o.role);

test('new resources automatically publish qualified Palpo roles without enabling automatic acceptance', async () => {
  await boot({ manualOffers: false });
  const input = { ...presets[1], name: 'New automatic resource', apiKey: 'secret-model-key', apiBaseUrl: 'https://private.invalid',
    extraArgs: '--private-config', catalogPublished: undefined, executionPolicy: { yolo: true } };
  const created = (await request(ctx.app).post('/api/framework-presets').send(input).expect(200)).body.preset;
  expect(created.catalogPublished).toBe(true);
  const resourceId = publicResourceId(created);
  expect(await rolesFor(resourceId)).toEqual(['coding', 'testing', 'integration', 'documentation']);
  const stored = JSON.parse(readFileSync(path.join(ctx.runtimeDir, 'data/framework-presets.json'), 'utf8'));
  expect(stored.find(p => p.id === created.id).catalogPublished).toBe(true);
  expect(JSON.stringify(await catalog())).not.toMatch(/secret-model-key|private.invalid|private-config|apiKey|apiBaseUrl|preset_/);
  const offers = (await request(ctx.app).get('/api/offers').expect(200)).body.offers;
  expect(offers.every(o => o.published === false)).toBe(true); // No legacy auto-acceptance offer was written.
  expect(offers.find(o => o.role === 'testing').catalogPublished).toBe(true);
  await request(ctx.app).post('/api/whitelist').send({ projectRoomId: room }).expect(200);
  const context = { ...askContext('automatic-tester'), role: 'testing', agentDefinition: { name: 'automatic-tester', resourceId } };
  const submitted = (await call(context).expect(200)).body;
  expect(submitted).toMatchObject({ ok: true, state: 'pending', agentMxid: null });
  expect((await request(ctx.app).get('/api/agents')).body).toHaveLength(1);
  const approved = await approve(submitted.engagementId).expect(200);
  expect(approved.body.engagement.fulfillment.presetId).toBe(created.id);
  expect((await request(ctx.app).get(`/api/agents/${approved.body.engagement.agent}`)).body.runtimeProfile.primary.reasoning).toBe('medium');
  expect((await request(ctx.app).get(`/api/agents/${approved.body.engagement.agent}/execution-policy`)).body.executionPolicy).toEqual({ yolo: true });
  expect((await request(ctx.app).get('/api/agents/original/execution-policy')).body.executionPolicy).toEqual({ yolo: false });
});

test('automatic Palpo catalog follows resource edits deletion and explicit role withdrawal', async () => {
  await boot({ manualOffers: false });
  const input = { name: 'Automatic high', framework: 'codex', model: 'gpt-5.6-sol', reasoning: 'high', ceiling: { tokens: 10000, period: 'monthly' } };
  const resource = (await request(ctx.app).post('/api/framework-presets').send(input).expect(200)).body.preset;
  const id = publicResourceId(resource), endpoint = `/api/framework-presets/${resource.id}`;
  expect(await rolesFor(id)).toContain('architect');
  expect(await rolesFor(id)).not.toContain('review');
  await request(ctx.app).put(endpoint).send({ ...input, reasoning: 'medium' }).expect(200);
  expect(await rolesFor(id)).not.toContain('architect');
  await request(ctx.app).put(endpoint + '/catalog').send({ published: false }).expect(200);
  await request(ctx.app).put(endpoint).send({ ...input, name: 'Edited while withdrawn' }).expect(200);
  expect(await rolesFor(id)).toEqual([]);
  await request(ctx.app).put(endpoint + '/catalog').send({ published: true }).expect(200);
  await request(ctx.app).put('/api/offers/documentation').send({ published: false }).expect(200);
  expect(await rolesFor(id)).not.toContain('documentation');
  expect(await rolesFor(id)).toContain('architect');
  await request(ctx.app).put('/api/offers/review').send({ published: true }).expect(200);
  expect(await rolesFor(id)).not.toContain('review'); // Explicit publication cannot bypass the family gate.
  await request(ctx.app).delete(endpoint).expect(200);
  expect(await rolesFor(id)).toEqual([]);
  for (const patch of [{ ceiling: null }, { framework: 'octos' }, { catalogPublished: false }]) {
    const row = (await request(ctx.app).post('/api/framework-presets').send({ ...input, ...patch }).expect(200)).body.preset;
    expect(await rolesFor(publicResourceId(row))).toEqual([]);
  }
  await request(ctx.app).post('/api/framework-presets').send({ ...input, catalogPublished: 'yes' }).expect(400);
});

test('Palpo requests on a fresh resource wait for approval without consuming exhausted project budgets', async () => {
  await boot();
  const first = (await call(askContext('already-active')).expect(200)).body.engagementId;
  await approve(first).expect(200);
  const legacy = (await request(ctx.app).post('/api/engagements').send({ project: 'project', projectRoomId: room,
    role: 'coding', requester: ownerMxid, requestedTokens: 1000, requestId: 'legacy-active' }).expect(200)).body.engagement;
  await approve(legacy.id, { allocation: { kind: 'agent', agent: 'original' } }).expect(200);
  await request(ctx.app).put(`/api/project-sides/${side}/allocation`).send({ allocated_tokens: 1000 }).expect(200);
  await request(ctx.app).post('/api/whitelist').send({ projectRoomId: room }).expect(200);
  const fresh = (await request(ctx.app).post('/api/framework-presets').send({
    name: 'Fresh resource', framework: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium',
    ceiling: { tokens: 100000, period: 'monthly' },
  }).expect(200)).body.preset;
  const context = { ...askContext('waiting-for-budget'), agentDefinition: { name: 'waiting-for-budget', resourceId: publicResourceId(fresh) } };
  const submitted = (await call(context).expect(200)).body;
  expect(submitted).toMatchObject({ ok: true, state: 'pending', allocatedTokens: null, agentMxid: null, fulfillment: null });
  expect((await call(context)).body.engagementId).toBe(submitted.engagementId);
  const counts = async () => (await request(ctx.app).get('/api/agents')).body.length;
  expect(await counts()).toBe(2); // Original seed and the first approved Agent only.
  const pending = (await rows()).find(e => e.id === submitted.engagementId);
  expect(pending).toMatchObject({ state: 'pending', allocatedTokens: null, agent: null });
  expect(pending.fulfillment).toBeFalsy();
  expect((await rows()).find(e => e.id === first).state).toBe('active');
  const budget = (await request(ctx.app).get(`/api/project-sides/${side}/budget`)).body;
  expect(budget).toMatchObject({ allocated: 1000, committed: 1000, poolCommitted: 1000, remaining: 0 });
  // Ordinary intake can auto-accept, so it must retain its upfront budget fence.
  await request(ctx.app).put(`/api/project-sides/${side}/allocation`).send({ allocated_tokens: 0 }).expect(200);
  await request(ctx.app).post('/api/engagements').send({ project: 'project', projectRoomId: room,
    role: 'coding', requester: ownerMxid, requestedTokens: 1000, requestId: 'legacy-over-budget' }).expect(409);
  await request(ctx.app).put(`/api/project-sides/${side}/allocation`).send({ allocated_tokens: null }).expect(200);
  const unfunded = (await call({ ...askContext('not-funded'), agentDefinition: { name: 'not-funded', resourceId: publicResourceId(fresh) } })).body;
  expect(unfunded).toMatchObject({ ok: true, state: 'pending', allocatedTokens: null });
  expect(await counts()).toBe(2);
  const approved = await approve(submitted.engagementId).expect(200);
  expect(approved.body.engagement).toMatchObject({ state: 'active', allocatedTokens: 1000, fulfillment: { presetId: fresh.id } });
  expect((await request(ctx.app).get(`/api/project-sides/${side}/budget`)).body).toMatchObject({ allocated: null, committed: 1000, poolCommitted: 2000, remaining: null });
  expect(await counts()).toBe(3);
  // Even an explicit zero closes legacy admission, not the separately funded pool.
  await request(ctx.app).put(`/api/project-sides/${side}/allocation`).send({ allocated_tokens: 0 }).expect(200);
  await approve(unfunded.engagementId).expect(200);
  expect((await request(ctx.app).get(`/api/project-sides/${side}/budget`)).body).toMatchObject({ allocated: 0, committed: 1000, poolCommitted: 3000 });
});

test('Palpo pool approval separates resource ceilings and enforces shared account quota', async () => {
  await boot();
  const first = (await call(askContext('medium-first'))).body.engagementId;
  await approve(first, { allocatedTokens: 10000 }).expect(200);
  const fresh = (await request(ctx.app).post('/api/framework-presets').send({ ...presets[0], name: 'Independent pool', catalogPublished: true }).expect(200)).body.preset;
  const context = { ...askContext('independent'), agentDefinition: { name: 'independent', resourceId: publicResourceId(fresh) } };
  const id = (await call(context).expect(200)).body.engagementId;
  const candidates = async () => (await request(ctx.app).get(`/api/engagements/${id}/candidates`).expect(200)).body.candidates;
  expect(await candidates()).toMatchObject([{ remainingTokens: 10000, budget: {
    scope: 'resource', pool: { ceiling: 10000, committed: 0, remaining: 10000 }, seat: { quota: null, committed: 10000, remaining: null },
  } }]);
  const seatId = (await request(ctx.app).get('/api/seats')).body.seats[0].seatId;
  await request(ctx.app).put(`/api/seats/${seatId}`).send({ quotaTokens: 10500, period: 'monthly' }).expect(200);
  expect(await candidates()).toMatchObject([{ remainingTokens: 500, budget: { pool: { remaining: 10000 }, seat: { remaining: 500 } } }]);
  const refused = await approve(id).expect(409);
  expect(refused.body.error).toMatch(/shared account/i);
  expect((await rows()).find(e => e.id === id)).toMatchObject({ state: 'pending', allocatedTokens: null });
  await request(ctx.app).put(`/api/seats/${seatId}`).send({ quotaTokens: 11000, period: 'monthly' }).expect(200);
  await approve(id).expect(200);
  expect((await rows()).find(e => e.id === id).fulfillment.presetId).toBe(fresh.id);
  const exhausted = (await call(askContext('medium-full')).expect(200)).body.engagementId;
  expect((await approve(exhausted).expect(409)).body.error).toMatch(/pool/i);
});

test('concurrent Palpo definitions reserve the selected pool only once and preserve retry', async () => {
  await boot();
  await request(ctx.app).put('/api/framework-presets/medium').send({ ...presets[1], ceiling: { tokens: 1000, period: 'monthly' } }).expect(200);
  const ids = [];
  for (const name of ['competing-one', 'competing-two']) ids.push((await call(askContext(name)).expect(200)).body.engagementId);
  ctx.internals.setEngagementLauncherForTest(async () => { throw new Error('fixture launch interrupted'); });
  const results = await Promise.all(ids.map(id => approve(id)));
  expect(results.map(r => r.status).sort()).toEqual([409, 503]);
  const winner = (await rows()).find(e => e.fulfillment);
  expect(winner.allocatedTokens).toBe(1000);
  const before = (await request(ctx.app).get(`/api/engagements/${winner.id}/candidates`)).body.candidates[0];
  expect(before).toMatchObject({ remainingTokens: 1000, budget: { pool: { committed: 0, remaining: 1000 }, reserved: 1000 } });
  ctx.internals.setEngagementLauncherForTest(async () => {});
  const retried = await approve(winner.id).expect(200);
  expect(retried.body.engagement.agent).toBe(winner.agent);
  expect((await request(ctx.app).get('/api/agents')).body).toHaveLength(2);
});

test('Palpo definitions provision distinct agents on the requested resource without provider definitions', async () => {
  await boot();
  const names = [], mxids = [];
  for (const name of ['fast-one', 'fast-two', '小白', '孙悟空-01']) {
    const context = askContext(name, `definition-${names.length}`), created = await call(context).expect(200);
    expect(created.body).toMatchObject({ ok: true, state: 'pending', agentMxid: null, agentDefinition: context.agentDefinition });
    const id = created.body.engagementId;
    expect((await request(ctx.app).get('/api/agents')).body).toHaveLength(names.length + 1);
    const choices = (await request(ctx.app).get(`/api/engagements/${id}/candidates`).expect(200)).body;
    expect(choices.candidates).toMatchObject([{ name, reasoning: 'medium', provision: true, choice: { kind: 'project-definition' } }]);
    const verdict = await approve(id);
    expect(verdict.status, JSON.stringify(verdict.body)).toBe(200);
    expect(verdict.body.engagement.fulfillment.presetId).toBe('medium');
    names.push(verdict.body.engagement.agent);
    const agent = (await request(ctx.app).get(`/api/agents/${names.at(-1)}`).expect(200)).body;
    expect(agent.displayName).toBe(name);
    expect(agent.name).toMatch(/^pa_[a-z0-9_]+$/);
    expect(agent.runtimeProfile.primary.reasoning).toBe('medium');
    expect(agent.presetId).toBe('medium');
    const status = await call(context); mxids.push(status.body.agentMxid);
    expect(status.body.state).toBe('active');
    await approve(id).expect(200);
    const stored = JSON.parse(readFileSync(path.join(ctx.runtimeDir, 'data/engagements.json'), 'utf8'));
    expect(createEngagementStore({ load: () => stored }).get(id).requestContext.agentDefinition).toEqual(context.agentDefinition);
  }
  expect(new Set(names).size).toBe(4); expect(new Set(mxids).size).toBe(4);
  expect(mxids.every(mxid => /^@[a-z0-9_]+:palpo\.test$/.test(mxid))).toBe(true);
  expect(joined).toEqual(expect.arrayContaining(mxids));
  expect((await request(ctx.app).get('/api/framework-presets')).body.every(p => p.agentDefinitions.length === 0)).toBe(true);
  expect((await request(ctx.app).get('/api/agents')).body).toHaveLength(5);
  const third = (await call(askContext('third'))).body.engagementId;
  await approve(third, { allocatedTokens: 9500 }).expect(409);
  expect((await request(ctx.app).get('/api/agents')).body).toHaveLength(5);
  const other = (await request(ctx.app).post('/api/engagements').send({ project: 'other', projectRoomId: `!other:${side}`, role: 'coding',
    requester: ownerMxid, requestedTokens: 100, requestId: 'other-project' }).expect(200)).body.engagement;
  await approve(other.id, { allocation: { kind: 'agent', agent: names[0] } }).expect(409);
});

test('Palpo definition allocation refuses substitution and preserves reservation retry', async () => {
  await boot(); const context = askContext('retry-one');
  const id = (await call(context)).body.engagementId;
  await approve(id, { allocation: { kind: 'agent', agent: 'original' } }).expect(409);
  allowOwner = false; await approve(id).expect(409); allowOwner = true;
  expect((await rows())[0].allocatedTokens).toBeNull();
  ctx.internals.setEngagementLauncherForTest(async () => { throw new Error('fixture interruption'); });
  await approve(id).expect(503);
  const reserved = (await rows())[0];
  expect(reserved.fulfillment.presetId).toBe('medium');
  await approve(id, { allocation: { kind: 'agent', agent: 'original' } }).expect(409);
  await approve(id, { allocatedTokens: 999 }).expect(409);
  await request(ctx.app).put('/api/framework-presets/medium').send({ ...presets[1], reasoning: 'high' }).expect(409);
  await request(ctx.app).delete('/api/framework-presets/medium').expect(409);
  await request(ctx.app).put('/api/framework-presets/medium/catalog').send({ published: false }).expect(200);
  ctx.internals.setEngagementLauncherForTest(async () => {});
  const retried = await approve(id).expect(200);
  expect(retried.body.engagement.agent).toBe(reserved.agent);
  expect((await request(ctx.app).get('/api/agents')).body).toHaveLength(2);
});

test('Palpo definitions reject unpublished resources and project name conflicts', async () => {
  await boot(); const context = askContext('same-name');
  const original = (await call(context)).body;
  expect(original.ok).toBe(true);
  expect((await call({ ...context, requestId: 'different', sourceEventId: '$different' })).body).toMatchObject({ ok: false, code: 'conflict' });
  expect((await call({ ...context, agentDefinition: { ...context.agentDefinition, name: 'renamed' } })).body.code).toBe('conflict');
  expect((await call({ ...askContext('private'), agentDefinition: { name: 'private', resourceId: publicResourceId(presets[0]) } })).body.ok).toBe(false);
  expect((await call({ ...askContext('invalid'), agentDefinition: { name: '../escape', resourceId: publicResourceId(presets[1]) } })).body.status).toBe(400);
  const otherProject = { ...askContext('same-name', 'another-project'), targetProjectId: 'project_2', targetRoomId: `!other:${side}` };
  expect((await call(otherProject)).body.ok).toBe(true);
  await request(ctx.app).put('/api/framework-presets/medium/catalog').send({ published: false }).expect(200);
  expect((await call(context)).body.engagementId).toBe(original.engagementId);
  expect((await call(askContext('unpublished'))).body.ok).toBe(false);
  await approve(original.engagementId).expect(409);
  expect((await request(ctx.app).get('/api/agents')).body).toHaveLength(1);
  expect(await rows()).toHaveLength(2);
});
