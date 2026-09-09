import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const AGENT_TOKEN = 'projection-agent-token';
const BRIDGE_SECRET = 'projection-bridge-secret';
let context;
let approvalId;

function bridge(method, url) {
  return request(context.app)[method](url).set('X-Bridge-Secret', BRIDGE_SECRET);
}

beforeAll(async () => {
  context = await createBackendTestContext('hafleet-projection-api-', {
    agents: { worker: { name: 'worker', type: 'agent', kind: 'agent', online: true } },
    agentTokens: { worker: AGENT_TOKEN },
    env: { MATRIX_BRIDGE_SECRET: BRIDGE_SECRET, HAFLEET_AGENT_TOKEN_MODE: 'hard' },
  });
  await bridge('put', '/api/approval-bindings').send({
    agent: 'worker', project: 'p', project_room_id: '!p:test',
    owner_mxid: '@owner:test', owner_dm_room_id: '!dm:test',
  });
  const created = await request(context.app).post('/api/approvals')
    .set('X-Agent-Token', AGENT_TOKEN)
    .send({ agent: 'worker', runtime: 'codex', project: 'p', project_room_id: '!p:test', upstream_request_id: 'u', tool_name: 'Bash', input_preview: 'pwd' });
  approvalId = created.body.approval.id;
});

afterAll(() => context.cleanup());

