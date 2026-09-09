import { afterEach, describe, expect, test } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { openRouter } from '../router/dist/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const cleanup = [];
const execFileAsync = promisify(execFile);
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(fileWorkspace = false, projectSide = null) {
  const agents = Object.fromEntries(['worker', 'peer', 'outsider'].map((name) => [name, {
    name, agentId: `agent_${name}`, kind: 'agent', type: 'codex', workdir: process.cwd(), online: true, ...(projectSide ? { projectSide } : {}),
  }]));
  const context = await createBackendTestContext('hafleet-session-tools-', {
    agents, agentTokens: { worker: 'worker-secret', peer: 'peer-secret', outsider: 'outsider-secret' },
    env: { HAFLEET_THREAD_SESSIONS: '1', HAFLEET_ROUTER_TASK_CUTOVER: '1', HAFLEET_AGENT_TOKEN_MODE: 'hard', API_TOKEN: 'operator-secret', MATRIX_BRIDGE_SECRET: 'bridge-secret' },
  });
  const router = context.internals.routerStoreForTest;
  context.internals.stopRouterPumpForTest();
  cleanup.push(() => { router.close(); context.cleanup(); });
  function makeTask(name, suffix, room = '!project:test') {
    const input = `input-${suffix}`;
    router.ingestMessage({ messageId: input, roomId: room, matrixEventId: `$${suffix}`,
      senderName: 'owner', recipientAgentId: `agent_${name}`, recipientAgentName: name, normalizedBody: `work ${suffix}` });
    const task = router.createTaskIntent({ requestScope: 'fixture', requestKey: suffix, roomId: room,
      rootMessageId: input, threadRootEventId: `$${suffix}`, inputMessageIds: [input],
      task: { title: suffix, assigneeAgentId: `agent_${name}`, assigneeName: name } });
    const command = router.claimMatrixCommand();
    const activated = router.recordMatrixDelivery({ commandId: command.commandId, claimToken: command.claimToken, eventId: `$anchor-${suffix}` });
    return { ...task, sessionId: activated.sessionId, input };
  }
  const own = makeTask('worker', 'own');
  const other = makeTask('worker', 'other', '!foreign:test');
  const peer = makeTask('peer', 'peer');
  router.ingestMessage({ messageId: 'peer-coordination', roomId: '!project:test', threadRootEventId: '$own',
    senderName: 'peer', recipientAgentId: 'agent_worker', recipientAgentName: 'worker',
    normalizedBody: 'A peer reply has no authenticated Matrix event id', receivedAt: Date.now() + 1 });
  const workspace = fileWorkspace ? path.join(context.runtimeDir, 'work') : process.cwd();
  mkdirSync(workspace, { recursive: true });
  router.registerWorkspace({ resourceId: 'work', safeLabel: 'work', backendPath: workspace });
  router.enqueueDispatch({ sessionId: own.sessionId, taskId: own.taskId, framework: 'codex',
    localServerId: 'local', workspaceResourceId: 'work', mayWrite: true, payload: {} });
  const claim = router.claimDispatch({ runnerId: 'test-runner', leaseMs: 60_000, capabilityTtlMs: 60_000, maxLiveRunners: 3 });
  expect(router.takePayload(claim).ok).toBe(true);
  for (const name of ['worker', 'peer']) {
    expect((await request(context.app).put('/api/approval-bindings').set('X-Bridge-Secret', 'bridge-secret')
      .send({ agent: name, project: 'test', project_room_id: '!project:test', owner_mxid: '@owner:test', owner_dm_room_id: '!private:test' })).status).toBe(200);
  }
  const headers = { 'X-Agent-Token': 'worker-secret', 'X-HAFleet-Dispatch-Id': claim.dispatchId,
    'X-HAFleet-Runner-Id': claim.runnerId, 'X-HAFleet-Dispatch-Capability': claim.capability,
    'X-HAFleet-Fence-Generation': String(claim.fenceGeneration) };
  return { context, router, own, other, peer, claim, headers };
}

