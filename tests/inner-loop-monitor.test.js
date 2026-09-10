import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareJob, watchJob, runCommand } from '../skills/hagency-inner-loop/scripts/monitor.mjs';

const script = fileURLToPath(new URL('../skills/hagency-inner-loop/scripts/monitor.mjs', import.meta.url));
const agent = { name: 'inner', agent: 'octoscode', terminal_id: 'term_1', pane_id: 'w1:p1',
  workspace_id: 'w1', tab_id: 'w1:t1', agent_status: 'idle', state_change_seq: 1,
  process_identity: { shell_pid: 1001, foreground_process_group_id: 1002 } };
let root, cwd, jobsDir, head;
const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v));
const getAgent = async () => ({ ...agent });
const options = (extra = {}) => ({ session: 'owned-session', target: 'inner', cwd, jobsDir,
  verifyArgv: [process.execPath, '-e', 'process.stdout.write("independent check")'],
  timeoutMs: 5000, pollMs: 1, ...extra });
const prepare = (extra = {}) => prepareJob(options(extra), { getAgent });
const resultFor = (job, extra = {}) => ({ version: 1, job_id: job.job_id, nonce: job.nonce,
  status: 'completed', summary: 'Implemented requested change', commit: head,
  checks: [{ name: 'inner test claim', status: 'passed' }], ...extra });

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'hagency-inner-test-'));
  cwd = path.join(root, 'project');
  agent.cwd = cwd;
  jobsDir = path.join(root, 'jobs');
  mkdirSync(cwd);
  git('init', '--quiet');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(path.join(cwd, 'source.js'), 'export const value = 1;\n');
  git('add', 'source.js');
  git('commit', '--quiet', '-m', 'fixture');
  head = git('rev-parse', 'HEAD');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('inner loop monitor', () => {
  it('prepares distinct jobs with the observed identity and predeclared verifier', async () => {
    const first = await prepare();
    const second = await prepare();
    expect(first.job_id).not.toBe(second.job_id);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(first.identity).toMatchObject({ terminal_id: 'term_1', pane_id: 'w1:p1', agent: 'octoscode' });
    expect(first.verify_argv).toEqual(options().verifyArgv);
    expect(readJson(first.manifest_path)).toEqual(first);
    expect(first.result_path).not.toBe(second.result_path);
    await expect(prepare({ jobsDir: path.join(cwd, '.jobs') })).rejects.toThrow(/outside/i);
    expect(existsSync(path.join(cwd, '.jobs'))).toBe(false);
    await expect(prepare({ session: '' })).rejects.toThrow(/session/i);
    await expect(prepare({ verifyArgv: [] })).rejects.toThrow(/argv/i);
    await expect(prepare({ timeoutMs: Infinity })).rejects.toThrow(/timeout/i);
    await expect(prepare({ commandTimeoutMs: 60001 })).rejects.toThrow(/timeout/i);
    await expect(prepareJob(options(), { getAgent: async () => ({ ...agent, agent_status: 'working' }) }))
      .rejects.toThrow(/ready|idle/i);
    await expect(prepareJob(options(), { getAgent: async () => ({ ...agent, cwd: root }) }))
      .rejects.toThrow(/working directory/i);
  });

  it('observes in-place completion and reports verified work separately from unchanged runtime state', async () => {
    const job = await prepare();
    writeFileSync(job.result_path, '{"status":');
    const report = await watchJob(job.manifest_path, {
      getAgent,
      sleep: async () => writeJson(job.result_path, resultFor(job)),
    });
    expect(report).toMatchObject({ work_status: 'verified', runtime_status: 'idle', runtime_state_change_seq: 1 });
    expect(report.verification).toMatchObject({ code: 0, stdout: 'independent check' });
    expect(report.repository_before).toEqual(report.repository_after);
    expect(report.repository_before.head).toBe(head);
    expect(readJson(report.report_path)).toEqual(report);
  });

  it('rejects stale nonce wrong commit invalid checks and explicit failure', async () => {
    for (const override of [
      { nonce: 'old-job' }, { job_id: 'old-job' }, { commit: 'a'.repeat(40) },
      { checks: [] }, { checks: [{ name: 'test', status: 'skipped' }] },
      { status: 'failed', summary: 'Build failed' },
    ]) {
      const job = await prepare();
      writeJson(job.result_path, resultFor(job, override));
      const verify = vi.fn();
      const report = await watchJob(job.manifest_path, { getAgent, verify });
      expect(report.work_status).toBe('failed');
      expect(verify).not.toHaveBeenCalled();
    }
  });

  it('rejects blocked or replaced agents without running verification', async () => {
    for (const [change, status] of [
      [{ agent_status: 'blocked' }, 'blocked'], [{ terminal_id: 'term_replacement' }, 'failed'],
      [{ agent: 'codex' }, 'failed'], [{ pane_id: 'w2:p1' }, 'failed'],
      [{ process_identity: { shell_pid: 1001, foreground_process_group_id: 2002 } }, 'failed'],
    ]) {
      const job = await prepare();
      writeJson(job.result_path, resultFor(job));
      const verify = vi.fn();
      const report = await watchJob(job.manifest_path, { getAgent: async () => ({ ...agent, ...change }), verify });
      expect(report.work_status).toBe(status);
      expect(verify).not.toHaveBeenCalled();
    }
    const job = await prepare();
    writeJson(job.result_path, resultFor(job, { status: 'blocked', summary: 'Needs approved dependency' }));
    expect((await watchJob(job.manifest_path, { getAgent })).work_status).toBe('blocked');
  });

  it('rejects commit tracked untracked result and identity changes during verification', async () => {
    for (const mutation of ['head', 'tracked', 'untracked', 'result', 'identity']) {
      const job = await prepare();
      writeFileSync(path.join(cwd, 'untracked.txt'), 'before');
      writeJson(job.result_path, resultFor(job, { commit: git('rev-parse', 'HEAD') }));
      let verified = false;
      const report = await watchJob(job.manifest_path, {
        getAgent: async () => ({ ...agent, ...(verified && mutation === 'identity' ? { terminal_id: 'term_new' } : {}) }),
        verify: async () => {
          if (mutation === 'head') git('commit', '--allow-empty', '--quiet', '-m', 'concurrent');
          if (mutation === 'tracked') writeFileSync(path.join(cwd, 'source.js'), 'changed during verifier');
          if (mutation === 'untracked') writeFileSync(path.join(cwd, 'untracked.txt'), 'after');
          if (mutation === 'result') writeJson(job.result_path, resultFor(job, { summary: 'rewritten result' }));
          verified = true;
          return { code: 0, stdout: '', stderr: '', timed_out: false };
        },
      });
      expect(report.work_status, mutation).toBe('failed');
      expect(report.reason, mutation).toMatch(/changed|identity/i);
    }
  });

  it('fails a nonzero verifier and bounds a hanging child process', async () => {
    const failure = await prepare({ verifyArgv: [process.execPath, '-e', 'console.error("assertion failed");process.exit(7)'] });
    writeJson(failure.result_path, resultFor(failure));
    const report = await watchJob(failure.manifest_path, { getAgent });
    expect(report).toMatchObject({ work_status: 'failed', verification: { code: 7, timed_out: false } });
    expect(report.verification.stderr).toContain('assertion failed');
    const hanging = await prepare({ commandTimeoutMs: 40,
      verifyArgv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] });
    writeJson(hanging.result_path, resultFor(hanging));
    const timed = await watchJob(hanging.manifest_path, { getAgent });
    expect(timed).toMatchObject({ work_status: 'timed_out', verification: { timed_out: true } });
  });

  it('times out missing or incomplete results without running verification', async () => {
    for (const contents of [undefined, '{', JSON.stringify({ status: 'working' })]) {
      const job = await prepare({ timeoutMs: 100 });
      if (contents !== undefined) writeFileSync(job.result_path, contents === '{' ? contents : JSON.stringify(resultFor(job, { status: 'working' })));
      let now = job.created_at;
      const verify = vi.fn();
      const report = await watchJob(job.manifest_path, { getAgent, verify,
        now: () => now, sleep: async () => { now += 101; } });
      expect(report.work_status).toBe('timed_out');
      expect(verify).not.toHaveBeenCalled();
    }
  });

  it('does not execute a verifier supplied by the inner result', async () => {
    const job = await prepare();
    writeJson(job.result_path, resultFor(job, { verify_argv: ['should-never-run'], command: 'touch bad' }));
    const report = await watchJob(job.manifest_path, { getAgent });
    expect(report.work_status).toBe('verified');
    expect(report.verification.stdout).toBe('independent check');
  });

  it('keeps a working runtime distinct from independently verified work', async () => {
    const job = await prepare();
    writeJson(job.result_path, resultFor(job));
    const report = await watchJob(job.manifest_path, { getAgent: async () => ({ ...agent, agent_status: 'working' }) });
    expect(report).toMatchObject({ work_status: 'verified', runtime_status: 'working' });
  });

  it('fails closed on unreadable Herdr evidence and malformed result shapes', async () => {
    const job = await prepare();
    writeJson(job.result_path, resultFor(job));
    const verify = vi.fn();
    expect((await watchJob(job.manifest_path, {
      getAgent: async () => { throw new Error('Herdr socket unavailable'); }, verify,
    })).work_status).toBe('failed');
    expect(verify).not.toHaveBeenCalled();
    writeJson(job.result_path, []);
    expect((await watchJob(job.manifest_path, { getAgent })).work_status).toBe('failed');
  });

  it('CLI prepare and watch use the explicit session and emit JSON with matching exit codes', async () => {
    const binDir = path.join(root, 'bin');
    mkdirSync(binDir);
    const argsLog = path.join(root, 'herdr-args.jsonl');
    writeFileSync(path.join(binDir, 'herdr'), `#!${process.execPath}\n` +
      `const fs = require('node:fs');fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2))+'\\n');` +
      `console.log(JSON.stringify({result:process.argv.includes('process-info')?{process_info:${JSON.stringify({ pane_id: agent.pane_id, ...agent.process_identity })}}:{agent:${JSON.stringify(agent)}}}));\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: binDir + path.delimiter + process.env.PATH };
    const prepared = await runCommand([process.execPath, script, 'prepare', '--session', 'owned-session',
      '--agent', 'inner', '--cwd', cwd, '--jobs-dir', jobsDir, '--verify-json', JSON.stringify(options().verifyArgv)], { cwd, env, timeoutMs: 5000 });
    expect(prepared.code).toBe(0);
    const job = JSON.parse(prepared.stdout);
    writeJson(job.result_path, resultFor(job));
    const passed = await runCommand([process.execPath, script, 'watch', '--job', job.manifest_path], { cwd, env, timeoutMs: 5000 });
    expect(passed.code).toBe(0);
    expect(JSON.parse(passed.stdout).work_status).toBe('verified');
    writeJson(job.result_path, resultFor(job, { nonce: 'stale' }));
    const failed = await runCommand([process.execPath, script, 'watch', '--job', job.manifest_path], { cwd, env, timeoutMs: 5000 });
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout).work_status).toBe('failed');
    const calls = readFileSync(argsLog, 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls[0]).toEqual(['--session', 'owned-session', 'agent', 'get', 'inner']);
    expect(calls[1]).toEqual(['--session', 'owned-session', 'pane', 'process-info', '--pane', 'w1:p1']);
    expect(calls.slice(2).every((args) => JSON.stringify(args) === JSON.stringify(['--session', 'owned-session', 'agent', 'get', 'w1:p1']) ||
      JSON.stringify(args) === JSON.stringify(['--session', 'owned-session', 'pane', 'process-info', '--pane', 'w1:p1']))).toBe(true);
  });

  it('runs the CLI through an installed skill directory symlink', async () => {
    const installed = path.join(root, 'installed-skill');
    symlinkSync(path.dirname(path.dirname(script)), installed, 'dir');
    const help = await runCommand([process.execPath, path.join(installed, 'scripts', 'monitor.mjs'), '--help'], { cwd, timeoutMs: 2000 });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('prepare --session');
  });
});
