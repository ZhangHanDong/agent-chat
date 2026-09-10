#!/usr/bin/env node
// Opt-in operational probe; deliberately excluded from deterministic Vitest tests.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRouter, runClaudeDispatch } from '../router/dist/index.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const output = option('--output', null);
if (!args.includes('--live') || !output || !path.isAbsolute(output)) {
  console.error('usage: probe-thread-continuity.mjs --live --output <absolute report directory> [--model <model>]');
  process.exit(2);
}
const model = option('--model', 'claude-fable-5');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(output, { recursive: true });
const report = {
  kind: 'real-model-thread-continuity', startedAt: new Date().toISOString(), model,
  runtime: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries(['router/dist/runner.js', 'router/dist/runner-guardian.js', 'router/dist/store.js'].map((file) =>
    [file, createHash('sha256').update(readFileSync(path.join(repo, file))).digest('hex')])),
  runs: [], passed: false,
};
const save = () => writeFileSync(path.join(output, 'continuity.json'), `${JSON.stringify(report, null, 2)}\n`);
for (let run = 1; run <= 5; run += 1) {
  const root = path.join(output, `conversation-${run}`);
  mkdirSync(root, { recursive: true });
  const dbPath = path.join(root, 'router.db');
  let router = openRouter({ dbPath });
  const nonce = `agreement-${randomBytes(8).toString('hex')}`;
  const prompts = [
    `For this conversation, our agreed release phrase is exactly ${nonce}. Confirm the agreement briefly.`,
    'Change topic: explain in one sentence why the Moon has phases. Do not mention our release phrase.',
    'What exact release phrase did we agree on earlier? Reply with only that phrase.',
  ];
  const result = { run, expected: nonce, prompts, turns: [], passed: false };
  report.runs.push(result);
  try {
    router.registerWorkspace({ resourceId: 'workspace', safeLabel: 'continuity-probe', backendPath: root });
    for (let turn = 0; turn < prompts.length; turn += 1) {
      // Prove recovery from durable context before the recall turn.
      if (turn === 2) { router.close(); router = openRouter({ dbPath }); }
      const ingested = router.ingestMessage({
        messageId: `user-${turn}`, matrixEventId: `$user-${turn}`, roomId: '!probe:fixture.invalid',
        threadRootEventId: '$conversation-root', senderName: 'operator',
        recipientAgentId: 'continuity-agent', recipientAgentName: 'continuity-agent', normalizedBody: prompts[turn],
      });
      if (!ingested.ok) throw new Error(`ingest refused: ${ingested.code}`);
      const queued = router.enqueueDispatch({ sessionId: ingested.session.sessionId, framework: 'claude', localServerId: 'local',
        workspaceResourceId: 'workspace', mayWrite: false, payload: { prompt: prompts[turn] } });
      if (!queued.ok) throw new Error(`enqueue refused: ${queued.code}`);
      const claim = router.claimDispatch({ runnerId: 'continuity-runner', leaseMs: 120_000, capabilityTtlMs: 120_000, maxLiveRunners: 1 });
      if (!claim?.ok) throw new Error('dispatch could not be claimed');
      const env = Object.fromEntries(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']
        .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
      const completed = await runClaudeDispatch({ router, claim, cwd: root, executable: 'claude', env,
        args: ['--print', '--model', model, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto',
          '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence'],
        acknowledgementTimeoutMs: 60_000, executionTimeoutMs: 180_000,
      });
      result.turns.push({ state: completed.state, text: completed.text });
      save();
      if (completed.state !== 'completed') throw new Error(`turn ${turn + 1} ended ${completed.state}`);
    }
    result.passed = result.turns[2].text.includes(nonce);
  } catch (error) {
    result.error = String(error.message).slice(0, 1000);
  } finally { router.close(); save(); }
  console.log(`continuity ${run}/5: ${result.passed ? 'pass' : 'fail'}`);
}
report.completedAt = new Date().toISOString();
report.successes = report.runs.filter((run) => run.passed).length;
report.passed = report.successes >= 4;
save();
console.log(`continuity gate: ${report.successes}/5; ${report.passed ? 'passed' : 'failed'}`);
process.exitCode = report.passed ? 0 : 1;
