import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouterTaskStore, openRouter } from '../router/dist/index.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('upgrades both version nine lineages without losing approval or task data', () => {
  for (const lineage of ['upstream-v9', 'workflow-v11']) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-schema-union-'));
    roots.push(root);
    const dbPath = path.join(root, 'router.db');
    let router = openRouter({ dbPath });
    try {
      router.ingestMessage({ messageId: 'input', roomId: '!room:test', matrixEventId: '$input', senderName: 'human', recipientAgentId: 'agent_worker', recipientAgentName: 'worker', normalizedBody: 'Work' });
      const task = router.createTaskIntent({ requestScope: 'test', requestKey: 'one', roomId: '!room:test', threadRootEventId: '$input', rootMessageId: 'input', inputMessageIds: ['input'], task: { title: 'Existing work', assigneeAgentId: 'agent_worker', assigneeName: 'worker' } });
      const command = router.claimMatrixCommand();
      const active = router.recordMatrixDelivery({ commandId: command.commandId, claimToken: command.claimToken, eventId: '$ack' });
      router.registerWorkspace({ resourceId: 'work', safeLabel: 'work', backendPath: root });
      router.enqueueDispatch({ sessionId: active.sessionId, taskId: task.taskId, framework: 'codex', localServerId: 'local', workspaceResourceId: 'work', mayWrite: true, payload: {} });
      const claim = router.claimDispatch({ runnerId: 'runner', leaseMs: 60000, capabilityTtlMs: 60000, maxLiveRunners: 4 });
      expect(router.takePayload(claim).ok).toBe(true);
      const operation = { ...claim, action: 'comment', taskId: task.taskId, toolCallId: 'old-comment', patch: { text: 'Pre-upgrade evidence' } };
      expect(router.taskOperation(operation).ok).toBe(true);
      const approval = { ...claim, approvalId: 'old-wait', operationDigest: 'digest', upstreamThreadId: 'thread', upstreamTurnId: 'turn', upstreamItemId: 'item', upstreamRequestId: '1', maxParkedRunners: 2 };
      expect(router.parkForApproval(approval).ok).toBe(true);
      if (lineage === 'upstream-v9') {
        // Frozen upstream v9 table shape; its migration 9 means task receipts,
        // and carries neither approval resume identity nor authorization epochs.
        router.db.exec(`CREATE TABLE legacy_approval_waits (
          approval_id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL REFERENCES dispatches(dispatch_id) ON DELETE CASCADE,
          operation_digest TEXT NOT NULL, upstream_thread_id TEXT, upstream_turn_id TEXT,
          upstream_item_id TEXT, upstream_request_id TEXT, created_at INTEGER NOT NULL,
          resolved_at INTEGER, decision TEXT, UNIQUE(dispatch_id, operation_digest));
          INSERT INTO legacy_approval_waits SELECT approval_id, dispatch_id, operation_digest,
            upstream_thread_id, upstream_turn_id, upstream_item_id, upstream_request_id,
            created_at, resolved_at, decision FROM approval_waits;
          DROP TABLE approval_waits;
          ALTER TABLE legacy_approval_waits RENAME TO approval_waits;
          DROP TRIGGER tasks_finish_execution_epoch;
          ALTER TABLE tasks DROP COLUMN execution_epoch;
          DELETE FROM router_schema_migrations WHERE version > 9;`);
      } else {
        router.db.exec(`DROP TABLE runner_task_operations;
          DELETE FROM router_schema_migrations WHERE version > 11;`);
      }
      router.close();
      router = openRouter({ dbPath });
      expect(router.db.prepare('SELECT resumed_at FROM approval_waits WHERE approval_id = ?').get('old-wait')).toEqual({ resumed_at: null });
      expect(router.recordApprovalDecision({ approvalId: 'old-wait', dispatchId: claim.dispatchId, operationDigest: 'digest', decisionEventId: 'owner', decision: 'allow' }).ok).toBe(true);
      expect(router.resumeAfterApproval(approval)).toEqual({ ok: true, decision: 'allow' });
      const replay = router.taskOperation({ ...operation, toolCallId: lineage === 'upstream-v9' ? 'old-comment' : 'new-comment' });
      expect(replay.ok).toBe(true);
      expect(replay.replayed).toBe(lineage === 'upstream-v9');
      expect(createRouterTaskStore(router).getTask(task.taskId).comments[0].text).toBe('Pre-upgrade evidence');
      expect(router.taskOperation({ ...claim, action: 'transition', taskId: task.taskId, toolCallId: 'done', patch: { status: 'done' } }).ok).toBe(true);
      expect(router.db.prepare('SELECT execution_epoch FROM tasks WHERE task_id = ?').get(task.taskId).execution_epoch).toBe(1);
      router.close();
      router = openRouter({ dbPath });
      expect(router.taskOperation({ ...claim, action: 'transition', taskId: task.taskId, toolCallId: 'done', patch: { status: 'done' } }).replayed).toBe(true);
      expect(router.db.prepare('SELECT execution_epoch FROM tasks WHERE task_id = ?').get(task.taskId).execution_epoch).toBe(1);
      expect(router.db.prepare('SELECT version FROM router_schema_migrations ORDER BY version DESC LIMIT 1').get()).toEqual({ version: 13 });
      expect(router.db.pragma('foreign_key_check')).toEqual([]);
    } finally { router.close(); }
  }
});
