import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

describe('operator task resume scheduling', () => {
  let context, errorSpy;
  beforeAll(async () => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    context = await createBackendTestContext('hagency-resume-scheduling-', {
      env: { HAGENCY_THREAD_SESSIONS: '1', HAGENCY_ROUTER_TASK_CUTOVER: '1',
        API_TOKEN: 'operator', HAGENCY_AGENT_TOKEN_MODE: 'hard',
        HAGENCY_CODEX_RUNNER_BIN: path.join(process.cwd(), 'tests/fixtures/runner-does-not-exist'),
        HAGENCY_RUNNER_LAUNCH_RETRY_MS: '60000' },
      agents: { worker: { name: 'worker', agentId: 'agent_worker', type: 'codex',
        kind: 'agent', role: 'coding', workdir: process.cwd(), workspaceMode: 'shared', online: true } },
      agentTokens: { worker: 'worker-token' },
    });
  });
  afterAll(() => {
    context?.internals.stopRouterPumpForTest();
    context?.internals.routerStoreForTest.close();
    context?.cleanup();
    errorSpy?.mockRestore();
  });
  test('operator resume starts queued work without another message', async () => {
    const router = context.internals.routerStoreForTest;
    router.ingestMessage({ messageId: 'resume-root', roomId: '!resume:test', matrixEventId: '$resume',
      senderName: 'human', senderMxid: '@human:test', recipientAgentId: 'agent_worker',
      recipientAgentName: 'worker', normalizedBody: 'Resume after reviewed recovery' });
    const intent = router.createTaskIntent({ requestScope: 'resume-test', requestKey: 'root',
      roomId: '!resume:test', threadRootEventId: '$resume', rootMessageId: 'resume-root',
      inputMessageIds: ['resume-root'], task: { title: 'Resume work', assigneeAgentId: 'agent_worker', assigneeName: 'worker' } });
    const command = router.claimMatrixCommand();
    const active = router.recordMatrixDelivery({ commandId: command.commandId, claimToken: command.claimToken, eventId: '$ack' });
    router.registerWorkspace({ resourceId: 'resume-work', safeLabel: 'resume workspace', backendPath: context.runtimeDir });
    const dispatch = { sessionId: active.sessionId, taskId: intent.taskId, framework: 'codex',
      localServerId: 'local', workspaceResourceId: 'resume-work', mayWrite: true, payload: {} };
    router.enqueueDispatch(dispatch);
    const claim = router.claimDispatch({ runnerId: 'first-runner', leaseMs: 60000, capabilityTtlMs: 60000, maxLiveRunners: 4 });
    expect(router.takePayload(claim).ok).toBe(true);
    const url = `/api/tasks/${intent.taskId}/transition`;
    expect((await request(context.app).post(url).set('Authorization', 'Bearer operator').send({
      status: 'blocked', waiting_reason: 'approval expired', waiting_until: '2026-10-01T00:00:00Z',
    })).status).toBe(200);
    expect(router.settleAndRelease({ ...claim, outcome: 'completed' }).ok).toBe(true);
    router.ingestMessage({ messageId: 'resume-followup', roomId: '!resume:test', matrixEventId: '$followup',
      threadRootEventId: '$resume', senderName: 'human', senderMxid: '@human:test',
      recipientAgentId: 'agent_worker', recipientAgentName: 'worker', normalizedBody: 'Permission reviewed, resume' });
    expect(router.attachTaskInputs({ taskId: intent.taskId, requestScope: 'resume-followup',
      requestKey: '$followup', messageIds: ['resume-followup'] }).ok).toBe(true);
    const queued = router.enqueueDispatch(dispatch);
    // One real pump observes the blocked task and sleeps. The transition must wake it.
    context.internals.scheduleRouterPumpForTest();
    await new Promise(resolve => setImmediate(resolve));
    const row = () => router.db.prepare('SELECT state, launch_failures FROM dispatches WHERE dispatch_id = ?').get(queued.dispatchId);
    expect(row()).toEqual({ state: 'queued', launch_failures: 0 });
    expect((await request(context.app).post(url).set('X-Agent-Token', 'worker-token').send({ status: 'in_progress' })).status).toBe(403);
    expect((await request(context.app).post(url).set('Authorization', 'Bearer operator').send({ status: 'done' })).status).toBe(400);
    expect(row()).toEqual({ state: 'queued', launch_failures: 0 });
    const resumed = await request(context.app).post(url).set('Authorization', 'Bearer operator').send({ status: 'in_progress' });
    expect(resumed.status).toBe(200);
    // Real missing executable proves admission occurred without any live provider.
    // LOOP-R1/R4: at most 400 iterations, each nonterminal iteration sleeps 25 ms.
    for (let poll = 0; poll < 400; poll++) {
      if (row().launch_failures === 1) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(row()).toEqual({ state: 'queued', launch_failures: 1 });
    expect(router.snapshot().tasks.find(t => t.taskId === intent.taskId).status).toBe('in_progress');
  });
});
