import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

describe('runner task endpoint authorization', () => {
  let context, router, claim, taskId, headers;
  beforeAll(async () => {
    context = await createBackendTestContext('hafleet-task-endpoint-', {
      env: { HAFLEET_THREAD_SESSIONS: '1', HAFLEET_ROUTER_TASK_CUTOVER: '1', API_TOKEN: 'operator', HAFLEET_AGENT_TOKEN_MODE: 'hard' },
      agents: { worker: { name: 'worker', agentId: 'agent_worker', type: 'claude', kind: 'agent', role: 'coding', workdir: process.cwd(), online: true } },
      agentTokens: { worker: 'worker-token' },
    });
    router = context.internals.routerStoreForTest;
    router.ingestMessage({ messageId: 'root', roomId: '!task:test', matrixEventId: '$root', senderName: 'human', senderMxid: '@human:test', recipientAgentId: 'agent_worker', recipientAgentName: 'worker', normalizedBody: 'Build it' });
    const task = router.createTaskIntent({ requestScope: 'test', requestKey: 'root', roomId: '!task:test', threadRootEventId: '$root', rootMessageId: 'root', inputMessageIds: ['root'], task: { title: 'Endpoint work', assigneeAgentId: 'agent_worker', assigneeName: 'worker' } });
    taskId = task.taskId;
    const command = router.claimMatrixCommand();
    const active = router.recordMatrixDelivery({ commandId: command.commandId, claimToken: command.claimToken, eventId: '$ack' });
    router.registerWorkspace({ resourceId: 'work', safeLabel: 'work', backendPath: context.runtimeDir || process.cwd() });
    router.enqueueDispatch({ sessionId: active.sessionId, taskId, framework: 'claude', localServerId: 'local', workspaceResourceId: 'work', mayWrite: true, payload: {} });
    claim = router.claimDispatch({ runnerId: 'runner', leaseMs: 60000, capabilityTtlMs: 60000, maxLiveRunners: 4 });
    expect(router.takePayload(claim).ok).toBe(true);
    headers = { 'X-Agent-Token': 'worker-token', 'X-HAFleet-Dispatch-Capability': claim.capability, 'X-HAFleet-Dispatch-Id': claim.dispatchId, 'X-HAFleet-Runner-Id': claim.runnerId, 'X-HAFleet-Fence-Generation': String(claim.fenceGeneration) };
  });
  afterAll(() => { router?.close(); context?.cleanup(); });
  const call = (body, auth = headers) => request(context.app).post('/api/router/task-operations').set(auth).send({ agent: 'worker', task_id: taskId, ...body });
  test('requires capability even on loopback and with the agent token', async () => {
    expect((await call({ action: 'get' }, { 'X-Agent-Token': 'worker-token' })).status).toBe(401);
    expect((await call({ action: 'get' }, { ...headers, 'X-HAFleet-Dispatch-Capability': 'bad' })).status).toBeGreaterThanOrEqual(400);
    expect((await call({ action: 'get', agent: 'someone-else' })).status).toBeGreaterThanOrEqual(400);
    expect((await call({ action: 'get', task_id: 'another-task' })).status).toBeGreaterThanOrEqual(400);
  });
  test('rejects legacy mutations without a capability but preserves operator access', async () => {
    for (const [method, suffix, body] of [['post', 'accept', {}], ['post', 'transition', { status: 'done' }], ['patch', 'execution', { heartbeat_at: true }]]) {
      const response = await request(context.app)[method](`/api/tasks/${taskId}/${suffix}`).set('X-Agent-Token', 'worker-token').send(body);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('runner_capability_required');
    }
    const operator = await request(context.app).patch(`/api/tasks/${taskId}/execution`).set('Authorization', 'Bearer operator').send({ heartbeat_at: true });
    expect(operator.status).toBe(200);
    expect(router.snapshot().tasks.find(t => t.taskId === taskId).status).toBe('in_progress');
  });
  test('global task reads require operator authority in thread-session mode', async () => {
    for (const url of ['/api/tasks', `/api/tasks/${taskId}`, '/api/agents/worker/tasks']) {
      expect((await request(context.app).get(url)).status).toBe(403);
      expect((await request(context.app).get(url).set('X-Agent-Token', 'worker-token')).status).toBe(403);
      expect((await request(context.app).get(url).set('Authorization', 'Bearer operator')).status).toBe(200);
    }
  });
  test('records verification and completes without an operator credential', async () => {
    expect((await call({ action: 'get' })).body.task.status).toBe('in_progress');
    const comment = { action: 'comment', tool_call_id: 'verify', patch: { text: 'Independent test passed', author: 'operator' } };
    expect((await call(comment)).body.task.comments[0].author).toBe('worker');
    expect((await call(comment)).body.replayed).toBe(true);
    expect((await call({ ...comment, patch: { text: 'different' } })).status).toBe(409);
    expect((await call({ action: 'transition', tool_call_id: 'done', patch: { status: 'done' } })).body.task.status).toBe('done');
    expect(router.snapshot().tasks.find(t => t.taskId === taskId).status).toBe('done');
    expect(router.settleAndRelease({ ...claim, outcome: 'completed', output: { text: 'Result delivered separately' } }).ok).toBe(true);
    expect((await call({ action: 'get' })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('thread tasks without an operator token', () => {
  let context;
  beforeAll(async () => { context = await createBackendTestContext('hafleet-task-no-token-', { env: { HAFLEET_THREAD_SESSIONS: '1', HAFLEET_ROUTER_TASK_CUTOVER: '1', API_TOKEN: '' } }); });
  afterAll(() => { context?.internals.routerStoreForTest?.close(); context?.cleanup(); });
  test('global task mutations fail closed when operator credentials are absent', async () => {
    for (const [method, url, body] of [['post', '/api/tasks', { title: 'unauthorized' }], ['patch', '/api/tasks/private', { title: 'changed' }], ['delete', '/api/tasks/private', {}], ['post', '/api/tasks/private/comments', { text: 'injected' }]]) {
      expect((await request(context.app)[method](url).send(body)).status).toBe(403);
    }
  });
});