describe('approval projection bridge API', () => {
  test('committed create verdict and consume transitions emit increasing redacted wakes', async () => {
    const frames = [];
    const client = { write: (frame) => frames.push(frame) };
    context.internals.sseAdapterForTest.clients.add(client);
    try {
      const created = await request(context.app).post('/api/approvals')
        .set('X-Agent-Token', AGENT_TOKEN)
        .send({ agent: 'worker', runtime: 'codex', project: 'p', project_room_id: '!p:test', upstream_request_id: 'u-wakes', tool_name: 'Bash', input_preview: 'pwd' });
      expect(created.status).toBe(201);
      const id = created.body.approval.id;
      const matrix = (await bridge('get', `/api/approvals/${id}/matrix`)).body.approval;
      const verdict = await bridge('post', `/api/approvals/${id}/verdict`).send({
        action: 'approve_once', sender_mxid: matrix.owner_mxid, room_id: matrix.owner_dm_room_id,
        agent: matrix.agent, project: matrix.project, project_room_id: matrix.project_room_id,
        input_digest: matrix.input_digest,
      });
      expect(verdict.status).toBe(200);
      const consumed = await request(context.app).post(`/api/approvals/${id}/consume`)
        .set('X-Agent-Token', AGENT_TOKEN)
        .send({ agent: 'worker', input_digest: matrix.input_digest });
      expect(consumed.status).toBe(200);
      const changes = frames.filter((frame) => frame.startsWith('event: approval_changed'))
        .map((frame) => JSON.parse(frame.split('\ndata: ')[1]))
        .filter((payload) => payload.request_id === id);
      expect(changes).toEqual([
        { request_id: id, revision: 1 },
        { request_id: id, revision: 2 },
        { request_id: id, revision: 3 },
      ]);
    } finally {
      context.internals.sseAdapterForTest.clients.delete(client);
    }
  });

  test('bounded maintenance emits redacted wake hints for durable due work', () => {
    const frames = [];
    const client = { write: (frame) => frames.push(frame) };
    context.internals.sseAdapterForTest.clients.add(client);
    try {
      const result = context.internals.runApprovalProjectionMaintenanceForTest();
      expect(result).toMatchObject({ skipped: false });
      expect(result.wakes).toBeGreaterThan(0);
      const wakeFrames = frames.filter((frame) => frame.startsWith('event: approval_changed'));
      expect(wakeFrames.length).toBeGreaterThan(0);
      for (const frame of wakeFrames) {
        const payload = JSON.parse(frame.split('\ndata: ')[1]);
        expect(payload).toEqual({ request_id: expect.any(String), revision: expect.any(Number) });
      }
    } finally {
      context.internals.sseAdapterForTest.clients.delete(client);
    }
  });

  test('projection listing is bridge-secret only and keeps metadata out of agent response', async () => {
    expect((await request(context.app).get('/api/approvals/matrix/projections')).status).toBe(403);
    expect((await request(context.app).get('/api/approvals/matrix/projections').set('X-Agent-Token', AGENT_TOKEN)).status).toBe(403);
    const listed = await bridge('get', '/api/approvals/matrix/projections?limit=200');
    expect(listed.status).toBe(200);
    expect(listed.body.projections).toContainEqual(expect.objectContaining({ request_id: approvalId, revision: 1 }));
    const createdSecond = await request(context.app).post('/api/approvals')
      .set('X-Agent-Token', AGENT_TOKEN)
      .send({ agent: 'worker', runtime: 'codex', project: 'p', project_room_id: '!p:test', upstream_request_id: 'u-page-2', tool_name: 'Bash', input_preview: 'pwd' });
    expect(createdSecond.status).toBe(201);
    const firstPage = await bridge('get', '/api/approvals/matrix/projections?limit=1');
    const secondPage = await bridge('get', `/api/approvals/matrix/projections?limit=1&after=${encodeURIComponent(firstPage.body.next)}`);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.projections).toHaveLength(1);
    expect(secondPage.body.projections[0].cursor).not.toBe(firstPage.body.projections[0].cursor);
    expect((await bridge('get', '/api/approvals/matrix/projections?after=not-a-cursor')).status).toBe(400);
    const agentView = await request(context.app).get(`/api/approvals/${approvalId}`).set('X-Agent-Token', AGENT_TOKEN);
    expect(agentView.body.approval).not.toHaveProperty('projection_revision');
    expect(agentView.body.approval).not.toHaveProperty('plan');
  });

  test('page cursor survives receipt of its anchor row', async () => {
    const first = await bridge('get', '/api/approvals/matrix/projections?limit=1');
    expect(first.status).toBe(200);
    const row = first.body.projections[0];
    const prepared = await bridge('post', `/api/approvals/${row.request_id}/matrix/projections/${row.revision}/prepare`).send({
      cas_token: row.cas_token, channel: row.channel, publisher_mxid: '@bot:test', homeserver: 'test',
      credential_kind: 'local_bot', credential_generation: 'cursor-g', payload_version: 1,
      prepared_event_type: 'm.room.message', prepared_payload: { body: 'cursor' },
    });
    const plan = prepared.body.plan;
    const identity = { cas_token: plan.cas_token, channel: row.channel, publisher_mxid: plan.publisher_mxid,
      room_id: row.target_room_id, credential_generation: plan.credential_generation, transaction_id: plan.transaction_id };
    expect((await bridge('post', `/api/approvals/${row.request_id}/matrix/projections/${row.revision}/begin-send`).send(identity)).status).toBe(200);
    expect((await bridge('post', `/api/approvals/${row.request_id}/matrix/projections/${row.revision}/receipt`).send({ ...identity, event_id: '$cursor-anchor' })).status).toBe(200);
    const next = await bridge('get', `/api/approvals/matrix/projections?limit=1&after=${encodeURIComponent(first.body.next)}`);
    expect(next.status).toBe(200);
    expect(next.body.projections).toHaveLength(1);
    expect(next.body.projections[0].cursor).not.toBe(first.body.next);
  });

  test('listing expires first and returns one coherent committed projection', async () => {
    const store = context.internals.approvalStoreForTest;
    const originalNow = store.now;
    try {
      const created = await request(context.app).post('/api/approvals')
        .set('X-Agent-Token', AGENT_TOKEN)
        .send({ agent: 'worker', runtime: 'codex', project: 'p', project_room_id: '!p:test', upstream_request_id: 'u-expiry-list', tool_name: 'Bash' });
      store.now = () => created.body.approval.expires_at + 1;
      const listed = await bridge('get', '/api/approvals/matrix/projections?limit=200');
      const row = listed.body.projections.find((item) => item.request_id === created.body.approval.id);
      expect(row).toMatchObject({ revision: 2, state: 'expired', approval: { status: 'expired' } });
    } finally {
      store.now = originalNow;
    }
  });

  test('maintenance contains persistence failure and a later tick recovers', async () => {
    const store = context.internals.approvalStoreForTest;
    const originalNow = store.now;
    const originalFault = store.fsFault;
    const frames = [];
    const client = { write: (frame) => frames.push(frame) };
    context.internals.sseAdapterForTest.clients.add(client);
    try {
      const created = await request(context.app).post('/api/approvals')
        .set('X-Agent-Token', AGENT_TOKEN)
        .send({ agent: 'worker', runtime: 'codex', project: 'p', project_room_id: '!p:test', upstream_request_id: 'u-maintenance-retry', tool_name: 'Bash' });
      store.now = () => created.body.approval.expires_at + 1;
      store.fsFault = (phase) => { if (phase === 'beforeRename') throw new Error('fixture maintenance failure'); };
      expect(context.internals.runApprovalProjectionMaintenanceForTest()).toMatchObject({ ok: false, error_code: 'persistence_failed' });
      expect(store.getProjectionRevision(created.body.approval.id)).toBe(1);
      expect(frames.filter((frame) => frame.startsWith('event: approval_changed'))).toHaveLength(1);
      store.fsFault = () => {};
      expect(context.internals.runApprovalProjectionMaintenanceForTest()).toMatchObject({ ok: true, expiry: { expired: 1 } });
      expect(store.getProjectionRevision(created.body.approval.id)).toBe(2);
    } finally {
      store.now = originalNow;
      store.fsFault = originalFault;
      context.internals.sseAdapterForTest.clients.delete(client);
    }
  });

  test('prepare begin retry and receipt preserve exact route and plan CAS', async () => {
    const created = await request(context.app).post('/api/approvals')
      .set('X-Agent-Token', AGENT_TOKEN)
      .send({ agent: 'worker', runtime: 'codex', project: 'p', project_room_id: '!p:test', upstream_request_id: 'u-plan-flow', tool_name: 'Bash' });
    const requestId = created.body.approval.id;
    const listed = await bridge('get', '/api/approvals/matrix/projections?limit=20');
    const row = listed.body.projections.find((projection) => projection.request_id === requestId);
    const prepareInput = {
      cas_token: row.cas_token, publisher_mxid: '@bot:test', homeserver: 'test',
      credential_kind: 'local_bot', credential_generation: 'g1', payload_version: 1,
      channel: row.channel, prepared_event_type: 'm.room.message', prepared_payload: { body: 'approval' },
    };
    expect((await bridge('post', `/api/approvals/${requestId}/matrix/projections/2/prepare`).send(prepareInput)).status).toBe(409);
    expect((await bridge('post', `/api/approvals/${requestId}/matrix/projections/1/prepare`).send({ ...prepareInput, channel: 'private_status' })).status).toBe(409);
    const prepared = await bridge('post', `/api/approvals/${requestId}/matrix/projections/1/prepare`).send(prepareInput);
    expect(prepared.status).toBe(200);
    const plan = prepared.body.plan;
    const identity = { cas_token: plan.cas_token, channel: row.channel, publisher_mxid: plan.publisher_mxid, room_id: row.target_room_id, credential_generation: plan.credential_generation, transaction_id: plan.transaction_id };
    expect((await bridge('post', `/api/approvals/wrong/matrix/projections/1/begin-send`).send(identity)).status).toBe(409);
    expect((await bridge('post', `/api/approvals/${requestId}/matrix/projections/1/begin-send`).send({ ...identity, channel: 'private_status' })).status).toBe(409);
    expect((await bridge('post', `/api/approvals/${requestId}/matrix/projections/1/begin-send`).send(identity)).body.plan.attempt_state).toBe('attempted');
    const retried = await bridge('post', `/api/approvals/${requestId}/matrix/projections/1/retry`).send({ ...identity, retry_at: Date.now(), error_code: 'timeout' });
    expect(retried.body.attempt_state).toBe('uncertain');
    const receipt = await bridge('post', `/api/approvals/${requestId}/matrix/projections/1/receipt`).send({ ...identity, event_id: '$projection' });
    expect(receipt.body).toMatchObject({ ok: true, event_id: '$projection' });
  });
});
