import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { prepareClaudeThreadRuntime, claudeThreadModel } from '../lib/claude-thread-runtime.js';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';
import { approvalVerdict } from '../mockup/lib/console-workflow.js';

let root;
let context;
let homeserver;
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'claude-thread-runtime-')); });
afterEach(async () => {
  await context?.cleanup(); context = null;
  if (homeserver) await new Promise((resolve) => homeserver.close(resolve));
  homeserver = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const options = () => ({ repoRoot: path.resolve('.'), runtimeRoot: root, apiBaseUrl: 'http://127.0.0.1:8090', serverName: 'hagency' });
const agent = () => ({ name: 'docs', workdir: root, stateDir: path.join(root, 'state'),
  runtimeProfile: { primary: { model: 'claude-fable-5' } } });
const read = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
function seed(relative, value) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('Claude thread runtime configuration', () => {
  test('Claude runtime configuration preserves other settings and never persists inherited tokens', () => {
    const secret = 'fixture-private-never-persist';
    vi.stubEnv('AGENT_TOKEN', secret);
    vi.stubEnv('API_TOKEN', secret);
    vi.stubEnv('HAGENCY_SESSION_API_TOKEN', secret);
    seed('.mcp.json', { mcpServers: { other: { command: 'other-tool', args: ['--fixture'] } }, unrelated: true });
    seed('.claude/settings.json', { hooks: { PreToolUse: [] }, theme: 'dark',
      permissions: { allow: ['Read'], deny: ['Bash(rm *)'], ask: ['Write'] } });
    prepareClaudeThreadRuntime({ ...agent(), token: secret, runtimeProfile: { primary: { model: 'claude-fable-5', apiKey: secret } } }, options());
    const mcp = read('.mcp.json');
    expect(mcp.unrelated).toBe(true);
    expect(mcp.mcpServers.other).toEqual({ command: 'other-tool', args: ['--fixture'] });
    expect(mcp.mcpServers.hagency).toMatchObject({ command: process.execPath,
      args: [path.resolve('mcp-server.js')], env: { AGENT_NAME: 'docs', HAGENCY_MCP_SERVER_NAME: 'hagency' } });
    expect(Object.keys(mcp.mcpServers.hagency.env).sort()).toEqual([
      'AGENT_NAME', 'HAGENCY_AGENT_STATE_DIR', 'HAGENCY_API', 'HAGENCY_MCP_SERVER_NAME', 'HAGENCY_RUNTIME_DIR',
    ]);
    expect(read('.claude/settings.json')).toEqual({ hooks: { PreToolUse: [] }, theme: 'dark',
      permissions: { allow: ['Read'], deny: ['Bash(rm *)'], ask: ['Write', 'Bash(gh *)', 'Bash(git push *)'] } });
    expect(readFileSync(path.join(root, '.mcp.json'), 'utf8')).not.toContain(secret);
    expect(readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).not.toContain(secret);
    const before = statSync(path.join(root, '.mcp.json')).mtimeMs;
    prepareClaudeThreadRuntime(agent(), options());
    expect(statSync(path.join(root, '.mcp.json')).mtimeMs).toBe(before);
    expect(read('.claude/settings.json').permissions.ask).toHaveLength(3);
    expect(statSync(path.join(root, '.mcp.json')).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(root, '.claude/settings.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test.each([
    ['.mcp.json', '{broken'],
    ['.mcp.json', 'null'],
    ['.mcp.json', '[]'],
    ['.mcp.json', { mcpServers: [] }],
    ['.mcp.json', { mcpServers: null }],
    ['.claude/settings.json', { permissions: null }],
    ['.claude/settings.json', { permissions: false }],
    ['.claude/settings.json', { permissions: [] }],
    ['.claude/settings.json', { permissions: { ask: null } }],
    ['.claude/settings.json', { permissions: { ask: 'allow all' } }],
    ['.claude/settings.json', { permissions: { ask: [true] } }],
  ])('Claude runtime refuses invalid configuration without replacing it (%s %j)', (file, content) => {
    seed(file, content);
    const before = readFileSync(path.join(root, file), 'utf8');
    expect(() => prepareClaudeThreadRuntime(agent(), options())).toThrow();
    expect(readFileSync(path.join(root, file), 'utf8')).toBe(before);
  });

  test('Claude runtime rejects linked config files and settings directories', () => {
    seed('foreign.json', { preserve: true });
    symlinkSync(path.join(root, 'foreign.json'), path.join(root, '.mcp.json'));
    expect(() => prepareClaudeThreadRuntime(agent(), options())).toThrow(/symlink/);
    expect(read('foreign.json')).toEqual({ preserve: true });
    rmSync(path.join(root, '.mcp.json'));
    mkdirSync(path.join(root, 'foreign-settings'));
    symlinkSync(path.join(root, 'foreign-settings'), path.join(root, '.claude'));
    expect(() => prepareClaudeThreadRuntime(agent(), options())).toThrow(/symlink/);
    expect(readdirSync(path.join(root, 'foreign-settings'))).toEqual([]);
  });

  test('Claude model selection honors primary and explicit override while refusing invalid model values', () => {
    expect(claudeThreadModel(agent())).toBe('claude-fable-5');
    expect(claudeThreadModel(agent(), 'claude-opus-5')).toBe('claude-opus-5');
    expect(claudeThreadModel({})).toBeNull();
    for (const model of ['--no-permissions', 'opus;touch /tmp/no', 'claude opus', {}, true]) {
      expect(() => claudeThreadModel(agent(), model)).toThrow('invalid Claude runtime model');
    }
    expect(() => claudeThreadModel({ runtimeProfile: { primary: { model: '../other' } } })).toThrow();
    expect(() => prepareClaudeThreadRuntime({ ...agent(), workdir: 'relative' }, options())).toThrow(/absolute/);
  });

  async function verifyProvisionedRuntime({ earlierUnsupported = false } = {}) {
    const side = 'claude-fixture.test';
    const room = `!project:${side}`;
    const model = earlierUnsupported ? 'claude-opus-5' : 'claude-fable-5';
    homeserver = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(url.pathname.endsWith('/whoami')
        ? { user_id: url.searchParams.get('user_id') }
        : url.pathname.includes('/join/') ? { room_id: room } : {}));
    });
    await new Promise((resolve) => homeserver.listen(0, '127.0.0.1', resolve));
    context = await createBackendTestContext('claude-fulfillment-', {
      agents: {},
      frameworkPresets: [
        ...(earlierUnsupported ? [{ id: 'a-unsupported', name: 'Earlier same-tier resource', framework: 'octos',
          model: 'kimi-k3', ceiling: { tokens: 10000, period: 'monthly' } }] : []),
        { id: 'docs-preset', name: 'Documentation contribution', framework: 'claude',
          model, ceiling: { tokens: 10000, period: 'monthly' } },
      ],
      env: { HAGENCY_MCP_SERVER_NAME: 'hagency', HAGENCY_THREAD_SESSIONS: '0', HAGENCY_ROUTER_TASK_CUTOVER: '0',
        HAGENCY_OWNER_MXID: '', HAGENCY_OWNER_DM_ROOM: '' },
    });
    const launches = [];
    context.internals.setEngagementLauncherForTest(async (row) => {
      // Assert readiness at the real launch boundary, before the test substitute returns.
      const config = JSON.parse(readFileSync(path.join(row.workdir, '.mcp.json'), 'utf8'));
      const settings = JSON.parse(readFileSync(path.join(row.workdir, '.claude/settings.json'), 'utf8'));
      expect(config.mcpServers.hagency.env.AGENT_NAME).toBe(row.name);
      expect(settings.permissions.ask).toEqual(expect.arrayContaining(['Bash(gh *)', 'Bash(git push *)']));
      launches.push({ name: row.name, model: claudeThreadModel(row) });
    });
    await request(context.app).post('/api/project-sides').send({ server_name: side,
      api_base_url: `http://127.0.0.1:${homeserver.address().port}` }).expect(200);
    await request(context.app).put(`/api/project-sides/${side}/credential`).send({ credential: {
      kind: 'appservice', asToken: 'fixture-as', hsToken: 'fixture-hs', namespace: '@ac_.*', senderLocalpart: 'hagency',
    } }).expect(200);
    await request(context.app).put(`/api/project-sides/${side}/allocation`).send({ allocated_tokens: 10000 }).expect(200);
    const pending = await request(context.app).post('/api/engagements').send({ project: 'fixture', projectRoomId: room,
      role: 'documentation', requester: `@borrower:${side}`, requestedTokens: 1000 }).expect(200);
    expect(pending.body.engagement.agent).toBeNull();
    const accepted = await request(context.app).post(`/api/engagements/${pending.body.engagement.id}/verdict`).send(approvalVerdict({
      tokens: 1000, ownerMxid: `@owner:${side}`, ownerDmRoomId: `!private:${side}`, projectRoomId: room,
    }));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.engagement.state).toBe('active');
    expect(accepted.body.engagement.fulfillment.presetId).toBe('docs-preset');
    expect(launches).toEqual([{ name: accepted.body.engagement.agent, model }]);
  }

  test('provisioned Claude runtime prepares MCP configuration and selects its primary model', async () => {
    await verifyProvisionedRuntime();
  });

  test('on-demand fulfillment skips an earlier unsupported framework and provisions a supported resource', async () => {
    await verifyProvisionedRuntime({ earlierUnsupported: true });
  });

  async function queueClaudeDispatch({ model = 'claude-fable-5', override } = {}) {
    context = await createBackendTestContext('claude-argv-dispatch-', {
      env: { HAGENCY_THREAD_SESSIONS: '1', HAGENCY_ROUTER_TASK_CUTOVER: '1', HAGENCY_CLAUDE_PERMISSION_CHANNEL: '1',
        HAGENCY_CLAUDE_RUNNER_BIN: path.resolve('tests/fixtures/fake-claude-launch-argv.mjs'), HAGENCY_RUNNER_LAUNCH_RETRY_MS: '1000' },
      agentTokens: { docs: 'claude-argv-test-token' },
      agents: { docs: { name: 'docs', agentId: 'agent_docs', kind: 'agent', type: 'claude', online: true,
        workdir: root, homeDir: root, stateDir: path.join(root, 'state'),
        runtimeProfile: { primary: { framework: 'claude', model } } } },
    });
    const router = context.internals.routerStoreForTest;
    const input = router.ingestMessage({ messageId: 'argv-input', roomId: '!argv:test', matrixEventId: '$argv-input',
      senderName: 'owner', recipientAgentId: 'agent_docs', recipientAgentName: 'docs', normalizedBody: 'Verify dispatch configuration' });
    if (override) expect(router.setSessionOverrides({ agentId: 'agent_docs', agentName: 'docs', roomId: '!argv:test',
      model: override, requestedBy: '@owner:test' }).ok).not.toBe(false);
    router.registerWorkspace({ resourceId: 'argv-workspace', safeLabel: 'argv workspace', backendPath: root });
    const queued = router.enqueueDispatch({ sessionId: input.session.sessionId, framework: 'claude', localServerId: 'local',
      workspaceResourceId: 'argv-workspace', mayWrite: false, payload: {} });
    expect(queued.ok).toBe(true);
    context.internals.scheduleRouterPumpForTest();
    return { router, dispatchId: queued.dispatchId, sessionId: input.session.sessionId };
  }

  test.each([undefined, 'claude-sonnet-5'])('actual Claude dispatch argv carries the primary model or explicit override (%s)', async (override) => {
    const { router, dispatchId } = await queueClaudeDispatch({ override });
    await vi.waitFor(() => expect(router.snapshot().dispatches.find((row) => row.dispatchId === dispatchId)?.state).toBe('completed'), { timeout: 10000 });
    const launch = read('claude-launch-record.json');
    expect(launch.argv[launch.argv.indexOf('--model') + 1]).toBe(override || 'claude-fable-5');
    expect(launch.argv).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--dangerously-load-development-channels', 'server:hagency']));
    expect(launch.settings.permissions.ask).toEqual(expect.arrayContaining(['Bash(gh *)', 'Bash(git push *)']));
    expect(launch.mcp.mcpServers.hagency.env.AGENT_NAME).toBe('docs');
    expect(JSON.stringify(launch)).not.toContain('claude-argv-test-token');
  });

  test.each(['model', 'settings'])('invalid stored Claude %s cancels before execution with an actionable notice instead of repeated launch retries', async (invalid) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    if (invalid === 'settings') seed('.claude/settings.json', { permissions: null });
    const { router, dispatchId, sessionId } = await queueClaudeDispatch({ model: invalid === 'model' ? '--invalid-model' : 'claude-fable-5' });
    await vi.waitFor(() => expect(router.snapshot().dispatches.find((row) => row.dispatchId === dispatchId)?.state).toBe('cancelled_before_start'), { timeout: 5000 });
    expect(router.db.prepare('SELECT launch_failures, terminal_reason FROM dispatches WHERE dispatch_id = ?').get(dispatchId))
      .toEqual({ launch_failures: 0, terminal_reason: 'runner_launch_failed' });
    expect(router.db.prepare('SELECT body FROM notice_outbox WHERE dispatch_id = ?').get(dispatchId).body).toContain('fix the runtime configuration and resend');
    expect(router.db.prepare('SELECT processed_at FROM session_messages WHERE session_id = ?').get(sessionId).processed_at).toBeNull();
    expect(router.nextQueuedDispatchAt()).toBeNull();
    expect(existsSync(path.join(root, 'claude-launch-record.json'))).toBe(false);
  });
});
