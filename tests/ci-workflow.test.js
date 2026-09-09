import { describe, expect, test } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'path';

const workflowPath = path.resolve('.github/workflows/ci.yml');

function readWorkflow() {
  return readFileSync(workflowPath, 'utf8');
}

function jobBlock(source, jobName) {
  const pattern = new RegExp(`(?:^|\\n)  ${jobName}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:\\n|$)`);
  const match = source.match(pattern);
  return match ? match[1] : '';
}

describe('GitHub Actions CI workflow', () => {
  test('bounds all CI jobs with a wall-clock timeout', () => {
    const workflow = readWorkflow();
    for (const jobName of ['lint', 'test']) {
      const block = jobBlock(workflow, jobName);
      expect(block).not.toBe('');
      expect(block).toMatch(/^\s+timeout-minutes:\s+\d+/m);
    }
  });

  test('the job that runs the suite is not allowed to run unbounded', () => {
    /*
     * This used to pin the literal `- run: npm test`, which is the anchor and not the property: the
     * point was always that the job running the suite has a wall-clock bound. Adding a JSON reporter
     * for flake forensics changed the command and tripped it, correctly — the guard noticed the CI
     * definition move. Widening it to "either command" alone would have been a loosening, so the
     * companion assertion below closes the hole that widening opens.
     */
    const block = jobBlock(readWorkflow(), 'test');
    expect(block).toMatch(/- run: npm (test|run test:ci)$/m);
    expect(block).toMatch(/^\s+timeout-minutes:\s+\d+/m);
  });

  test('test:ci cannot quietly become a narrower run than npm test', () => {
    /*
     * The risk the widening above introduces. If CI may run `test:ci`, then `test:ci` is what "the
     * tests pass" means — and nothing stopped it from drifting into a subset, a `--bail`, or a
     * different config while still being green. It must be exactly `test` plus reporter flags.
     */
    const scripts = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).scripts || {};
    if (!scripts['test:ci']) return; // the plain `npm test` job is still allowed
    const extra = scripts['test:ci'].replace(scripts.test, '').trim();
    expect(scripts['test:ci'].startsWith(scripts.test)).toBe(true);
    for (const flag of extra.split(/\s+/).filter(Boolean)) {
      expect(flag).toMatch(/^--(reporter|outputFile)/);
    }
  });
});


test('sharded suite retains failure when a child crashes or omits its report', () => {
  for (const failure of ['none', 'exit', 'missing', 'signal']) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hafleet-suite-verdict-'));
    try {
      mkdirSync(path.join(root, 'scripts'));
      mkdirSync(path.join(root, 'node_modules/vitest'), { recursive: true });
      writeFileSync(path.join(root, 'scripts/run-suite-tests.mjs'), readFileSync('scripts/run-suite-tests.mjs'));
      // Only the external Vitest process is replaced. The real suite wrapper
      // must retain a failed child even if the later report merge returns zero.
      writeFileSync(path.join(root, 'node_modules/vitest/vitest.mjs'), String.raw`
        import { appendFileSync, writeFileSync } from 'node:fs';
        const args = process.argv.slice(2);
        appendFileSync('calls.jsonl', JSON.stringify(args) + '\n');
        const second = args.includes('--shard=2/4');
        if (second && process.env.FIXTURE_FAILURE === 'signal') process.kill(process.pid, 'SIGTERM');
        const blob = args.find(arg => arg.startsWith('--outputFile.blob='));
        if (blob && !(second && process.env.FIXTURE_FAILURE === 'missing')) writeFileSync(blob.split('=').slice(1).join('='), '{}');
        process.exitCode = second && process.env.FIXTURE_FAILURE === 'exit' ? 1 : 0;
      `);
      const result = spawnSync(process.execPath, ['scripts/run-suite-tests.mjs', '--reporter=json', '--outputFile.json=test-results.json'],
        { cwd: root, env: { ...process.env, FIXTURE_FAILURE: failure }, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(failure === 'none' ? 0 : 1);
      const calls = readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      expect(calls).toHaveLength(5);
      expect(calls.slice(0, 4).map(args => args.find(arg => arg.startsWith('--shard='))))
        .toEqual(['--shard=1/4', '--shard=2/4', '--shard=3/4', '--shard=4/4']);
      expect(calls[4]).toContain('--outputFile.json=test-results.json');
      expect(calls[4][0]).toMatch(/^--merge-reports=/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
