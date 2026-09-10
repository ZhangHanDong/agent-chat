import { afterEach, expect, test } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

let ctx;
afterEach(async () => { await ctx?.cleanup(); ctx = null; });
const operator = { Authorization: 'Bearer fixture-operator' };
const agentHeaders = { 'X-Agent-Token': 'fixture-agent-token' };

test('execution policy and grant management reject agent credentials and preserve defaults', async () => {
  ctx = await createBackendTestContext('execution-api-', {
    agents: {
      edison: { name: 'edison', kind: 'agent', type: 'codex', agentId: 'agent_edison', registeredAt: 11, presetId: 'pool' },
      other: { name: 'other', kind: 'agent', type: 'codex', agentId: 'agent_other', registeredAt: 12 },
      claude: { name: 'claude', kind: 'agent', type: 'claude', agentId: 'agent_claude', registeredAt: 13 },
    },
    agentTokens: { edison: 'fixture-agent-token' },
    frameworkPresets: [{ id: 'pool', name: 'Pool', framework: 'codex', model: 'gpt-5.6-sol' }],
    env: { API_TOKEN: 'fixture-operator', HAGENCY_AGENT_TOKEN_MODE: 'hard' },
  });
  const endpoint = '/api/agents/edison/execution-policy';
  for (const headers of [{}, agentHeaders]) {
    expect((await request(ctx.app).get(endpoint).set(headers)).status).toBe(401);
    expect((await request(ctx.app).put(endpoint).set(headers).send({ executionPolicy: { yolo: true } })).status).toBe(401);
  }
  expect((await request(ctx.app).get(endpoint).set(operator).expect(200)).body.executionPolicy).toEqual({ yolo: false });
  await request(ctx.app).put('/api/framework-presets/pool').set(operator)
    .send({ name: 'Pool', framework: 'codex', model: 'gpt-5.6-sol', executionPolicy: { yolo: true } }).expect(200);
  expect((await request(ctx.app).get(endpoint).set(operator).expect(200)).body.executionPolicy.yolo).toBe(false);
  await request(ctx.app).put('/api/framework-presets/pool').set(operator)
    .send({ name: 'Renamed', framework: 'codex', model: 'gpt-5.6-sol' }).expect(200);
  expect((await request(ctx.app).get('/api/framework-presets').set(operator).expect(200)).body
    .find(p => p.id === 'pool').executionPolicy.yolo).toBe(true);
  for (const yolo of [true, false]) {
    await request(ctx.app).put(endpoint).set(operator).send({ executionPolicy: { yolo } }).expect(200);
    const stored = JSON.parse(readFileSync(path.join(ctx.runtimeDir, 'data/agents.json'), 'utf8'));
    expect(stored.edison.executionPolicy).toEqual({ yolo });
    const publicAgents = (await request(ctx.app).get('/api/agents').expect(200)).body;
    expect(publicAgents.find(agent => agent.name === 'edison')).not.toHaveProperty('executionPolicy');
    expect((await request(ctx.app).get('/api/agents/edison').expect(200)).body).not.toHaveProperty('executionPolicy');
  }
  await request(ctx.app).put(endpoint).set(operator).send({ executionPolicy: { yolo: 'false' } }).expect(400);
  await request(ctx.app).put('/api/agents/claude/execution-policy').set(operator).send({ executionPolicy: { yolo: true } }).expect(400);
  const store = ctx.internals.approvalStoreForTest;
  store.upsertBinding({ agent: 'edison', project: 'physics', project_room_id: '!project:test',
    owner_mxid: '@owner:test', owner_dm_room_id: '!private:test' });
  const pending = store.createRequest({ agent: 'edison', runtime: 'codex', project_room_id: '!project:test',
    upstream_request_id: 'native-1', tool_name: 'app_server_command', description: 'Read report', input_preview: 'cat report' },
  { execution: { agentId: 'agent_edison:11', workspace: '/work/edison', mayWrite: true,
    method: 'item/commandExecution/requestApproval', params: { command: 'cat report', cwd: '/work/edison' } } });
  expect(store.submitMatrixVerdict(pending.id, { sender_mxid: pending.owner_mxid, room_id: pending.owner_dm_room_id,
    agent: pending.agent, project: pending.project, project_room_id: pending.project_room_id, input_digest: pending.input_digest,
    action: 'approve_always', event_id: '$decision' }).ok).toBe(true);
  const grants = (await request(ctx.app).get(endpoint).set(operator).expect(200)).body.grants;
  expect(grants).toHaveLength(1); expect(grants[0].active).toBe(true);
  const assertPublic = grant => {
    for (const key of ['ownerDmRoomId', 'workspace', 'sourceRequestId', 'sourceEventId', 'scopeKey', 'bindingAuthority']) {
      expect(grant).not.toHaveProperty(key);
    }
    expect(JSON.stringify(grant)).not.toContain('!private:test');
    expect(grant).toMatchObject({ scope: 'always', project: 'physics', ownerMxid: '@owner:test' });
  };
  assertPublic(grants[0]);
  const revoke = `/api/agents/edison/execution-grants/${grants[0].id}`;
  await request(ctx.app).delete(revoke).set(agentHeaders).expect(401);
  await request(ctx.app).delete(`/api/agents/other/execution-grants/${grants[0].id}`).set(operator).expect(404);
  assertPublic((await request(ctx.app).delete(revoke).set(operator).expect(200)).body.grant);
  expect((await request(ctx.app).get(endpoint).set(operator).expect(200)).body.grants[0].active).toBe(false);
  expect(store.consumeDecision(pending.id, 'edison', pending.input_digest).decision).toBe('deny');
});