async function connectMcp(context, claim) {
  const serving = await context.listen();
  cleanup.push(() => serving.close());
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('mcp-server.js')], stderr: 'pipe',
    env: { PATH: process.env.PATH, AGENT_NAME: 'worker', AGENT_TOKEN: 'worker-secret', HAFLEET_API: serving.baseUrl,
      HAFLEET_RUNTIME_DIR: context.runtimeDir, HAFLEET_EPHEMERAL_RUNNER: '1', HAFLEET_AGENT_ID: 'agent_worker',
      HAFLEET_DISPATCH_ID: claim.dispatchId, HAFLEET_RUNNER_ID: claim.runnerId, HAFLEET_DISPATCH_CAPABILITY: claim.capability,
      HAFLEET_FENCE_GENERATION: String(claim.fenceGeneration), HAFLEET_CLAUDE_PERMISSION_CHANNEL: '0' } });
  const client = new Client({ name: 'session-test', version: '1' }, { capabilities: {} });
  cleanup.push(() => client.close());
  await client.connect(transport);
  return async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { result, text, data: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
}

async function delegatedChildFixture() {
  const f = await fixture();
  const created = await request(f.context.app).post('/api/router/messages').set(f.headers).send({
    agent: 'worker', to: 'peer', type: 'request', summary: 'README child', full: 'Return the README',
    tool_call_id: 'delegate-readme', root_message_id: f.own.input,
  });
  expect(created.status).toBe(201);
  expect(f.router.settleAndRelease({ ...f.claim, outcome: 'completed', output: { text: 'Waiting for README' } }).ok).toBe(true);
  const command = f.router.claimMatrixCommand();
  const child = f.router.recordMatrixDelivery({ commandId: command.commandId,
    claimToken: command.claimToken, eventId: '$child-anchor' });
  expect(child.ok).toBe(true);
  f.router.registerWorkspace({ resourceId: 'child-work', safeLabel: 'child', backendPath: process.cwd() });
  expect(f.router.enqueueDispatch({ sessionId: child.sessionId, taskId: child.taskId, framework: 'codex',
    localServerId: 'local', workspaceResourceId: 'child-work', mayWrite: true, payload: {} }).ok).toBe(true);
  const childClaim = f.router.claimDispatch({ runnerId: 'child-runner', leaseMs: 60_000, capabilityTtlMs: 60_000, maxLiveRunners: 3 });
  expect(f.router.takePayload(childClaim).ok).toBe(true);
  const childHeaders = { 'X-Agent-Token': 'peer-secret', 'X-HAFleet-Dispatch-Id': childClaim.dispatchId,
    'X-HAFleet-Runner-Id': childClaim.runnerId, 'X-HAFleet-Dispatch-Capability': childClaim.capability,
    'X-HAFleet-Fence-Generation': String(childClaim.fenceGeneration) };
  const reply = { agent: 'peer', to: 'worker', type: 'reply', full: '# README\n\nExact child artifact.',
    target_task_id: f.own.taskId, tool_call_id: 'readme-reply' };
  return { ...f, child, childClaim, childHeaders, reply };
}

async function taskWriterFixture() {
  const f = await fixture();
  const serving = await f.context.listen();
  cleanup.push(() => serving.close());
  const homeDir = path.join(f.context.runtimeDir, 'writer-home');
  const workdir = path.join(homeDir, 'workdir');
  mkdirSync(workdir, { recursive: true });
  const manifestPath = path.join(homeDir, 'agent.json');
  writeFileSync(manifestPath, JSON.stringify({ name: 'worker', id: 'agent_worker', type: 'codex',
    homeDir, workdir, stateDir: path.join(homeDir, 'state'), layoutVersion: 1, agentModelVersion: '1.0',
    task: { id: 'legacy-unrelated', owner: 'worker', status: 'active', updated_at: '2026-01-01T00:00:00Z', heartbeat_at: '2026-01-01T00:00:00Z' },
  }));
  const beforeManifest = readFileSync(manifestPath, 'utf8');
  const run = async (args, overrides = {}) => {
    const result = await execFileAsync(process.execPath, [path.resolve('scripts/write-v1-agent-task.js'),
      '--workdir', workdir, ...args], { cwd: workdir, timeout: 5000, env: {
      PATH: process.env.PATH, HAFLEET_API: serving.baseUrl, AGENT_TOKEN: 'worker-secret',
      HAFLEET_EPHEMERAL_RUNNER: '1', HAFLEET_DISPATCH_ID: f.claim.dispatchId,
      HAFLEET_RUNNER_ID: f.claim.runnerId, HAFLEET_DISPATCH_CAPABILITY: f.claim.capability,
      HAFLEET_FENCE_GENERATION: String(f.claim.fenceGeneration), ...overrides,
    } });
    expect(readFileSync(manifestPath, 'utf8')).toBe(beforeManifest);
    return JSON.parse(result.stdout);
  };
  return { ...f, run, manifestPath, beforeManifest };
}

