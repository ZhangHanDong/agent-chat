import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

describe('approval notice thread provenance', () => {
  let context, router, approvals, upstream;
  beforeAll(async () => {
    context = await createBackendTestContext('hafleet-approval-thread-', {
      env: { HAFLEET_THREAD_SESSIONS: '1', HAFLEET_ROUTER_TASK_CUTOVER: '1',
        MATRIX_BRIDGE_SECRET: 'bridge-secret', HAFLEET_AGENT_TOKEN_MODE: 'hard' },
      agents: Object.fromEntries(['worker', 'other'].map(name => [name, {
        name, agentId: `agent_${name}`, type: 'claude', kind: 'agent', role: 'coding',
        workdir: process.cwd(), online: true,
      }])),
      agentTokens: { worker: 'worker-token', other: 'other-token' },
    });
    router = context.internals.routerStoreForTest;
    approvals = context.internals.approvalStoreForTest;
    for (const [agent, room] of [['worker', '!project:test'], ['worker', '!other:test'], ['other', '!project:test']]) {
      approvals.upsertBinding({ agent, project: 'project', project_room_id: room,
        owner_mxid: '@owner:test', owner_dm_room_id: '!owner:test' });
    }
    const ingested = router.ingestMessage({ messageId: 'request', roomId: '!project:test', matrixEventId: '$request',
      threadRootEventId: '$original-thread', senderName: 'owner', senderMxid: '@owner:test',
      recipientAgentId: 'agent_worker', recipientAgentName: 'worker', normalizedBody: 'Run the task' });
    router.registerWorkspace({ resourceId: 'workspace', safeLabel: 'workspace', backendPath: context.runtimeDir });
    router.enqueueDispatch({ sessionId: ingested.session.sessionId, framework: 'claude', localServerId: 'local',
      workspaceResourceId: 'workspace', mayWrite: false, payload: {} });
    const claim = router.claimDispatch({ runnerId: 'runner', leaseMs: 60000, capabilityTtlMs: 60000, maxLiveRunners: 4 });
    expect(router.takePayload(claim).ok).toBe(true);
    const response = await request(context.app).post('/api/router/approvals/claude').set({
      'X-Agent-Token': 'worker-token', 'X-HAFleet-Dispatch-Capability': claim.capability,
      'X-HAFleet-Dispatch-Id': claim.dispatchId, 'X-HAFleet-Runner-Id': claim.runnerId,
      'X-HAFleet-Fence-Generation': String(claim.fenceGeneration),
    }).send({ agent: 'worker', request_id: 'native-1', tool_name: 'Bash',
      description: 'Inspect this task', input_preview: 'private command', thread_root_event_id: '$forged' });
    expect(response.status).toBe(201);
    upstream = response.body.approval;
  });
  afterAll(() => { context?.internals.stopRouterPumpForTest(); router?.close(); context?.cleanup(); });
  const matrix = id => request(context.app).get(`/api/approvals/${id}/matrix`).set('X-Bridge-Secret', 'bridge-secret');

  test('binds public approval status to the persisted runner thread', async () => {
    const response = await matrix(upstream.id);
    expect(response.status).toBe(200);
    expect(response.body.approval.thread_root_event_id).toBe('$original-thread');
    expect(response.body.approval.input_preview).toBe('private command');
  });

  test('does not infer a thread from another agent room or legacy request', async () => {
    const conflict = await request(context.app).post('/api/approvals')
      .set('X-Agent-Token', 'worker-token')
      .send({ agent: 'worker', runtime: 'claude', project_room_id: '!project:test',
        upstream_request_id: upstream.upstream_request_id, tool_name: 'Bash', input_preview: 'pending legacy reuse' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('conflict');
    // Finish the first store request so its pending idempotency key does not
    // intentionally return the original record for the wrong-room fixture.
    approvals.denyPending(upstream.id, 'fixture-complete');
    for (const [agent, room, upstreamId] of [
      ['other', '!project:test', upstream.upstream_request_id],
      ['worker', '!other:test', upstream.upstream_request_id],
      ['worker', '!project:test', 'legacy-native-request'],
    ]) {
      const created = approvals.createRequest({ agent, runtime: 'claude', project_room_id: room,
        upstream_request_id: upstreamId, tool_name: 'Bash', input_preview: 'other command' });
      expect(created.agent).toBe(agent);
      expect(created.project_room_id).toBe(room);
      const response = await matrix(created.id);
      expect(response.status).toBe(200);
      expect(response.body.approval.thread_root_event_id).toBeNull();
    }
    const reused = await request(context.app).post('/api/approvals')
      .set('X-Agent-Token', 'worker-token')
      .send({ agent: 'worker', runtime: 'claude', project_room_id: '!project:test',
        upstream_request_id: upstream.upstream_request_id, tool_name: 'Bash', input_preview: 'legacy reuse' });
    expect(reused.status).toBe(201);
    expect(reused.body.approval.id).not.toBe(upstream.id);
    expect((await matrix(reused.body.approval.id)).body.approval.thread_root_event_id).toBeNull();
    expect((await request(context.app).get(`/api/approvals/${upstream.id}/matrix`)).status).toBe(403);
  });
});

test('legacy deployments publish approval notices without a router', async () => {
  const context = await createBackendTestContext('hafleet-approval-no-router-', {
    env: { HAFLEET_THREAD_SESSIONS: '0', HAFLEET_ROUTER_TASK_CUTOVER: '0', HAFLEET_ROUTER_SHADOW: '0',
      MATRIX_BRIDGE_SECRET: 'bridge-secret' },
    agents: { worker: { name: 'worker', agentId: 'agent_worker', type: 'claude', kind: 'agent' } },
  });
  try {
    expect(context.internals.routerStoreForTest).toBeNull();
    const store = context.internals.approvalStoreForTest;
    store.upsertBinding({ agent: 'worker', project: 'project', project_room_id: '!project:test',
      owner_mxid: '@owner:test', owner_dm_room_id: '!owner:test' });
    const approval = store.createRequest({ agent: 'worker', runtime: 'claude', project_room_id: '!project:test',
      upstream_request_id: 'legacy', tool_name: 'Bash' });
    const response = await request(context.app).get(`/api/approvals/${approval.id}/matrix`).set('X-Bridge-Secret', 'bridge-secret');
    expect(response.status).toBe(200);
    expect(response.body.approval.thread_root_event_id).toBeNull();
  } finally { context.cleanup(); }
});
