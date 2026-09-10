import { afterEach, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const ROOM = '!project:palpo.test';
const presets = [
  { id: 'strong', name: 'Strong resource', framework: 'codex', model: 'gpt-5.6-sol', reasoning: 'high', ceiling: { tokens: 10000, period: 'monthly' } },
  { id: 'medium', name: 'Medium resource', framework: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium', apiKey: 'private-model-key', ceiling: { tokens: 10000, period: 'monthly' } },
];
let ctx; let server;
afterEach(async () => { await ctx?.cleanup(); ctx = null; if (server) await new Promise(resolve => server.close(resolve)); server = null; });
async function boot() {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    req.resume(); res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(url.pathname.endsWith('/whoami') ? { user_id: url.searchParams.get('user_id') }
      : url.pathname.includes('/join/') ? { room_id: ROOM } : {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx = await createBackendTestContext('resource-definitions-', {
    frameworkPresets: structuredClone(presets),
    agents: { original: { name: 'original', type: 'codex', kind: 'agent', projectSide: 'palpo.test', presetId: 'strong',
      runtimeProfile: { primary: { framework: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' } } } },
    env: { HAGENCY_THREAD_SESSIONS: '1', HAGENCY_ROUTER_TASK_CUTOVER: '1',
      HAGENCY_OWNER_MXID: '@owner:palpo.test', HAGENCY_OWNER_DM_ROOM: '!private:palpo.test' },
  });
  ctx.internals.stopRouterPumpForTest();
  ctx.internals.setEngagementLauncherForTest(async () => {});
  for (const side of ['palpo.test', 'foreign.test']) {
    await request(ctx.app).post('/api/project-sides').send({ server_name: side, api_base_url: `http://127.0.0.1:${server.address().port}` }).expect(200);
    await request(ctx.app).put(`/api/project-sides/${side}/allocation`).send({ allocated_tokens: 20000 }).expect(200);
  }
  await request(ctx.app).put('/api/project-sides/palpo.test/credential').send({ credential: {
    kind: 'appservice', asToken: 'fixture-as', hsToken: 'fixture-hs', namespace: '^@ac_.*', senderLocalpart: 'hagency',
  } }).expect(200);
  ctx.internals.approvalStoreForTest.upsertBinding({ agent: 'original', project: 'project', project_room_id: ROOM,
    owner_mxid: '@owner:palpo.test', owner_dm_room_id: '!private:palpo.test' });
}
const define = (name, role = 'coding') => request(ctx.app).post('/api/framework-presets/medium/agents').send({ name, role });
const ask = id => request(ctx.app).post('/api/engagements').send({ project: 'project', projectRoomId: ROOM,
  requester: '@requester:palpo.test', role: 'coding', requestedTokens: 1000, requestId: id });

test('resource definitions persist without provisioning and enforce unique qualified names', async () => {
  await boot();
  const one = (await define('fast-one').expect(200)).body.definition;
  const two = (await define('fast-two', 'testing').expect(200)).body.definition;
  expect(two.id).not.toBe(one.id);
  const list = (await request(ctx.app).get('/api/framework-presets').expect(200)).body;
  expect(list.find(p => p.id === 'medium').agentDefinitions).toMatchObject([{ name: 'fast-one', status: 'defined' }, { name: 'fast-two', role: 'testing' }]);
  const persisted = JSON.parse(readFileSync(path.join(ctx.runtimeDir, 'data', 'framework-presets.json'), 'utf8'));
  expect(persisted.find(p => p.id === 'medium').agentDefinitions.map(d => d.name)).toEqual(['fast-one', 'fast-two']);
  expect((await request(ctx.app).get('/api/agents').expect(200)).body.map(a => a.name)).toEqual(['original']);
  await define('fast-one').expect(409);
  await define('original').expect(409);
  await define('../escape').expect(400);
  await define('weak-architect', 'architect').expect(400);
  await request(ctx.app).delete('/api/framework-presets/medium').expect(409);
  await request(ctx.app).put(`/api/framework-presets/medium/agents/${two.id}`).send({ name: 'tester-two' }).expect(200);
  await request(ctx.app).delete(`/api/framework-presets/medium/agents/${two.id}`).expect(200);
});

test('explicit definition provisions a second agent with its own resource and stable retry', async () => {
  await boot();
  const d = (await define('fast-one').expect(200)).body.definition;
  const e = (await ask('$second').expect(200)).body.engagement;
  expect(e.agent).toBe('original');
  const allocation = { kind: 'definition', definitionId: d.id };
  const candidates = (await request(ctx.app).get(`/api/engagements/${e.id}/candidates`).expect(200)).body.candidates;
  expect(candidates).toEqual(expect.arrayContaining([expect.objectContaining({ choice: allocation, name: 'fast-one', reasoning: 'medium', provision: true })]));
  const verdict = await request(ctx.app).post(`/api/engagements/${e.id}/verdict`).send({ approve: true, allocation }).expect(200);
  expect(verdict.body.engagement).toMatchObject({ state: 'active', agent: 'fast-one', fulfillment: { presetId: 'medium', allocationChoice: allocation, phase: 'complete' } });
  const row = (await request(ctx.app).get('/api/agents/fast-one').expect(200)).body;
  expect(row.runtimeProfile.primary).toMatchObject({ model: 'gpt-5.6-sol', reasoning: 'medium' });
  expect(row.presetId).toBe('medium');
  await request(ctx.app).post(`/api/engagements/${e.id}/verdict`).send({ approve: true, allocation }).expect(200);
  expect((await request(ctx.app).get('/api/agents').expect(200)).body).toHaveLength(2);
  await request(ctx.app).delete(`/api/framework-presets/medium/agents/${d.id}`).expect(409);
  await request(ctx.app).put(`/api/framework-presets/medium/agents/${d.id}`).send({ name: 'changed' }).expect(409);
  await request(ctx.app).put(`/api/framework-presets/medium/agents/${d.id}`).send({ enabled: false }).expect(200);
  const next = (await ask('$after-disable').expect(200)).body.engagement;
  await request(ctx.app).post(`/api/engagements/${next.id}/verdict`).send({ approve: true, allocation }).expect(409);
  expect(ctx.internals.approvalStoreForTest.listBindings({ agent: 'fast-one' }).filter(b => b.active)).toHaveLength(1);
});

test('allocation choices reject foreign agents and reserved identity changes', async () => {
  await boot();
  const d = (await define('fast-one').expect(200)).body.definition;
  const e = (await ask('$first').expect(200)).body.engagement;
  const allocation = { kind: 'definition', definitionId: d.id };
  await request(ctx.app).post(`/api/engagements/${e.id}/verdict`).send({ approve: true, allocation }).expect(200);
  await request(ctx.app).post(`/api/engagements/${e.id}/verdict`).send({ approve: true, allocation: { kind: 'agent', agent: 'original' } }).expect(409);
  const other = (await request(ctx.app).post('/api/engagements').send({ project: 'foreign', projectRoomId: '!other:foreign.test',
    role: 'coding', requester: '@requester:foreign.test', requestedTokens: 1000, requestId: '$foreign' }).expect(200)).body.engagement;
  await request(ctx.app).post(`/api/engagements/${other.id}/verdict`).send({ approve: true, allocation }).expect(409);
  expect((await request(ctx.app).get('/api/engagements').expect(200)).body.engagements.find(x => x.id === e.id).agent).toBe('fast-one');
});

test('published capability resources disclose models and definitions without deployment secrets', async () => {
  await boot(); await define('fast-one').expect(200);
  await define('fast-tester', 'testing').expect(200);
  await request(ctx.app).put('/api/offers/coding').send({ published: true }).expect(200);
  await request(ctx.app).put('/api/framework-presets/medium/catalog').send({ published: true }).expect(200);
  const catalog = (await request(ctx.app).get(`/api/offer-book?projectRoomId=${encodeURIComponent(ROOM)}`).expect(200)).body;
  expect(catalog.roles).toHaveLength(1);
  expect(catalog.roles[0].resources).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.stringMatching(/^resource_[a-f0-9]{24}$/), name: 'Medium resource', model: 'gpt-5.6-sol', reasoning: 'medium' })]));
  expect(JSON.stringify(catalog)).not.toMatch(/private-model-key|presetId|apiKey|ownerDm|fast-tester|fast-one/);
});

test('two definitions share resource capacity and interrupted provisioning retains its choice', async () => {
  await boot();
  const one = (await define('fast-one').expect(200)).body.definition;
  const two = (await define('fast-two').expect(200)).body.definition;
  const e = (await ask('$one').expect(200)).body.engagement;
  const allocation = { kind: 'definition', definitionId: one.id };
  ctx.internals.setEngagementLauncherForTest(async () => { throw new Error('fixture launch interruption'); });
  await request(ctx.app).post(`/api/engagements/${e.id}/verdict`).send({ approve: true, allocation }).expect(503);
  const saved = (await request(ctx.app).get('/api/engagements').expect(200)).body.engagements.find(row => row.id === e.id);
  expect(saved).toMatchObject({ state: 'pending', agent: 'fast-one', fulfillment: { allocationChoice: allocation } });
  await request(ctx.app).post(`/api/engagements/${e.id}/verdict`).send({ approve: true, allocation: { kind: 'definition', definitionId: two.id } }).expect(409);
  ctx.internals.setEngagementLauncherForTest(async () => {});
  await request(ctx.app).post(`/api/engagements/${e.id}/verdict`).send({ approve: true, allocation }).expect(200);
  const next = (await ask('$two').expect(200)).body.engagement;
  await request(ctx.app).post(`/api/engagements/${next.id}/verdict`).send({ approve: true, allocatedTokens: 9500,
    allocation: { kind: 'definition', definitionId: two.id } }).expect(409);
  expect((await request(ctx.app).get('/api/agents').expect(200)).body.map(a => a.name)).not.toContain('fast-two');
  await request(ctx.app).post(`/api/engagements/${next.id}/verdict`).send({ approve: true,
    allocation: { kind: 'definition', definitionId: two.id } }).expect(200);
  expect((await request(ctx.app).get('/api/agents').expect(200)).body.map(a => a.name).sort()).toEqual(['fast-one', 'fast-two', 'original']);
});
