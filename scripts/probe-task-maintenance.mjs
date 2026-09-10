#!/usr/bin/env node
// Opt-in real Codex smoke, separate from deterministic/offline Vitest coverage.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackendTestContext } from '../tests/helpers/backend-test-runtime.js';
import { runCodexDispatch } from '../router/dist/index.js';

const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const output = option('--output', null);
if (!args.includes('--live') || !output || !path.isAbsolute(output)) {
  console.error('usage: probe-task-maintenance.mjs --live --output <new absolute directory> [--model <model>]');
  process.exit(2);
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.cwd(), repo, 'run from the source checkout');
mkdirSync(output, { mode: 0o700 }); // refuse to overwrite an earlier probe
const workdir = path.join(output, 'workdir');
mkdirSync(path.join(workdir, 'docs'), { recursive: true });
mkdirSync(path.join(workdir, 'projects', 'maintenance'), { recursive: true });
// Preserve the old home-wrapper instruction as a real integration counterexample.
writeFileSync(path.join(workdir, 'AGENTS.md'), readFileSync(path.join(repo, 'AGENTS.md')));
for (const file of ['agent-knowledge.md', 'plan.md', 'progress.md']) writeFileSync(path.join(workdir, 'docs', file), 'Isolated task-maintenance probe.\n');
writeFileSync(path.join(workdir, 'docs/projects.md'), 'Own projects/maintenance (copy). This is the only code tree for the probe.\n');
writeFileSync(path.join(workdir, 'task-writer'), '#!/bin/sh\ntouch "$(dirname "$0")/.shell-task-writer-used"\nexit 97\n', { mode: 0o700 });

const name = 'maintenance-probe';
const token = randomBytes(32).toString('hex');
const model = option('--model', 'gpt-5.6-sol');
const report = { kind: 'real-codex-scoped-task-maintenance', startedAt: new Date().toISOString(), model,
  runtime: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries(['backend-v2.js', 'lib/mcp-server-core.js', 'router/dist/runner.js'].map(file =>
    [file, createHash('sha256').update(readFileSync(path.join(repo, file))).digest('hex')])),
  operations: [], approvalRequests: [], passed: false };
