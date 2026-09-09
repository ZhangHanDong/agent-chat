import { afterEach, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve('.');
const children = new Set();
const servers = new Set();
const temps = new Set();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  }
  children.clear();
  await Promise.all([...servers].map((s) => new Promise((resolve) => {
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    s.close(() => resolve());
  })));
  servers.clear();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  temps.clear();
});

/** A backend that serves one inbox payload and records what was asked of it. */
function fakeBackend(inbox) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk; seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : {} });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/inbox/')) return res.end(JSON.stringify(inbox));
      if (req.url === '/api/agents/alpha') return res.end(JSON.stringify({ name: 'alpha', groups: [] }));
      res.end(JSON.stringify({}));
    });
    server.listen(0, '127.0.0.1', () => {
      servers.add(server);
      server.unref?.();
      resolve({ port: server.address().port, seen });
    });
  });
}

/**
 * Speak MCP over stdio: initialize, then call one tool. Newline-delimited JSON-RPC, which is what the
 * agent's framework does — no SDK client, so the test cannot pass by agreeing with itself.
 */
function mcpClient(tmpdir, port) {
  const child = spawn(process.execPath, [path.join(repoRoot, 'lib/mcp-server-core.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENT_NAME: 'alpha',
      HAFLEET_API: `http://127.0.0.1:${port}`,
      HAFLEET_SERVER: 'local',
      API_TOKEN: '', AGENT_TOKEN: 'agent-test', HAFLEET_EPHEMERAL_RUNNER: '1', HAFLEET_DISPATCH_CAPABILITY: 'cap-test', HAFLEET_DISPATCH_ID: 'dispatch-test', HAFLEET_RUNNER_ID: 'runner-test', HAFLEET_FENCE_GENERATION: '7',
      // Both redirected: the anchor lands under HOME and the ephemeral counts under TMPDIR, and a test
      // that isolated only one of them would write into the developer's real home directory.
      HOME: tmpdir,
      TMPDIR: tmpdir,
      MCP_HEARTBEAT_INTERVAL_MS: '600000',
      MCP_FETCH_TIMEOUT_MS: '4000',
      NO_PROXY: '*',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* the server also logs; non-JSON lines are not responses */ }
    }
  });

  let nextId = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    const timer = setTimeout(() => reject(new Error(`no response to ${method}`)), 15000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  return {
    async start() {
      await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'anchor-test', version: '1' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    call: (name, args = {}) => send('tools/call', { name, arguments: args }),
  };
}


describe('runner task MCP protocol', () => {
  test('routes runner task tools through capability-scoped operations', async () => {
    const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-mcp-task-'));
    temps.add(tmpdir);
    const { port, seen } = await fakeBackend({});
    const client = mcpClient(tmpdir, port);
    await client.start();
    for (const [tool, args, action] of [
      ['get_task', { id: 'task-one' }, 'get'],
      ['list_tasks', { assignee: '*', status: 'in_progress' }, 'list'],
      ['accept_task', { id: 'task-one' }, 'accept'],
      ['comment_task', { id: 'task-one', text: 'verified' }, 'comment'],
      ['update_task_execution', { id: 'task-one', heartbeat: true }, 'execution'],
      ['transition_task', { id: 'task-one', status: 'done' }, 'transition'],
    ]) {
      const result = await client.call(tool, args);
      expect(result.result?.isError, JSON.stringify(result)).not.toBe(true);
      const call = seen.filter(r => r.url === '/api/router/task-operations').at(-1);
      expect(call).toBeDefined();
      expect(call.body).toMatchObject({ agent: 'alpha', action });
      if (action !== 'list') expect(call.body.task_id).toBe('task-one');
      if (!['list', 'get'].includes(action)) expect(call.body.tool_call_id).toEqual(expect.any(String));
      expect(call.headers).toMatchObject({ 'x-hafleet-dispatch-capability': 'cap-test', 'x-hafleet-dispatch-id': 'dispatch-test', 'x-hafleet-runner-id': 'runner-test', 'x-hafleet-fence-generation': '7' });
      expect(call.headers.authorization).toBeUndefined();
    }
    expect(seen.some(r => r.url.startsWith('/api/tasks'))).toBe(false);
  });
});
