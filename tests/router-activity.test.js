import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRouter, runCodexDispatch, runClaudeDispatch } from '../router/dist/index.js';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(framework = 'codex') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hagency-activity-')); dirs.push(root);
  let now = Date.now();
  const options = { dbPath: path.join(root, 'router.db'), now: () => now };
  const router = openRouter(options);
  const message = router.ingestMessage({ messageId: 'root', roomId: '!room:test', matrixEventId: '$root',
    senderName: 'human', recipientAgentId: 'agent-id', recipientAgentName: 'edison', threadRootEventId: '$root', normalizedBody: 'work' });
  router.enqueueDispatch({ sessionId: message.session.sessionId, framework, localServerId: 'local', mayWrite: false, payload: { prompt: 'do work' } });
  const claim = router.claimDispatch({ runnerId: 'runner', leaseMs: 600_000, capabilityTtlMs: 600_000, maxLiveRunners: 8 });
  const cap = { dispatchId: claim.dispatchId, runnerId: claim.runnerId, fenceGeneration: claim.fenceGeneration, capability: claim.capability };
  return { router, root, claim, cap, options, advance: ms => { now += ms; } };
}
function delivered(router, eventId = '$status') {
  const command = router.claimReplyCommand();
  expect(command.activity).toBeDefined();
  expect(router.recordReplyDelivery({ commandId: command.commandId, claimToken: command.claimToken, eventId }).ok).toBe(true);
  return command;
}

test('activity coalesces retries and fences terminal or foreign writes', () => {
  const rig = setup(); let { router } = rig; const { cap } = rig;
  try {
    expect(router.takePayload(cap).ok).toBe(true);
    expect(router.acknowledgeRunnerEffect(cap).ok).toBe(true);
    const first = router.claimReplyCommand(1000);
    router.close(); router = openRouter(rig.options); rig.advance(1001);
    const retry = router.claimReplyCommand();
    expect(retry.transactionId).toBe(first.transactionId);
    expect(retry.activity.replaceEventId).toBe(null);
    expect(router.recordReplyDelivery({ commandId: retry.commandId, claimToken: first.claimToken, eventId: '$wrong' }).ok).toBe(false);
    expect(router.recordReplyDelivery({ commandId: retry.commandId, claimToken: retry.claimToken, eventId: '$status' }).ok).toBe(true);
    for (let i = 0; i < 100; i++) {
      const event = { phase: 'tool_start', kind: 'command', eventId: 'same-item' };
      expect(router.recordRunnerActivity({ ...cap, event }).ok).toBe(true);
    }
    const tool = delivered(router, '$edit1');
    expect(tool).toMatchObject({ roomId: '!room:test', threadRootEventId: '$root', senderAgentName: 'edison', activity: { replaceEventId: '$status' } });
    expect(tool.body).toContain('工具调用 1 次');
    expect(router.recordRunnerActivity({ ...cap, capability: 'foreign', event: { phase: 'heartbeat' } }).ok).toBe(false);
    for (let i = 0; i < 50; i++) router.recordRunnerActivity({ ...cap, event: { phase: 'tool_end', kind: 'command', eventId: `end-${i}` } });
    expect(router.claimReplyCommand()).toBe(null);
    rig.advance(30_000);
    router.recordRunnerActivity({ ...cap, event: { phase: 'heartbeat' } });
    expect(delivered(router, '$edit2').activity.replaceEventId).toBe('$status');
    router.settleAndRelease({ ...cap, outcome: 'completed', output: { text: 'answer' } });
    const answer = router.claimReplyCommand(); expect(answer.body).toBe('answer');
    router.recordReplyDelivery({ commandId: answer.commandId, claimToken: answer.claimToken, eventId: '$answer' });
    expect(delivered(router, '$finished').body).toContain('本轮处理已结束');
    expect(router.recordRunnerActivity({ ...cap, event: { phase: 'heartbeat' } }).ok).toBe(false);
    expect(router.claimReplyCommand()).toBe(null);
  } finally { router.close(); }
});