describe('ephemeral session tools', () => {
  test('MCP lifecycle maintenance needs no owner approval and confirms explicit completion', async () => {
    const { context, router, own, claim } = await fixture();
    const invoke = await connectMcp(context, claim);
    const until = '2026-12-01T00:00:00.000Z';
    expect((await invoke('update_task_execution', { id: own.taskId, heartbeat: true,
      waiting_reason: 'checking child result', waiting_until: until })).data)
      .toMatchObject({ ok: true, task: { id: own.taskId, status: 'in_progress', heartbeat_at: expect.any(String),
        waiting_reason: 'checking child result', waiting_until: until } });
    expect((await invoke('transition_task', { id: own.taskId, status: 'blocked',
      waiting_reason: 'waiting for child', waiting_until: until })).data.task.status).toBe('blocked');
    expect((await invoke('update_task_execution', { id: own.taskId, heartbeat: true })).data.task)
      .toMatchObject({ status: 'blocked', waiting_reason: 'waiting for child', waiting_until: until });
    expect((await invoke('transition_task', { id: own.taskId, status: 'in_progress' })).data.task.status).toBe('in_progress');
    expect((await invoke('update_task_execution', { id: own.taskId, waiting_reason: '', waiting_until: '' })).data.task)
      .toMatchObject({ status: 'in_progress', waiting_reason: null, waiting_until: null });
    expect((await invoke('transition_task', { id: own.taskId, status: 'done' })).data.task)
      .toMatchObject({ status: 'done', completed_at: expect.any(String) });
    expect(context.internals.approvalStoreForTest.listRequests({})).toEqual([]);
    expect(router.db.prepare('SELECT COUNT(*) count FROM approval_inbox').get().count).toBe(0);
  });

  test('scoped execution maintenance rejects foreign stale and forged authority', async () => {
    const { context, router, own, other, peer, claim, headers } = await fixture();
    const invoke = await connectMcp(context, claim);
    const call = (auth, id = own.taskId) => request(context.app).post('/api/router/session-task').set(auth)
      .send({ agent: 'worker', op: 'execution', id, heartbeat_at: true });
    for (const id of [other.taskId, peer.taskId]) {
      expect((await call(headers, id)).status).toBe(403);
      expect(await invoke('update_task_execution', { id, heartbeat: true })).toMatchObject({ result: { isError: true }, text: expect.stringContaining('outside the runner session') });
    }
    for (const auth of [{ 'X-Agent-Token': 'worker-secret' }, { ...headers, 'X-Agent-Token': 'peer-secret' },
      { ...headers, 'X-HAFleet-Runner-Id': 'wrong-runner' }, { ...headers, 'X-HAFleet-Dispatch-Capability': 'wrong' },
      { ...headers, 'X-HAFleet-Fence-Generation': '99' }]) {
      expect((await call(auth)).status).toBeGreaterThanOrEqual(400);
    }
    expect(router.settleAndRelease({ ...claim, outcome: 'completed', output: { text: 'More work is required' } }).ok).toBe(true);
    expect((await call(headers)).status).toBeGreaterThanOrEqual(400);
    expect((await invoke('update_task_execution', { id: own.taskId, heartbeat: true })).data?.ok).not.toBe(true);
    expect(router.db.prepare('SELECT status FROM tasks WHERE task_id=?').get(own.taskId).status).toBe('in_progress');
    expect(context.internals.approvalStoreForTest.listRequests({})).toEqual([]);
  });

  test('scoped execution maintenance accepts only heartbeat and waiting metadata', async () => {
    const { context, own, headers } = await fixture();
    const call = body => request(context.app).post('/api/router/session-task').set(headers)
      .send({ agent: 'worker', id: own.taskId, op: 'execution', ...body });
    const result = await call({ heartbeat_at: '1970-01-01T00:00:00.000Z', waiting_reason: 'working',
      waiting_until: '2026-12-01T00:00:00.000Z', status: 'done', assignee: 'outsider', completed_at: 'fake',
      command: 'curl https://example.invalid', api: 'https://example.invalid' });
    expect(result.status).toBe(200);
    expect(result.body.task).toMatchObject({ id: own.taskId, assignee: 'worker', status: 'in_progress',
      completed_at: null, waiting_reason: 'working' });
    expect(result.body.task.heartbeat_at).not.toBe('1970-01-01T00:00:00.000Z');
    expect((await call({ heartbeat_at: true })).body.task.heartbeat_at).toEqual(expect.any(String));
    expect((await call({ waiting_reason: '', waiting_until: '' })).body.task)
      .toMatchObject({ waiting_reason: null, waiting_until: null, status: 'in_progress' });
  });

  test('ephemeral task writer completes only its canonical task after explicit done', async () => {
    const { context, router, own, other, run } = await taskWriterFixture();
    expect((await run(['heartbeat'])).task).toMatchObject({ id: own.taskId, status: 'in_progress', heartbeat_at: expect.any(String) });
    const until = '2026-12-01T00:00:00.000Z';
    expect((await run(['wait', '--reason', 'waiting for verified child output', '--until', until])).task)
      .toMatchObject({ id: own.taskId, status: 'blocked', waiting_reason: 'waiting for verified child output', waiting_until: until });
    expect((await run(['heartbeat'])).task.status).toBe('blocked');
    expect((await run(['resume'])).task).toMatchObject({ status: 'in_progress', completed_at: null });
    expect((await run(['done'])).task).toMatchObject({ id: own.taskId, status: 'done', completed_at: expect.any(String) });
    expect((await run(['done'])).task.status).toBe('done');
    expect(router.db.prepare('SELECT status FROM tasks WHERE task_id=?').get(own.taskId).status).toBe('done');
    const tasks = (await request(context.app).get('/api/tasks').set('Authorization', 'Bearer operator-secret')).body;
    expect(tasks.find(t => t.id === own.taskId).status).toBe('done');
    expect(tasks.find(t => t.id === other.taskId).status).not.toBe('done');
  });

  test('ephemeral task writer refuses incomplete context foreign tasks and expired dispatches', async () => {
    const { router, own, other, claim, run, manifestPath, beforeManifest } = await taskWriterFixture();
    for (const overrides of [{ HAFLEET_DISPATCH_CAPABILITY: '' }, { HAFLEET_EPHEMERAL_RUNNER: '0' },
      { HAFLEET_FENCE_GENERATION: '0' }]) {
      await expect(run(['done'], overrides)).rejects.toMatchObject({ stderr: expect.stringContaining('incomplete ephemeral dispatch authority') });
    }
    await expect(run(['done', '--id', other.taskId])).rejects.toMatchObject({ stderr: expect.stringContaining('outside this dispatch') });
    await expect(run(['done', '--graph', 'foreign', '--node', 'task'])).rejects.toMatchObject({ stderr: expect.stringContaining('canonical start') });
    await expect(run(['done'], { HAFLEET_API: '' })).rejects.toMatchObject({ stderr: expect.stringContaining('assigned HAFLEET_API') });
    expect(router.settleAndRelease({ ...claim, outcome: 'completed', output: { text: 'Turn complete; more work is required' } }).ok).toBe(true);
    await expect(run(['done'])).rejects.toMatchObject({ stderr: expect.stringContaining('canonical task write failed') });
    expect(router.db.prepare('SELECT status FROM tasks WHERE task_id=?').get(own.taskId).status).toBe('in_progress');
    expect(readFileSync(manifestPath, 'utf8')).toBe(beforeManifest);
  });

  test('a scoped child reply resumes its completed parent dispatch exactly once', async () => {
    const { context, router, own, claim, child, childClaim, childHeaders, reply } = await delegatedChildFixture();
    const call = (body = reply) => request(context.app).post('/api/router/messages').set(childHeaders).send(body);
    const delivered = await call();
    expect(delivered.body).toMatchObject({ ok: true, taskId: own.taskId, queued: true, dispatchState: 'queued' });
    expect(delivered.body.dispatchId).not.toBe(claim.dispatchId);
    expect(router.snapshot().dispatches.find((d) => d.dispatchId === claim.dispatchId).state).toBe('completed');
    const replay = await call();
    expect(replay.body.dispatchId).toBe(delivered.body.dispatchId);
    expect((await call({ ...reply, full: 'Changed artifact' })).status).toBe(409);
    expect((await call({ ...reply, to: 'peer', target_task_id: child.taskId })).status).toBe(409);
    const resumed = router.claimDispatch({ runnerId: 'resumed-parent', leaseMs: 60_000, capabilityTtlMs: 60_000, maxLiveRunners: 3 });
    expect(resumed.dispatchId).toBe(delivered.body.dispatchId);
    const payload = router.takePayload(resumed);
    expect(payload.ok).toBe(true);
    expect(router.checkInbox(resumed)).toContainEqual(expect.objectContaining({ messageId: delivered.body.messageId, body: reply.full }));
    expect(router.checkInbox(childClaim)).not.toContainEqual(expect.objectContaining({ messageId: delivered.body.messageId }));
    expect(router.settleAndRelease({ ...resumed, outcome: 'completed', output: { text: 'Integrated README' } }).ok).toBe(true);
    expect((await call()).body).toMatchObject({ ok: true, queued: false, dispatchId: resumed.dispatchId, dispatchState: 'completed' });
    expect(router.snapshot().dispatches.filter((d) => d.taskId === own.taskId)).toHaveLength(2);
  });

  test('pending scoped replies recover their task association without replaying completed work', async () => {
    const { context, router, own, childClaim, reply } = await delegatedChildFixture();
    // Reproduce the former accepted-send transaction: immutable router message
    // and session projection persisted, but no task input or dispatch was made.
    const messageId = `peer_${createHash('sha256').update(`${childClaim.dispatchId}\0${reply.tool_call_id}`).digest('hex')}`;
    expect(router.ingestMessage({ messageId, roomId: '!project:test', threadRootEventId: '$own',
      senderName: 'peer', recipientAgentId: 'agent_worker', recipientAgentName: 'worker', normalizedBody: reply.full }).ok).toBe(true);
    expect(router.settleAndRelease({ ...childClaim, outcome: 'completed', output: { text: 'README returned' } }).ok).toBe(true);
    const reopened = openRouter({ dbPath: path.join(context.runtimeDir, 'data', 'router.db') });
    expect(reopened.listPendingPeerTaskInputs()).toContainEqual(expect.objectContaining({ messageId, taskId: own.taskId }));
    reopened.close();
    const reconcile = context.internals.reconcileThreadSessionPeerMessagesForTest;
    expect(await reconcile()).toMatchObject({ queued: 1 });
    expect(await reconcile()).toMatchObject({ queued: 0 });
    const claim = router.claimDispatch({ runnerId: 'recovered-parent', leaseMs: 60_000, capabilityTtlMs: 60_000, maxLiveRunners: 3 });
    expect(router.takePayload(claim).ok).toBe(true);
    expect(router.checkInbox(claim)).toContainEqual(expect.objectContaining({ messageId, body: reply.full }));
    const db = router.db;
    expect(db.prepare('SELECT task_id, role FROM task_inputs WHERE message_id = ?').all(messageId))
      .toEqual([{ task_id: own.taskId, role: 'supplement' }]);
    expect(router.settleAndRelease({ ...claim, outcome: 'completed', output: { text: 'Integrated' } }).ok).toBe(true);
    expect(await reconcile()).toMatchObject({ queued: 0 });
    expect(router.snapshot().dispatches.filter((d) => d.taskId === own.taskId)).toHaveLength(2);
  });

  test('peer reply recovery retains pending data when current project authority is revoked', async () => {
    const { context, router, childClaim, reply } = await delegatedChildFixture();
    const messageId = `peer_${createHash('sha256').update(`${childClaim.dispatchId}\0${reply.tool_call_id}`).digest('hex')}`;
    const message = { messageId, roomId: '!project:test', threadRootEventId: '$own', senderName: 'peer',
      recipientAgentId: 'agent_worker', recipientAgentName: 'worker', normalizedBody: reply.full };
    router.ingestMessage(message);
    router.ingestMessage({ ...message, messageId: `peer_${'a'.repeat(64)}`, senderName: 'outsider' });
    router.ingestMessage({ ...message, messageId: `peer_${'b'.repeat(64)}`, matrixEventId: '$foreign-matrix-origin' });
    expect(router.listPendingPeerTaskInputs().map((row) => row.messageId)).toEqual([messageId]);
    context.internals.approvalStoreForTest.removeBinding('peer', '!project:test');
    expect(await context.internals.reconcileThreadSessionPeerMessagesForTest()).toMatchObject({ queued: 0 });
    const db = router.db;
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_inputs WHERE message_id = ?').get(messageId).count).toBe(0);
    expect(db.prepare('SELECT processed_at FROM session_messages WHERE message_id = ?').get(messageId).processed_at).toBeNull();
  });

  test('peer input attachment failure rolls back its message and session projection', async () => {
    const { context, router, childClaim, childHeaders, reply } = await delegatedChildFixture();
    const messageId = `peer_${createHash('sha256').update(`${childClaim.dispatchId}\0${reply.tool_call_id}`).digest('hex')}`;
    const db = router.db;
    try {
      db.exec("CREATE TRIGGER fail_peer_attachment BEFORE INSERT ON task_inputs WHEN NEW.message_id LIKE 'peer_%' BEGIN SELECT RAISE(ABORT, 'test attachment unavailable'); END");
      const failed = await request(context.app).post('/api/router/messages').set(childHeaders).send(reply);
      expect(failed.body.ok).not.toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS count FROM router_messages WHERE message_id = ?').get(messageId).count).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS count FROM session_messages WHERE message_id = ?').get(messageId).count).toBe(0);
      expect(router.listPendingPeerTaskInputs()).toEqual([]);
      db.exec('DROP TRIGGER fail_peer_attachment');
      expect((await request(context.app).post('/api/router/messages').set(childHeaders).send(reply)).body).toMatchObject({ ok: true, queued: true });
    } finally { db.exec('DROP TRIGGER IF EXISTS fail_peer_attachment'); }
  });

  test('ephemeral task tools remain restricted to their authenticated session', async () => {
    const { context, own, other, headers } = await fixture();
    const call = (body, auth = headers) => request(context.app).post('/api/router/session-task').set(auth).send({ agent: 'worker', ...body });
    expect((await call({ op: 'get', id: own.taskId })).body).toMatchObject({ id: own.taskId, status: 'in_progress' });
    expect((await call({ op: 'list' })).body.map((t) => t.id)).toEqual([own.taskId]);
    expect((await call({ op: 'get', id: other.taskId })).status).toBe(403);
    expect((await call({ op: 'transition', id: other.taskId, status: 'done' })).status).toBe(403);
    expect((await call({ op: 'get', id: own.taskId }, { 'X-Agent-Token': 'worker-secret' })).status).toBe(401);
    expect((await call({ op: 'get', id: own.taskId }, { ...headers, 'X-HAFleet-Fence-Generation': '99' })).status).toBeGreaterThanOrEqual(400);
    expect((await call({ op: 'comment', id: own.taskId, text: 'Real work product', author: 'outsider' })).body.task.comments[0].author).toBe('worker');
    expect((await call({ op: 'transition', id: own.taskId, status: 'done' })).body.task.status).toBe('done');
  });

  test('ephemeral messaging derives its scope from the active dispatch', async () => {
    const { context, router, own, peer, headers } = await fixture();
    const call = (body) => request(context.app).post('/api/router/messages').set(headers).send({ agent: 'worker', ...body });
    expect((await call({ to: 'outsider', type: 'request', full: 'steal another room', tool_call_id: 'bad' })).status).toBe(403);
    expect((await call({ to: 'peer', type: 'inform', full: 'wrong room', room_id: '!foreign:test', tool_call_id: 'bad-room' })).status).toBe(400);
    const reply = await call({ to: 'peer', type: 'inform', full: 'Work product is ready', tool_call_id: 'reply-1' });
    expect(reply.body).toMatchObject({ ok: true, taskId: peer.taskId, queued: true });
    expect(router.assembleContext(peer.sessionId).messages).toContainEqual(expect.objectContaining({ senderName: 'worker', body: 'Work product is ready' }));
    const delegated = await call({ to: 'peer', type: 'request', summary: 'Independent child', full: 'Complete the child', tool_call_id: 'child-1', root_message_id: own.input });
    expect(delegated.status).toBe(201);
    const getChild = await request(context.app).post('/api/router/session-task').set(headers)
      .send({ agent: 'worker', op: 'get', id: delegated.body.task.taskId });
    expect(getChild.body).toMatchObject({ parent_id: own.taskId, created_by: 'worker', assignee: 'peer' });
    expect((await request(context.app).post('/api/router/session-task').set(headers)
      .send({ agent: 'worker', op: 'transition', id: delegated.body.task.taskId, status: 'done' })).status).toBe(403);
    expect((await call({ to: 'peer', type: 'request', summary: 'Independent child', full: 'Complete the child', tool_call_id: 'child-1', root_message_id: own.input })).body.task.replayed).toBe(true);
    expect((await request(context.app).post('/api/router/tasks').set(headers).send({ agent: 'worker', assignee: 'outsider',
      title: 'escape', root_message_id: own.input, tool_call_id: 'escape' })).status).toBe(403);
  });

  test('real MCP task and messaging tools reach only scoped backend routes', async () => {
    const { context, own, other, claim } = await fixture();
    const invoke = await connectMcp(context, claim);
    expect((await invoke('get_task', { id: own.taskId })).data.id).toBe(own.taskId);
    expect(await invoke('get_task', { id: other.taskId })).toMatchObject({ result: { isError: true }, text: expect.stringContaining('outside the runner session') });
    expect((await invoke('send_message', { to: 'peer', type: 'request', summary: 'MCP delegation', full: 'Read-only child' })).data).toMatchObject({ ok: true, task: { ok: true } });
    expect((await invoke('transition_task', { id: own.taskId, status: 'done' })).data).toMatchObject({ ok: true, task: { status: 'done' } });
  });

  test('MCP created tasks default to the current parent and remain readable by their creator', async () => {
    const { context, own, other, claim } = await fixture();
    const invoke = await connectMcp(context, claim);
    const foreignParent = await invoke('create_task', { assignee: 'peer', title: 'Foreign parent',
      root_message_id: own.input, parent_id: other.taskId });
    expect(foreignParent.text).toContain('delegation parent must be the current dispatch task');
    const created = await invoke('create_task', { assignee: 'peer', title: 'MCP child', root_message_id: own.input });
    expect(created.data).toMatchObject({ ok: true, task: { ok: true } });
    const id = created.data.task.taskId;
    expect((await invoke('get_task', { id })).data).toMatchObject({ id, parent_id: own.taskId, assignee: 'peer', created_by: 'worker' });
    expect((await invoke('list_tasks', { assignee: '*' })).data.map((task) => task.id)).toEqual(expect.arrayContaining([own.taskId, id]));
    expect(await invoke('transition_task', { id, status: 'done' })).toMatchObject({ result: { isError: true }, text: expect.stringContaining('only the active task assignee') });
  });

  test.each([undefined, null])('task API defaults a %s parent to its authenticated dispatch', async (parent) => {
    const { context, own, headers } = await fixture();
    const result = await request(context.app).post('/api/router/tasks').set(headers).send({ agent: 'worker', assignee: 'peer',
      title: 'Default child', root_message_id: own.input, tool_call_id: 'default-child', ...(parent === undefined ? {} : { parent_id: parent }) });
    expect(result.status).toBe(201);
    const child = await request(context.app).post('/api/router/session-task').set(headers)
      .send({ agent: 'worker', op: 'get', id: result.body.task.taskId });
    expect(child.body).toMatchObject({ parent_id: own.taskId, created_by: 'worker', assignee: 'peer' });
  });
});


