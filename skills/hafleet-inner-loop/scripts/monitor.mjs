#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const MAX_COMMAND_MS = 60_000;
const MAX_JOB_MS = 86_400_000;
const MAX_RESULT_BYTES = 1_048_576;
const statuses = new Set(['idle', 'done', 'working', 'blocked', 'unknown']);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function duration(value, name, maximum = MAX_COMMAND_MS) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function argvValid(argv) {
  return Array.isArray(argv) && argv.length > 0 && nonempty(argv[0]) &&
    argv.every((arg) => typeof arg === 'string' && !arg.includes('\0'));
}

async function prospectiveRealpath(directory) {
  try { return await realpath(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await prospectiveRealpath(path.dirname(directory)), path.basename(directory));
  }
}

// Shell-free execution with a finite timeout, bounded output, and process-group cleanup.
export function runCommand(argv, { cwd, env = process.env, timeoutMs = MAX_COMMAND_MS,
  maxOutputBytes = MAX_RESULT_BYTES } = {}) {
  if (!argvValid(argv)) throw new Error('verification argv must be a nonempty array of strings');
  duration(timeoutMs, 'command timeout');
  return new Promise((resolve) => {
    const detached = process.platform !== 'win32';
    const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, detached, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: [], stderr: [] };
    let bytes = 0;
    let timedOut = false;
    let outputLimit = false;
    let spawnError;
    const kill = () => {
      try {
        if (detached && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* The process may have exited between the deadline and kill. */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= maxOutputBytes) output[stream].push(chunk);
      else { outputLimit = true; kill(); }
    });
    child.on('error', (error) => { spawnError = error.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8'), timed_out: timedOut,
        output_limit: outputLimit, ...(spawnError ? { error: spawnError } : {}) });
    });
  });
}

async function commandOutput(argv, cwd, timeoutMs = 10_000) {
  const result = await runCommand(argv, { cwd, timeoutMs, maxOutputBytes: 16 * MAX_RESULT_BYTES });
  if (result.code !== 0 || result.timed_out || result.output_limit || result.error) {
    throw new Error(`Cannot read ${argv[0]} evidence: ${result.error || result.stderr.trim() || 'command failed or timed out'}`);
  }
  return result.stdout;
}

function identityOf(agent) {
  if (!object(agent) || !['terminal_id', 'pane_id', 'agent'].every((key) => nonempty(agent[key])) ||
      !statuses.has(agent.agent_status) || !Number.isSafeInteger(agent.state_change_seq) || agent.state_change_seq < 0) {
    throw new Error('Herdr returned incomplete agent identity or lifecycle evidence');
  }
  if (!object(agent.process_identity) || !['shell_pid', 'foreground_process_group_id'].every((key) =>
    Number.isSafeInteger(agent.process_identity[key]) && agent.process_identity[key] > 0)) {
    throw new Error('Herdr returned incomplete execution process identity');
  }
  return { terminal_id: agent.terminal_id, pane_id: agent.pane_id, agent: agent.agent,
    process_identity: { shell_pid: agent.process_identity.shell_pid,
      foreground_process_group_id: agent.process_identity.foreground_process_group_id },
    ...(agent.agent_session ? { agent_session: agent.agent_session } : {}) };
}

async function getHerdrAgent(session, target, { timeoutMs = 10_000 } = {}) {
  const startedAt = Date.now();
  const raw = await commandOutput(['herdr', '--session', session, 'agent', 'get', target], undefined, timeoutMs);
  const response = JSON.parse(raw);
  const agent = response?.result?.agent;
  if (!nonempty(agent?.pane_id)) throw new Error('Herdr returned no agent pane identity');
  const budget = timeoutMs - (Date.now() - startedAt);
  if (budget <= 0) throw new Error('Herdr observation exceeded its deadline');
  const processRaw = await commandOutput(['herdr', '--session', session, 'pane', 'process-info', '--pane', agent.pane_id], undefined, budget);
  const processInfo = JSON.parse(processRaw)?.result?.process_info;
  if (processInfo?.pane_id !== agent.pane_id) throw new Error('Herdr process evidence does not match the agent pane');
  agent.process_identity = { shell_pid: processInfo.shell_pid,
    foreground_process_group_id: processInfo.foreground_process_group_id };
  identityOf(agent);
  return agent;
}