test('activity reflects approval parking resumption and terminal state', () => {
  const { router, cap, advance } = setup();
  try {
    router.takePayload(cap); router.acknowledgeRunnerEffect(cap); delivered(router);
    expect(router.parkForApproval({ ...cap, approvalId: 'approval', operationDigest: 'digest', maxParkedRunners: 4 }).ok).toBe(true);
    expect(delivered(router, '$waiting').body).toContain('等待负责人授权');
    advance(30_000);
    expect(router.recordRunnerActivity({ ...cap, event: { phase: 'heartbeat' } }).ok).toBe(false);
    expect(router.claimReplyCommand()).toBe(null);
    router.recordApprovalDecision({ decisionEventId: '$owner', approvalId: 'approval', dispatchId: cap.dispatchId, operationDigest: 'digest', decision: 'deny' });
    expect(router.resumeAfterApproval({ ...cap, approvalId: 'approval', operationDigest: 'digest' }).ok).toBe(true);
    expect(delivered(router, '$resumed').body).toContain('已收到审批决定');
    router.markOutcomeUnknown(cap.dispatchId, 'private command and path must not appear in status');
    const commands = [];
    for (let command; (command = router.claimReplyCommand());) {
      commands.push(command);
      router.recordReplyDelivery({ commandId: command.commandId, claimToken: command.claimToken, eventId: `$e${commands.length}` });
    }
    expect(commands.find(c => c.activity).body).toContain('执行已中断');
    expect(JSON.stringify(commands)).not.toContain('private command');
  } finally { router.close(); }
});

test('two agents in one thread retain separate status anchors', () => {
  const { router, cap } = setup();
  try {
    router.takePayload(cap); router.acknowledgeRunnerEffect(cap); delivered(router, '$edison-status');
    const message = router.ingestMessage({ messageId: 'second', roomId: '!room:test', matrixEventId: '$same-human-input', threadRootEventId: '$root',
      senderName: 'human', recipientAgentId: 'second-agent-id', recipientAgentName: 'coding', normalizedBody: 'both work' });
    router.enqueueDispatch({ sessionId: message.session.sessionId, framework: 'codex', localServerId: 'local', mayWrite: false, payload: {} });
    const second = router.claimDispatch({ runnerId: 'second-runner', leaseMs: 60_000, capabilityTtlMs: 60_000, maxLiveRunners: 8 });
    router.takePayload(second); router.acknowledgeRunnerEffect(second); delivered(router, '$coding-status');
    for (const c of [cap, second]) router.recordRunnerActivity({ ...c, event: { phase: 'tool_start', kind: 'command', eventId: 'same-tool-id' } });
    const updates = [delivered(router, '$one-edit'), delivered(router, '$two-edit')];
    expect(updates.map(c => [c.senderAgentName, c.activity.replaceEventId]).sort()).toEqual([
      ['coding', '$coding-status'], ['edison', '$edison-status'],
    ]);
    expect(updates.every(c => c.roomId === '!room:test' && c.threadRootEventId === '$root')).toBe(true);
    expect(router.db.prepare('SELECT COUNT(*) AS n FROM session_messages WHERE message_id LIKE ?').get('notice_%').n).toBe(0);
  } finally { router.close(); }
});

test('Codex and Claude tool events publish redacted progress before the final answer', async () => {
  for (const framework of ['codex', 'claude']) {
    const { router, root, claim } = setup(framework);
    const seen = []; let polling;
    try {
      polling = setInterval(() => {
        for (let c; (c = router.claimReplyCommand());) {
          seen.push(c);
          router.recordReplyDelivery({ commandId: c.commandId, claimToken: c.claimToken, eventId: `$seen-${seen.length}` });
        }
      }, 10);
      const run = framework === 'codex' ? runCodexDispatch : runClaudeDispatch;
      const result = await run({ router, claim, cwd: root,
        executable: path.resolve(`tests/fixtures/fake-${framework === 'codex' ? 'codex-app-server' : 'claude-runner'}.mjs`),
        env: { FAKE_CODEX_ACTIVITY: '1', FAKE_CLAUDE_ACTIVITY: '1' },
        approvalTimeoutMs: 5000, maxParkedRunners: 4,
        requestOwnerApproval: async () => ({ decisionEventId: 'owner-decision', decision: 'allow' }),
      });
      expect(result.state).toBe('completed');
      const tools = seen.filter(c => c.activity && c.body.includes('正在运行命令'));
      expect(tools.length).toBeGreaterThan(0);
      expect(tools[0].body).toContain('工具调用 1 次');
      expect(router.db.prepare('SELECT tools, finished FROM runner_activity WHERE dispatch_id = ?').get(claim.dispatchId)).toEqual({ tools: 1, finished: 1 });
      expect(JSON.stringify(seen)).not.toMatch(/SECRET|secret-path|raw-output/);
    } finally { clearInterval(polling); router.close(); }
  }
});