test('managed MCP sends a file through a fenced current conversation outbox', async () => {
  const { context, router, claim, headers } = await fixture(true);
  writeFileSync(path.join(context.runtimeDir, 'work', 'report.txt'), 'MCP actual file bytes');
  const invoke = await connectMcp(context, claim);
  const media = path.join(context.runtimeDir, 'data', 'matrix', 'media'); mkdirSync(media, { recursive: true });
  const incomingPath = path.join(media, 'incoming.csv'), bytes = 'a,b\n1,2'; writeFileSync(incomingPath, bytes);
  const archived = await request(context.app).post('/api/matrix/conversations/events').set('X-Bridge-Secret', 'bridge-secret')
    .send({ roomId: '!project:test', eventId: '$own', senderMxid: '@owner:test', body: 'incoming.csv', timestamp: 100,
      attachment: { path: incomingPath, name: 'incoming.csv', size: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') } });
  expect(archived.status).toBe(200);
  router.conversations.prepare(claim.dispatchId, '!project:test', 'agent_worker');
  const received = await invoke('receive_file', { event_id: '$own' });
  expect(received.data.name).toBe('incoming.csv'); expect(readFileSync(received.data.path, 'utf8')).toBe(bytes);
  expect((await invoke('receive_file', { event_id: '$foreign' })).result.isError).toBe(true);
  const sending = invoke('send_file', { path: 'report.txt' });
  let command;
  for (let i = 0; i < 200 && !command; i++) {
    command = router.claimReplyCommand();
    if (!command) await new Promise(resolve => setTimeout(resolve, 20));
  }
  expect(command?.file).toMatchObject({ name: 'report.txt' });
  expect(readFileSync(command.file.path, 'utf8')).toBe('MCP actual file bytes');
  expect(command.roomId).toBe('!project:test');
  expect((await request(context.app).post(`/api/router/reply-outbox/${command.commandId}/prepared-file`)
    .set(headers).send({ claim_token: command.claimToken, content: { msgtype: 'm.file' } })).status).toBeGreaterThanOrEqual(400);
  expect((await request(context.app).post(`/api/router/reply-outbox/${command.commandId}/delivered`)
    .set('X-Bridge-Secret', 'bridge-secret').send({ claim_token: command.claimToken, event_id: '$uploaded' })).status).toBe(200);
  expect((await sending).data).toMatchObject({ status: 'delivered', eventId: '$uploaded', filename: 'report.txt' });
  expect((await invoke('get_file_delivery', { delivery_id: command.commandId })).data.status).toBe('delivered');
  const escape = await invoke('send_file', { path: '../data/router.db' }); expect(escape.result.isError).toBe(true);
  const forged = await request(context.app).post('/api/router/files').set(headers).send({ agent: 'worker', op: 'send', path: 'report.txt', tool_call_id: 'redirect', room_id: '!evil:test' });
  expect(forged.status).toBe(400);
  expect((await request(context.app).post('/api/router/files').set({ ...headers, 'X-Agent-Token': 'peer-secret' })
    .send({ agent: 'worker', op: 'status', delivery_id: command.commandId })).status).toBeGreaterThanOrEqual(400);
});

test('historical attachments download only on an authorized receive and reuse verified bytes', async () => {
  const { context, router, claim, headers } = await fixture(true, 'test');
  let downloads = 0;
  const server = createServer((req, res) => {
    expect(req.url).toBe('/_matrix/client/v1/media/download/test/report');
    expect(req.headers.authorization).toBe('Bearer fixture-media-token');
    downloads++; res.end('historical report bytes');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => server.close(resolve)));
  const operator = { Authorization: 'Bearer operator-secret' };
  await request(context.app).post('/api/project-sides').set(operator)
    .send({ server_name: 'test', api_base_url: `http://127.0.0.1:${server.address().port}` }).expect(200);
  await request(context.app).put('/api/project-sides/test/credential').set(operator).send({ credential: {
    kind: 'registrationToken', registrationToken: 'fixture-registration-token', representativeToken: 'fixture-media-token',
  } }).expect(200);
  await request(context.app).post('/api/matrix/conversations/events').set('X-Bridge-Secret', 'bridge-secret')
    .send({ roomId: '!project:test', eventId: '$own', senderMxid: '@owner:test', body: 'report.txt', timestamp: 100,
      attachment: { remoteContent: { msgtype: 'm.file', body: 'report.txt', url: 'mxc://test/report' } } }).expect(200);
  router.conversations.prepare(claim.dispatchId, '!project:test', 'agent_worker');
  expect(downloads).toBe(0);
  await request(context.app).post('/api/router/files').set(headers).send({ agent: 'worker', op: 'receive', event_id: '$foreign' }).expect(404);
  expect(downloads).toBe(0);
  const receive = () => request(context.app).post('/api/router/files').set(headers).send({ agent: 'worker', op: 'receive', event_id: '$own' });
  const result = await receive().expect(200);
  expect(readFileSync(result.body.path, 'utf8')).toBe('historical report bytes');
  expect(result.body.remoteContent).toBeUndefined(); expect(downloads).toBe(1);
  expect((await receive().expect(200)).body.sha256).toBe(result.body.sha256);
  expect(downloads).toBe(1);
});
