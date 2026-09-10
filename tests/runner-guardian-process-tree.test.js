import { afterEach, describe, expect, test } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const roots = [];
const fixture = (name) => path.resolve('tests/fixtures', name);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const running = (pid) => {
  try {
    const state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
    return !!state && !state.startsWith('Z');
  } catch (error) { if (error.status === 1) return false; throw error; }
};
const killFixture = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } };

function launch(env, executable = fixture('fake-claude-runner.mjs'), args = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hagency-owned-tree-'));
  roots.push(root);
  const messages = [];
  const guardian = spawn(process.execPath, [path.resolve('router/dist/runner-guardian.js')], {
    cwd: root, env: { PATH: process.env.PATH, ...env,
      HAGENCY_GUARDIAN_EXECUTABLE: executable,
      HAGENCY_GUARDIAN_ARGS_JSON: JSON.stringify(args), FAKE_CLAUDE_HANG: '1' },
    stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  guardian.stderr.on('data', (chunk) => { stderr += chunk; });
  guardian.on('message', (message) => messages.push(message));
  const closed = new Promise((resolve, reject) => {
    guardian.once('error', reject);
    guardian.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
  return { guardian, messages, closed };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('guardian descendant termination evidence', () => {
  test.each([['immediate exit', '/bin/sh', ['-c', 'exit 7'], [7]], ['missing executable', '/nonexistent/hagency-runtime', [], [126, 127]]])(
    'guardian observes ownership before %s and finishes without quarantine delay', async (_name, executable, args, code) => {
      const start = Date.now();
      const run = launch({}, executable, args);
      // POSIX shells use 126 or 127 for an unavailable executable.
      expect(code).toContain((await run.closed).code);
      expect(Date.now() - start).toBeLessThan(3000);
      expect(run.messages.filter(message => message.type === 'cleanup_complete')).toHaveLength(1);
    });
  test.each(['still-parented', 'already-reparented'])(
    'guardian confirms a detached grandchild is gone and leaves a foreign process untouched (%s)', async (mode) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'hagency-detached-tool-'));
      roots.push(root);
      const base = path.join(root, 'tool');
      const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      const decoyClosed = new Promise((resolve) => decoy.once('close', resolve));
      const { guardian, messages, closed } = launch({ FAKE_CLAUDE_TOOL_TREE: base });
      let tree;
      try {
        await expect.poll(() => messages.some((message) => message.type === 'runtime_ready')).toBe(true);
        await expect.poll(() => existsSync(`${base}.json`)).toBe(true);
        tree = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
        expect(running(tree.toolPid)).toBe(true);
        expect(execFileSync('/bin/ps', ['-p', String(tree.toolPid), '-o', 'pgid='], { encoding: 'utf8' }).trim()).toBe(String(tree.toolPid));
        if (mode === 'already-reparented') {
          // Keep the real ancestry observable over multiple normal tracker cycles,
          // then remove it before Stop. A Stop-time-only tree walk cannot pass.
          await delay(500);
          writeFileSync(`${base}.orphan`, 'exit intermediate');
          await expect.poll(() => running(tree.intermediatePid)).toBe(false);
          expect(execFileSync('/bin/ps', ['-p', String(tree.toolPid), '-o', 'ppid='], { encoding: 'utf8' }).trim()).not.toBe(String(tree.intermediatePid));
        }
        guardian.kill('SIGTERM');
        expect((await closed).code).not.toBe(125);
        expect(messages.filter((message) => message.type === 'cleanup_complete')).toHaveLength(1);
        expect(running(tree.runtimePid)).toBe(false);
        expect(running(tree.intermediatePid)).toBe(false);
        expect(running(tree.toolPid)).toBe(false);
        expect(existsSync(`${base}.term`)).toBe(true);
        const lastWrite = readFileSync(`${base}.writing`, 'utf8');
        await delay(100);
        expect(readFileSync(`${base}.writing`, 'utf8')).toBe(lastWrite);
        expect(existsSync(`${base}.finished`)).toBe(false);
        expect(running(decoy.pid)).toBe(true);
      } finally {
        if (!tree && existsSync(`${base}.json`)) tree = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
        for (const pid of Object.values(tree ?? {})) killFixture(pid);
        guardian.kill('SIGTERM');
        await closed;
        killFixture(decoy.pid); await decoyClosed;
      }
    },
  );

  test('lost process inspection cannot produce a guardian cleanup receipt', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'hagency-inspection-loss-'));
    roots.push(root);
    const failure = path.join(root, 'fail-ps');
    const { guardian, messages, closed } = launch({
      NODE_OPTIONS: `--import=${fixture('fail-guardian-process-inspection.mjs')}`,
      FAKE_GUARDIAN_INSPECTION_FAILURE: failure,
    });
    let runtimePid;
    try {
      await expect.poll(() => messages.find((message) => message.type === 'runtime_ready')).toBeTruthy();
      runtimePid = messages.find((message) => message.type === 'runtime_ready').pid;
      writeFileSync(failure, 'fail subsequent observations');
      guardian.kill('SIGTERM');
      expect(await closed).toMatchObject({ code: 125 });
      expect(messages.some((message) => message.type === 'cleanup_complete')).toBe(false);
      expect(running(runtimePid)).toBe(false);
    } finally {
      if (runtimePid) killFixture(runtimePid);
      guardian.kill('SIGTERM'); await closed;
    }
  });
});