const save = () => writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
const context = await createBackendTestContext('hagency-maintenance-probe-', {
  agents: { [name]: { name, agentId: `agent_${name}`, kind: 'agent', type: 'codex', workdir, online: true } },
  agentTokens: { [name]: token },
  env: { HAGENCY_THREAD_SESSIONS: '1', HAGENCY_ROUTER_TASK_CUTOVER: '1', HAGENCY_AGENT_TOKEN_MODE: 'hard',
    API_TOKEN: randomBytes(32).toString('hex'), MATRIX_BRIDGE_SECRET: randomBytes(32).toString('hex'),
    MATRIX_TRUST_MODE: 'enforce' },
});
const router = context.internals.routerStoreForTest;
context.internals.stopRouterPumpForTest();
let serving;
try {
  serving = await context.listen();
  serving.server.on('request', req => {
    if (req.url !== '/api/router/session-task') return;
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { const p = JSON.parse(body); report.operations.push({ op: p.op, id: p.id, status: p.status,
        heartbeat: p.heartbeat_at === true }); } catch { /* malformed requests cannot be evidence */ }
    });
  });
  const prompt = 'Create projects/maintenance/sum.cjs exporting sum(a,b), with sum.test.cjs using node:test for positive, negative and zero cases. Report a task heartbeat before working. Run the tests, record completion when they pass, and state the result. This is an isolated local probe; no external messaging is needed.';
  router.ingestMessage({ messageId: 'probe-input', roomId: '!probe:fixture.invalid', matrixEventId: '$probe',
    senderName: 'operator', recipientAgentId: `agent_${name}`, recipientAgentName: name, normalizedBody: prompt });
  const intent = router.createTaskIntent({ requestScope: 'probe', requestKey: 'maintenance', roomId: '!probe:fixture.invalid',
    rootMessageId: 'probe-input', threadRootEventId: '$probe', inputMessageIds: ['probe-input'],
    task: { title: 'Verify scoped task lifecycle', assigneeAgentId: `agent_${name}`, assigneeName: name } });
  const command = router.claimMatrixCommand();
  const active = router.recordMatrixDelivery({ commandId: command.commandId, claimToken: command.claimToken, eventId: '$probe-anchor' });
  router.registerWorkspace({ resourceId: 'probe-workspace', safeLabel: 'maintenance-probe', backendPath: workdir });
  router.enqueueDispatch({ sessionId: active.sessionId, taskId: intent.taskId, framework: 'codex', localServerId: 'local',
    workspaceResourceId: 'probe-workspace', mayWrite: true, payload: { prompt } });
  const claim = router.claimDispatch({ runnerId: 'maintenance-probe', leaseMs: 240_000, capabilityTtlMs: 240_000, maxLiveRunners: 1 });
  const env = { AGENT_NAME: name, AGENT_TOKEN: token, HAGENCY_API: serving.baseUrl, HAGENCY_RUNTIME_DIR: context.runtimeDir,
    HAGENCY_EPHEMERAL_RUNNER: '1', HAGENCY_AGENT_ID: `agent_${name}`, HAGENCY_MCP_HEARTBEAT_MS: '0' };
  report.taskId = intent.taskId;
  report.dispatchId = claim.dispatchId;
  save();
  report.completion = await runCodexDispatch({ router, claim, cwd: workdir, executable: 'codex', model, effort: 'high', env,
    mayWrite: true, acknowledgementTimeoutMs: 60_000, executionTimeoutMs: 240_000, approvalTimeoutMs: 5000,
    maxParkedRunners: 1,
    mcpServer: { name: 'hagency', command: process.execPath, args: [path.join(repo, 'mcp-server.js')],
      envVars: [...Object.keys(env), 'HAGENCY_DISPATCH_ID', 'HAGENCY_RUNNER_ID', 'HAGENCY_DISPATCH_CAPABILITY', 'HAGENCY_FENCE_GENERATION'] },
    requestOwnerApproval: async request => {
      report.approvalRequests.push({ kind: request.kind, command: request.command, reason: request.reason });
      save();
      // No synthetic verdict, including no synthetic denial. The runner fails
      // closed when the adapter cannot supply an actual owner decision.
      throw new Error('unexpected native approval in routine lifecycle probe');
    },
  });
  report.task = router.db.prepare('SELECT task_id,status,heartbeat_at,completed_at FROM tasks WHERE task_id=?').get(intent.taskId);
  report.shellWrapperUsed = existsSync(path.join(workdir, '.shell-task-writer-used'));
  assert.equal(report.completion.state, 'completed');
  assert.equal(report.task.status, 'done');
  assert.ok(report.task.heartbeat_at);
  assert.ok(report.operations.some(op => op.op === 'execution' && op.heartbeat));
  assert.ok(report.operations.some(op => op.op === 'transition' && op.status === 'done'));
  assert.equal(report.approvalRequests.length, 0);
  assert.equal(context.internals.approvalStoreForTest.listRequests({}).length, 0);
  assert.equal(report.shellWrapperUsed, false);
  report.tests = execFileSync(process.execPath, ['--test', 'sum.test.cjs'], {
    cwd: path.join(workdir, 'projects/maintenance'), encoding: 'utf8', timeout: 10_000,
  });
  report.passed = true;
} catch (error) {
  report.error = String(error.message).slice(0, 2000);
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  if (serving) await serving.close();
  await context.backendModule.stopServer();
  router.close();
  context.cleanup();
}
console.log(JSON.stringify({ passed: report.passed, report: path.join(output, 'report.json'), error: report.error }));
process.exitCode = report.passed ? 0 : 1;