function sameIdentity(expected, agent) {
  const current = identityOf(agent);
  return ['terminal_id', 'pane_id', 'agent'].every((key) => current[key] === expected[key]) &&
    JSON.stringify(current.process_identity) === JSON.stringify(expected.process_identity) &&
    (!expected.agent_session || JSON.stringify(current.agent_session) === JSON.stringify(expected.agent_session));
}

async function repositorySnapshot(cwd) {
  const git = (...args) => commandOutput(['git', '-C', cwd, ...args], cwd);
  const root = await realpath((await git('rev-parse', '--show-toplevel')).trim());
  const head = (await git('rev-parse', 'HEAD')).trim();
  const status = await git('status', '--porcelain=v1', '-z', '--untracked-files=all');
  const index = await git('diff', '--cached', '--raw', '--no-abbrev');
  const files = [...new Set((await commandOutput(['git', '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], root))
    .split('\0').filter(Boolean))].sort();
  const content = createHash('sha256');
  for (const relative of files) {
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw new Error('Git returned an out-of-repository path');
    content.update(JSON.stringify(relative));
    let stat;
    try { stat = await lstat(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      content.update('missing');
      continue;
    }
    content.update(String(stat.mode));
    if (stat.isSymbolicLink()) content.update(JSON.stringify(await readlink(file)));
    else if (stat.isFile()) {
      const fileHash = createHash('sha256');
      for await (const chunk of createReadStream(file)) fileHash.update(chunk);
      content.update(fileHash.digest('hex'));
    } else throw new Error(`Unsupported repository entry (including submodules): ${relative}`);
  }
  return { root, head, status, index, content_sha256: content.digest('hex') };
}

function validateJob(job) {
  if (!object(job) || job.version !== 1 || !nonempty(job.session) || !nonempty(job.job_id) ||
      !/^[a-f0-9]{64}$/.test(job.nonce) || !argvValid(job.verify_argv) ||
      !['cwd', 'repository_root', 'manifest_path', 'result_path'].every((key) => nonempty(job[key]) && path.isAbsolute(job[key])) ||
      !object(job.identity) || !['terminal_id', 'pane_id', 'agent'].every((key) => nonempty(job.identity[key])) ||
      !object(job.identity.process_identity) || !['shell_pid', 'foreground_process_group_id'].every((key) =>
        Number.isSafeInteger(job.identity.process_identity[key]) && job.identity.process_identity[key] > 0)) {
    throw new Error('Invalid prepared job manifest');
  }
  duration(job.command_timeout_ms, 'command timeout');
  duration(job.poll_ms, 'poll interval');
  duration(job.deadline_at - job.created_at, 'job timeout', MAX_JOB_MS);
  if (!Number.isSafeInteger(job.created_at) || !Number.isSafeInteger(job.deadline_at)) throw new Error('Invalid job deadline');
  if (job.result_path !== path.join(path.dirname(job.manifest_path), 'result.json')) throw new Error('Invalid result path');
}

export async function prepareJob({ session, target, cwd, jobsDir, verifyArgv,
  timeoutMs = 900_000, pollMs = 1000, commandTimeoutMs = MAX_COMMAND_MS },
{ getAgent = getHerdrAgent, now = Date.now } = {}) {
  if (!nonempty(session) || !nonempty(target)) throw new Error('An explicit session and agent target are required');
  if (!argvValid(verifyArgv)) throw new Error('verification argv must be a nonempty array of strings');
  duration(timeoutMs, 'job timeout', MAX_JOB_MS);
  duration(pollMs, 'poll interval');
  duration(commandTimeoutMs, 'command timeout');
  if (!nonempty(cwd) || !path.isAbsolute(cwd) || !nonempty(jobsDir) || !path.isAbsolute(jobsDir)) {
    throw new Error('cwd and jobs directory must be absolute paths');
  }
  cwd = await realpath(cwd);
  const repository = await repositorySnapshot(cwd);
  jobsDir = await prospectiveRealpath(jobsDir);
  if (jobsDir === repository.root || jobsDir.startsWith(repository.root + path.sep)) {
    throw new Error('The jobs directory must be outside the edited repository');
  }
  const agent = await getAgent(session, target, { timeoutMs: 10_000 });
  const identity = identityOf(agent);
  if (!['idle', 'done'].includes(agent.agent_status)) throw new Error('Prepare requires a ready idle or done agent');
  const reportedCwd = agent.foreground_cwd || agent.cwd;
  if (!nonempty(reportedCwd) || await realpath(reportedCwd) !== cwd) {
    throw new Error('Execution agent working directory must match the prepared project');
  }
  await mkdir(jobsDir, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(jobsDir, 'job-'));
  const createdAt = now();
  const job = { version: 1, job_id: randomUUID(), nonce: randomBytes(32).toString('hex'),
    session, target, identity, baseline_state_change_seq: agent.state_change_seq,
    cwd, repository_root: repository.root, created_at: createdAt, deadline_at: createdAt + timeoutMs,
    command_timeout_ms: commandTimeoutMs, poll_ms: pollMs, verify_argv: [...verifyArgv],
    manifest_path: path.join(directory, 'job.json'), result_path: path.join(directory, 'result.json') };
  validateJob(job);
  await writeFile(job.manifest_path, JSON.stringify(job, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
  return job;
}

async function readResult(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > MAX_RESULT_BYTES) throw new Error('Result must be a regular JSON file at most 1 MiB');
    const raw = await readFile(file, 'utf8');
    try { return { value: JSON.parse(raw), raw }; }
    catch (error) { if (error instanceof SyntaxError) return { pending: 'incomplete JSON' }; throw error; }
  } catch (error) {
    if (error.code === 'ENOENT') return { pending: 'result absent' };
    throw error;
  }
}

function resultProblem(result, job) {
  if (!object(result) || result.version !== 1 || result.job_id !== job.job_id || result.nonce !== job.nonce) {
    return 'Result schema or job identity/nonce mismatch';
  }
  if (!['working', 'completed', 'failed', 'blocked'].includes(result.status)) return 'Invalid result status';
  if (result.status === 'working') return null;
  if (!nonempty(result.summary)) return 'Result summary is required';
  if (result.status === 'completed' && (!/^[a-f0-9]{40,64}$/.test(result.commit) ||
      !Array.isArray(result.checks) || result.checks.length === 0 ||
      result.checks.some((check) => !object(check) || !nonempty(check.name) || check.status !== 'passed'))) {
    return 'Completed result requires a commit and named passed checks';
  }
  return null;
}

export async function watchJob(manifestPath, { getAgent = getHerdrAgent, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), verify = runCommand } = {}) {
  const manifestRaw = await readFile(manifestPath, 'utf8');
  const job = JSON.parse(manifestRaw);
  validateJob(job);
  if (path.resolve(manifestPath) !== job.manifest_path) throw new Error('Manifest path differs from prepared path');
  const report = { version: 1, job_id: job.job_id, manifest_path: job.manifest_path,
    result_path: job.result_path, report_path: path.join(path.dirname(job.manifest_path), 'report.json'),
    session: job.session, identity: job.identity, runtime_status: null, runtime_state_change_seq: null };
  const remaining = () => Math.max(0, job.deadline_at - now());
  const finish = async (workStatus, reason) => {
    Object.assign(report, { work_status: workStatus, reason, observed_at: now() });
    const temporary = report.report_path + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, report.report_path);
    return report;
  };
  const observeAgent = async () => {
    const current = await getAgent(job.session, job.identity.pane_id, { timeoutMs: Math.max(1, Math.min(10_000, remaining())) });
    if (!sameIdentity(job.identity, current)) throw new Error('Execution agent identity changed');
    report.runtime_status = current.agent_status;
    report.runtime_state_change_seq = current.state_change_seq;
    return current;
  };
  try {
    let pending = 'result absent';
    while (remaining() > 0) {
      const current = await observeAgent();
      if (current.agent_status === 'blocked') return await finish('blocked', 'Herdr reports the execution agent is blocked');
      const candidate = await readResult(job.result_path);
      if (candidate.pending) pending = candidate.pending;
      else {
        const result = candidate.value;
        const problem = resultProblem(result, job);
        if (problem) return await finish('failed', problem);
        if (result.status === 'failed' || result.status === 'blocked') return await finish(result.status, result.summary);
        if (result.status === 'working') pending = 'inner reports working';
        else {
          report.result_sha256 = hash(candidate.raw);
          report.inner_summary = result.summary;
          report.repository_before = await repositorySnapshot(job.cwd);
          if (report.repository_before.root !== job.repository_root || report.repository_before.head !== result.commit) {
            return await finish('failed', 'Result commit or repository does not match current HEAD');
          }
          if (remaining() <= 0) return await finish('timed_out', 'Deadline expired before independent verification');
          report.verification = await verify(job.verify_argv, { cwd: job.cwd,
            timeoutMs: Math.max(1, Math.min(job.command_timeout_ms, remaining())) });
          if (report.verification.timed_out || remaining() <= 0) return await finish('timed_out', 'Independent verification exceeded its deadline');
          if (report.verification.code !== 0 || report.verification.output_limit || report.verification.error) {
            return await finish('failed', 'Independent verification failed');
          }
          const after = await observeAgent();
          if (after.agent_status === 'blocked') return await finish('blocked', 'Execution agent became blocked during verification');
          report.repository_after = await repositorySnapshot(job.cwd);
          if (JSON.stringify(report.repository_before) !== JSON.stringify(report.repository_after)) {
            return await finish('failed', 'Repository content or commit changed during verification');
          }
          const resultAfter = await readResult(job.result_path);
          if (resultAfter.raw !== candidate.raw || await readFile(job.manifest_path, 'utf8') !== manifestRaw) {
            return await finish('failed', 'Result or prepared manifest changed during verification');
          }
          if (remaining() <= 0) return await finish('timed_out', 'Deadline expired during final evidence check');
          return await finish('verified', 'Prepared independent verifier passed with unchanged repository, result and agent identity');
        }
      }
      if (remaining() > 0) await sleep(Math.min(job.poll_ms, remaining()));
    }
    return await finish('timed_out', `Deadline expired: ${pending}`);
  } catch (error) {
    return await finish('failed', error.message);
  }
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === '--help' || command === '-h') {
    process.stdout.write('Usage:\n  node monitor.mjs prepare --session NAME --agent TARGET --cwd ABS_PATH --jobs-dir ABS_PATH --verify-json \'["command","arg"]\' [--timeout-ms 900000] [--poll-ms 1000] [--command-timeout-ms 60000]\n  node monitor.mjs watch --job ABS_JOB_JSON\n\nprepare must precede dispatch. jobs-dir must be outside the Git repository.\nwatch emits JSON; exit codes: verified=0, failed=1, blocked=2, timed_out=3.\n');
    return;
  }
  if (command === 'prepare') {
    const { values } = parseArgs({ args: rest, options: Object.fromEntries([
      'session', 'agent', 'cwd', 'jobs-dir', 'verify-json', 'timeout-ms', 'poll-ms', 'command-timeout-ms',
    ].map((name) => [name, { type: 'string' }])) });
    const job = await prepareJob({ session: values.session, target: values.agent, cwd: values.cwd,
      jobsDir: values['jobs-dir'], verifyArgv: JSON.parse(values['verify-json'] || 'null'),
      timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
      pollMs: values['poll-ms'] === undefined ? undefined : Number(values['poll-ms']),
      commandTimeoutMs: values['command-timeout-ms'] === undefined ? undefined : Number(values['command-timeout-ms']) });
    process.stdout.write(JSON.stringify(job) + '\n');
  } else if (command === 'watch') {
    const { values } = parseArgs({ args: rest, options: { job: { type: 'string' } } });
    if (!values.job) throw new Error('--job is required');
    const report = await watchJob(values.job);
    process.stdout.write(JSON.stringify(report) + '\n');
    process.exitCode = { verified: 0, failed: 1, blocked: 2, timed_out: 3 }[report.work_status];
  } else throw new Error('Expected prepare or watch; use --help for syntax');
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stdout.write(JSON.stringify({ work_status: 'failed', reason: error.message }) + '\n');
    process.exitCode = 1;
  });
}
