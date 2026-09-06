import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRouter, createRouterTaskStore } from '../router/dist/index.js';
const cleanups = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
function fixture({ start = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-task-lifecycle-'));
  const router = openRouter({ dbPath: path.join(root, 'router.db') });
  cleanups.push(() => { router.close(); rmSync(root, { recursive: true, force: true }); });
  router.ingestMessage({ messageId: 'input', roomId: '!room:test', matrixEventId: '$input', senderMxid: '@human:test', senderName: 'human', recipientAgentId: 'agent_worker', recipientAgentName: 'worker', normalizedBody: 'Implement and verify' });
  const task = router.createTaskIntent({ requestScope: 'test', requestKey: 'one', roomId: '!room:test', threadRootEventId: '$input', rootMessageId: 'input', inputMessageIds: ['input'], task: { title: 'Scoped work', assigneeAgentId: 'agent_worker', assigneeName: 'worker' } });
  const command = router.claimMatrixCommand();
  const active = router.recordMatrixDelivery({ commandId: command.commandId, claimToken: command.claimToken, eventId: '$ack' });
  router.registerWorkspace({ resourceId: 'work', safeLabel: 'test', backendPath: root });
  router.enqueueDispatch({ sessionId: active.sessionId, taskId: task.taskId, framework: 'claude', localServerId: 'local', workspaceResourceId: 'work', mayWrite: true, payload: {} });
  const claim = router.claimDispatch({ runnerId: 'runner', leaseMs: 60000, capabilityTtlMs: 60000, maxLiveRunners: 4 });
  if (start) expect(router.takePayload(claim).ok).toBe(true);
  const store = createRouterTaskStore(router);
  const other = store.createTask({ title: 'Private other task', assignee: 'worker' });
  const op = (action, patch = {}, extra = {}) => router.taskOperation({ ...claim, action, taskId: task.taskId, patch, toolCallId: action, ...extra });
  return { root, router, task, claim, store, other, op };
}
describe('capability scoped task lifecycle', () => {
  test('completes the bound task through structured operations', () => {
    const { op, task, store } = fixture();
    expect(op('get').task.status).toBe('in_progress');
    expect(op('list').tasks.map(t => t.id)).toEqual([task.taskId]);
    expect(op('execution', { heartbeat_at: true }).task.heartbeat_at).toEqual(expect.any(String));
    expect(op('comment', { text: 'Inner commit verified; acceptance 4/4', author: 'spoof' }).task.comments[0]).toMatchObject({ author: 'worker' });
    expect(op('transition', { status: 'blocked', waiting_reason: 'test dependency', waiting_until: '2026-10-01T00:00:00Z' }).task.status).toBe('blocked');
    expect(op('transition', { status: 'in_progress' }, { toolCallId: 'resume' }).task.status).toBe('in_progress');
    expect(op('transition', { status: 'done' }, { toolCallId: 'finish' }).task).toMatchObject({ status: 'done', completed_at: expect.any(String), waiting_reason: null });
    expect(store.getTask(task.taskId).comments).toHaveLength(1);
  });
  test('rejects other tasks and revoked or unstarted capabilities', () => {
    const { op, other, router, claim } = fixture();
    for (const action of ['get', 'comment', 'execution', 'transition']) expect(op(action, { text: 'bad', status: 'done' }, { taskId: other.id }).ok).toBe(false);
    expect(op('get', {}, { capability: 'wrong' }).ok).toBe(false);
    expect(op('get', {}, { fenceGeneration: claim.fenceGeneration + 1 }).ok).toBe(false);
    expect(router.settleAndRelease({ ...claim, outcome: 'completed', output: { text: 'done' } }).ok).toBe(true);
    expect(op('get').ok).toBe(false);
    const unstarted = fixture({ start: false });
    expect(unstarted.op('comment', { text: 'too soon' }).ok).toBe(false);
  });
  test('replays identical calls and refuses changed payloads', () => {
    const { op, store, task } = fixture();
    expect(op('comment', { text: 'verified' }).replayed).toBe(false);
    expect(op('comment', { text: 'verified' }).replayed).toBe(true);
    expect(op('comment', { text: 'different' })).toMatchObject({ ok: false, code: 'idempotency_conflict' });
    expect(store.getTask(task.taskId).comments).toHaveLength(1);
    expect(op('transition', { status: 'done' }).ok).toBe(true);
    expect(op('transition', { status: 'done' }).replayed).toBe(true);
  });
  test('keeps invalid transitions and plain completion from marking tasks done', () => {
    const { op, router, claim, task, store } = fixture();
    expect(op('accept').ok).toBe(false);
    expect(op('transition', { status: 'blocked' }).ok).toBe(false);
    expect(op('transition', { status: 'nonsense' }).ok).toBe(false);
    expect(router.settleAndRelease({ ...claim, outcome: 'completed', output: { text: 'All done!' } }).ok).toBe(true);
    expect(store.getTask(task.taskId).status).toBe('in_progress');
  });
  test('coordinator reads prior creations only in its own session and cannot mutate them', () => {
    const { router, root, task } = fixture();
    function front(messageId, roomId) {
      const input = router.ingestMessage({ messageId, roomId, matrixEventId: '$' + messageId, senderName: 'human', recipientAgentId: 'agent_manager', recipientAgentName: 'manager', normalizedBody: 'Coordinate' });
      router.registerWorkspace({ resourceId: 'front-' + roomId, safeLabel: 'front', backendPath: root });
      router.enqueueDispatch({ sessionId: input.session.sessionId, framework: 'claude', localServerId: 'local', workspaceResourceId: 'front-' + roomId, mayWrite: false, payload: {} });
      const cap = router.claimDispatch({ runnerId: 'runner-' + messageId, leaseMs: 60000, capabilityTtlMs: 60000, maxLiveRunners: 8 });
      expect(router.takePayload(cap).ok).toBe(true);
      return cap;
    }
    const original = front('front', '!front:test');
    const child = router.createTaskFromDispatch({ ...original, toolCallId: 'create', rootMessageId: 'front', inputMessageIds: [], task: { title: 'child', assigneeAgentId: 'agent_child', assigneeName: 'child' } });
    expect(child.ok).toBe(true);
    router.settleAndRelease({ ...original, outcome: 'completed' });
    const later = front('later', '!front:test');
    expect(router.taskOperation({ ...later, action: 'list' }).tasks.map(t => t.id)).toEqual([child.taskId]);
    expect(router.taskOperation({ ...later, action: 'get', taskId: child.taskId }).ok).toBe(true);
    expect(router.taskOperation({ ...later, action: 'transition', taskId: child.taskId, patch: { status: 'done' }, toolCallId: 'no' }).ok).toBe(false);
    expect(router.taskOperation({ ...later, action: 'get', taskId: task.taskId }).ok).toBe(false);
    const otherSession = front('other-front', '!other:test');
    expect(router.taskOperation({ ...otherSession, action: 'get', taskId: child.taskId }).ok).toBe(false);
    expect(router.taskOperation({ ...otherSession, action: 'list' }).tasks).toEqual([]);
  });
  test('receipt storage failure rolls back task changes and restart preserves retry receipts', () => {
    const { root, router, op, store, task, claim } = fixture();
    const beforeEvents = router.snapshot().highWatermark;
    router.db.exec("CREATE TEMP TRIGGER reject_receipt BEFORE INSERT ON runner_task_operations BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END");
    expect(() => op('comment', { text: 'must roll back' })).toThrow('injected receipt failure');
    expect(store.getTask(task.taskId).comments).toEqual([]);
    expect(router.snapshot().highWatermark).toBe(beforeEvents);
    router.db.exec('DROP TRIGGER reject_receipt');
    expect(op('comment', { text: 'persisted' }).ok).toBe(true);
    const reopened = openRouter({ dbPath: path.join(root, 'router.db') });
    try {
      expect(reopened.taskOperation({ ...claim, action: 'comment', taskId: task.taskId, toolCallId: 'comment', patch: { text: 'persisted' } }).replayed).toBe(true);
      expect(createRouterTaskStore(reopened).getTask(task.taskId).comments).toHaveLength(1);
    } finally { reopened.close(); }
  });

});
