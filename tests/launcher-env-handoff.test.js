import { afterEach, expect, test } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hagency-launch-env-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['bin', 'scripts', 'runtime', 'workdir', 'state']) mkdirSync(path.join(root, dir));
  for (const name of ['hagency-up-v1', 'hagency-up']) copyFileSync(path.resolve('bin', name), path.join(root, 'bin', name));
  writeFileSync(path.join(root, 'scripts/framework-info.js'), 'console.log("claude\\ncodex")');
  return root;
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

function run(root, entry, args, extraEnv) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('HAGENCY_') || key.startsWith('AGENT_') || key === 'API_TOKEN' || key === 'BASH_ENV') delete env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [path.join(root, 'bin', entry), ...args], {
      cwd: root, env: { ...env, HAGENCY_INTERNAL_DISPATCH: '1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.on('data', (b) => { stderr += b; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('backend v1 launcher uses its own authenticated loopback deployment despite repository dotenv', async () => {
  const root = fixture();
  const requests = [], wrongRequests = [];
  const port = await listen((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    if (req.headers.authorization !== 'Bearer deployment-token') { res.writeHead(401).end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ runtimeProfile: { primary: { framework: 'claude', model: 'selected-model' } } }));
  });
  const wrongPort = await listen((req, res) => { wrongRequests.push(req.url); res.writeHead(401).end(); });
  writeFileSync(path.join(root, '.env'), `API_TOKEN=repository-token\nHAGENCY_BACKEND_PORT=${wrongPort}\n`);
  writeFileSync(path.join(root, 'scripts/provision-v1-agent-home.js'), `console.log(JSON.stringify({paths:${JSON.stringify({
    homeDir: root, stateDir: path.join(root, 'state'), workdir: path.join(root, 'workdir'),
    agentId: 'agent_example', agentJsonPath: path.join(root, 'agent.json'),
  })}}))`);
  writeFileSync(path.join(root, 'bin/hagency-up'), '#!/bin/bash\nnode -e \'require("fs").writeFileSync(process.env.HANDOFF_FILE, JSON.stringify({token:process.env.API_TOKEN,port:process.env.HAGENCY_BACKEND_PORT,ready:process.env.HAGENCY_LAUNCH_ENV_READY}))\'\n', { mode: 0o755 });
  const result = await run(root, 'hagency-up-v1', ['example', 'claude'], {
    API_TOKEN: 'deployment-token', HAGENCY_BACKEND_PORT: String(port),
    HAGENCY_RUNTIME_DIR: path.join(root, 'runtime'), HAGENCY_LAUNCH_MODEL: 'selected-model',
    HAGENCY_LAUNCH_ENV_READY: '1', HANDOFF_FILE: path.join(root, 'handoff.json'),
  });
  expect(result.code, result.stderr).toBe(0);
  expect(wrongRequests).toEqual([]);
  expect(requests).toEqual([{ url: '/api/agents/example/launch-env', auth: 'Bearer deployment-token' }]);
  expect(JSON.parse(readFileSync(path.join(root, 'handoff.json')))).toEqual({ token: 'deployment-token', port: String(port), ready: '1' });
  expect(JSON.parse(readFileSync(path.join(root, 'runtime/data/agents/example/meta.json'))).runtimeProfile.primary.model).toBe('selected-model');
});

function inspectOnExit(root) {
  writeFileSync(path.join(root, 'exit-inspect.js'), 'require("fs").writeFileSync(process.env.ENV_RECEIPT,JSON.stringify({token:process.env.API_TOKEN,port:process.env.HAGENCY_BACKEND_PORT}))');
  writeFileSync(path.join(root, 'bash-env'), 'trap \'node "$ENV_INSPECTOR"\' EXIT\n');
  return { BASH_ENV: path.join(root, 'bash-env'), ENV_INSPECTOR: path.join(root, 'exit-inspect.js'), ENV_RECEIPT: path.join(root, 'environment.json') };
}

test('tmux launcher preserves the resolved backend environment', async () => {
  const root = fixture();
  writeFileSync(path.join(root, '.env'), 'API_TOKEN=wrong-token\nHAGENCY_BACKEND_PORT=19001\n');
  const result = await run(root, 'hagency-up', ['--help'], {
    ...inspectOnExit(root), API_TOKEN: 'deployment-token', HAGENCY_BACKEND_PORT: '19002',
    HAGENCY_RUNTIME_DIR: path.join(root, 'runtime'), HAGENCY_LAUNCH_ENV_READY: '1',
  });
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(path.join(root, 'environment.json')))).toEqual({ token: 'deployment-token', port: '19002' });
});

test('standalone launchers still load runtime dotenv after repository defaults', async () => {
  for (const entry of ['hagency-up-v1', 'hagency-up']) {
    const root = fixture();
    writeFileSync(path.join(root, '.env'), 'API_TOKEN=repository-token\nHAGENCY_BACKEND_PORT=19001\n');
    writeFileSync(path.join(root, 'runtime/.env'), 'API_TOKEN=runtime-token\nHAGENCY_BACKEND_PORT=19002\n');
    const result = await run(root, entry, ['--help'], {
      ...inspectOnExit(root), HAGENCY_RUNTIME_DIR: path.join(root, 'runtime'),
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, 'environment.json')))).toEqual({ token: 'runtime-token', port: '19002' });
  }
});
