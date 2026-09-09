import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import request from 'supertest';
import { createRouterTaskStore } from '../router/dist/index.js';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

test('direct messages continue one private conversation with project owner approval', async () => {
  let members = ['@alice:test', '@owner:test', '@rep:test', '@ac_worker:test'];
  const hs = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/joined_members')) return res.end(JSON.stringify({ joined: Object.fromEntries(members.map(id => [id, {}])) }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => hs.listen(0, '127.0.0.1', resolve));
  const context = await createBackendTestContext('direct-conversation-', {
    agents: { worker: { name: 'worker', agentId: 'agent_worker', type: 'codex', kind: 'agent', online: true,
      workdir: process.cwd(), workspaceMode: 'shared', projectSide: 'test' } },
    agentTokens: { worker: 'worker-secret' },
    env: { HAFLEET_THREAD_SESSIONS: '1', HAFLEET_ROUTER_TASK_CUTOVER: '1', MATRIX_BRIDGE_SECRET: 'bridge-secret', HAFLEET_AGENT_TOKEN_MODE: 'hard' },
    rawDataFiles: {
      'engagements.json': JSON.stringify({ engagements: { allocation: { id: 'allocation', agent: 'worker', state: 'active', projectRoomId: '!project:test', allocatedTokens: 100000 } } }),
      'project-sides.json': JSON.stringify({ sides: { test: { id: 'test', serverName: 'test', active: true,
        apiBaseUrl: `http://127.0.0.1:${hs.address().port}`, representative: { mxid: '@rep:test' },
        credential: { kind: 'appservice', asToken: 'as-secret', senderLocalpart: 'rep', namespace: '^@ac_.*:test$' } } } }),
    },
  });
  const router = context.internals.routerStoreForTest;
  context.internals.stopRouterPumpForTest();
  const bridge = url => request(context.app).post(url).set('X-Bridge-Secret', 'bridge-secret');
  const post = async (id, body) => {
    await bridge('/api/matrix/conversations/events').send({ roomId: '!dm:test', eventId: id, senderMxid: '@alice:test', body, timestamp: 100 }).expect(200);
    return bridge('/api/messages').send({ from: 'alice', to: 'worker', target_type: 'agent', type: 'human', source: 'matrix',
      summary: body, mentions: [], source_room: '!dm:test', source_event_id: id, sender_mxid: '@alice:test' }).expect(200);
  };
  try {
    context.internals.approvalStoreForTest.upsertBinding({ agent: 'worker', project: 'project', project_room_id: '!project:test',
      owner_mxid: '@owner:test', owner_dm_room_id: '!owner-approval:test' });
    await request(context.app).post('/api/matrix/direct-rooms').send({ agent: 'worker', humanMxid: '@alice:test', roomId: '!dm:test' }).expect(403);
    await bridge('/api/matrix/direct-rooms').send({ agent: 'worker', humanMxid: '@alice:test', roomId: '!dm:test', sinceTs: 50 }).expect(200);
    await post('$first', 'Remember the release is Tuesday');
    const command = router.claimMatrixCommand();
    expect(command.roomId).toBe('!dm:test');
    const activated = router.recordMatrixDelivery({ commandId: command.commandId, claimToken: command.claimToken, eventId: '$anchor' });
    router.registerWorkspace({ resourceId: 'dm-work', safeLabel: 'worker', backendPath: process.cwd() });
    router.enqueueDispatch({ sessionId: activated.sessionId, taskId: activated.taskId, framework: 'codex', localServerId: 'local',
      workspaceResourceId: 'dm-work', mayWrite: true, payload: {} });
    const first = router.claimDispatch({ runnerId: 'first', leaseMs: 60000, capabilityTtlMs: 60000, maxLiveRunners: 3 });
    expect(router.takePayload(first).ok).toBe(true);
    const headers = { 'X-Agent-Token': 'worker-secret', 'X-HAFleet-Dispatch-Id': first.dispatchId,
      'X-HAFleet-Runner-Id': first.runnerId, 'X-HAFleet-Dispatch-Capability': first.capability,
      'X-HAFleet-Fence-Generation': String(first.fenceGeneration) };
    const history = await request(context.app).post('/api/router/conversation').set(headers).send({ agent: 'worker', offset: 0, roomId: '!owner-approval:test' }).expect(200);
    expect(history.body.messages.map(m => m.body)).toEqual(['Remember the release is Tuesday']);
    createRouterTaskStore(router).transitionTask(activated.taskId, 'done');
    router.settleAndRelease({ ...first, outcome: 'completed', output: { text: 'Remembered' } });
    const reply = router.claimReplyCommand();
    expect(reply.roomId).toBe('!dm:test');
    router.recordReplyDelivery({ commandId: reply.commandId, claimToken: reply.claimToken, eventId: '$reply' });
    await post('$second', 'Which day is the release?');
    const second = router.claimDispatch({ runnerId: 'second', leaseMs: 60000, capabilityTtlMs: 60000, maxLiveRunners: 3 });
    const continued = router.takePayload(second);
    expect(continued).toMatchObject({ ok: true, taskId: activated.taskId, sessionId: activated.sessionId });
    expect(continued.context.messages.map(m => m.body)).toContain('Remember the release is Tuesday');
    expect(router.readConversation(second).messages.map(m => m.body)).toEqual(['Which day is the release?']);
    const direct = router.conversations.direct('!dm:test');
    const owner = context.internals.approvalStoreForTest.listBindings({ agent: 'worker', projectRoomId: direct.projectRoomId });
    expect(owner[0]).toMatchObject({ ownerMxid: '@owner:test', ownerDmRoomId: '!owner-approval:test' });
    expect(router.snapshot().tasks).toHaveLength(1);
    members = ['@owner:test', '@rep:test', '@ac_worker:test'];
    await bridge('/api/matrix/direct-rooms').send({ agent: 'worker', humanMxid: '@alice:test', roomId: '!dm:test' }).expect(403);
  } finally { await context.cleanup(); await new Promise(resolve => hs.close(resolve)); }
});

test('invited room targets keep separate allocations and reject unauthorized recipients', async () => {
  let members = ['@alice:test', '@owner:test', '@rep:test', '@ac_one:test', '@ac_two:test'];
  const hs = createServer((req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ joined: Object.fromEntries(members.map(id => [id, {}])) })); });
  await new Promise(resolve => hs.listen(0, '127.0.0.1', resolve));
  const names = ['one', 'two'];
  const context = await createBackendTestContext('invited-targets-', {
    agents: Object.fromEntries(names.map(name => [name, { name, agentId: `agent_${name}`, type: 'codex', kind: 'agent', online: true,
      workdir: process.cwd(), workspaceMode: 'shared', projectSide: 'test' }])),
    env: { HAFLEET_THREAD_SESSIONS: '1', HAFLEET_ROUTER_TASK_CUTOVER: '1', MATRIX_BRIDGE_SECRET: 'bridge-secret' },
    rawDataFiles: {
      'engagements.json': JSON.stringify({ engagements: Object.fromEntries(names.map(name => [name,
        { id: name, agent: name, state: 'active', projectRoomId: '!project:test', allocatedTokens: 100000 }])) }),
      'project-sides.json': JSON.stringify({ sides: { test: { id: 'test', serverName: 'test', active: true,
        apiBaseUrl: `http://127.0.0.1:${hs.address().port}`, representative: { mxid: '@rep:test' },
        credential: { kind: 'appservice', asToken: 'as-secret', senderLocalpart: 'rep', namespace: '^@ac_.*:test$' } } } }),
    },
  });
  context.internals.stopRouterPumpForTest();
  const post = url => request(context.app).post(url).set('X-Bridge-Secret', 'bridge-secret');
  try {
    for (const name of names) {
      context.internals.approvalStoreForTest.upsertBinding({ agent: name, project: 'project', project_room_id: '!project:test',
        owner_mxid: '@owner:test', owner_dm_room_id: '!approval:test' });
      await post('/api/matrix/direct-rooms').send({ agent: name, roomId: '!group:test', humanMxid: '@alice:test', mode: 'group', sinceTs: 100 }).expect(200);
    }
    const input = { from: 'alice', to: 'one', type: 'human', target_type: 'agent', summary: 'please both answer', mentions: names,
      room_agent_targets: names, source: 'matrix', source_room: '!group:test', source_event_id: '$both', sender_mxid: '@alice:test' };
    await post('/api/messages').send(input).expect(200);
    expect(context.internals.routerStoreForTest.snapshot().tasks).toHaveLength(2);
    await post('/api/messages').send(input).expect(200);
    expect(context.internals.routerStoreForTest.snapshot().tasks).toHaveLength(2);
    expect(context.internals.routerStoreForTest.conversations.roomBindings('!group:test').map(b => b.engagementId).sort()).toEqual(names);
    await post('/api/messages').send({ ...input, source_event_id: '$not-mentioned', mentions: [] }).expect(403);
    await post('/api/messages').send({ ...input, source_event_id: '$foreign-room', source_room: '!other:test' }).expect(403);
    members = members.filter(m => m !== '@alice:test');
    await post('/api/messages').send({ ...input, source_event_id: '$removed-member' }).expect(403);
    expect(context.internals.routerStoreForTest.snapshot().tasks).toHaveLength(2);
  } finally { await context.cleanup(); await new Promise(resolve => hs.close(resolve)); }
});

test('cross-agent thread creation preserves human mentions and private promotion gates', async () => {
  const members = ['@alice:test', '@owner:test', '@rep:test', '@ac_one:test', '@ac_two:test'];
  const hs = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ joined: Object.fromEntries(members.map(id => [id, {}])) })); });
  await new Promise(resolve => hs.listen(0, '127.0.0.1', resolve));
  const names = ['one', 'two'];
  const context = await createBackendTestContext('cross-agent-private-', {
    agents: Object.fromEntries(names.map(name => [name, { name, agentId: `agent_${name}`, type: 'codex', kind: 'agent',
      online: true, workdir: process.cwd(), workspaceMode: 'shared', projectSide: 'test' }])),
    env: { HAFLEET_THREAD_SESSIONS: '1', HAFLEET_ROUTER_TASK_CUTOVER: '1', MATRIX_BRIDGE_SECRET: 'bridge-secret' },
    rawDataFiles: {
      'engagements.json': JSON.stringify({ engagements: Object.fromEntries(names.map(name => [name,
        { id: name, agent: name, state: 'active', projectRoomId: '!project:test', allocatedTokens: 100000 }])) }),
      'project-sides.json': JSON.stringify({ sides: { test: { id: 'test', serverName: 'test', active: true,
        apiBaseUrl: `http://127.0.0.1:${hs.address().port}`, representative: { mxid: '@rep:test' },
        credential: { kind: 'appservice', asToken: 'as-secret', senderLocalpart: 'rep', namespace: '^@ac_.*:test$' } } } }),
    },
  });
  const router = context.internals.routerStoreForTest;
  context.internals.stopRouterPumpForTest();
  const post = url => request(context.app).post(url).set('X-Bridge-Secret', 'bridge-secret');
  const message = (overrides = {}) => ({ from: 'alice', to: 'one', type: 'human', target_type: 'agent',
    summary: 'private material', mentions: [], room_agent_targets: ['one'], source: 'matrix',
    source_room: '!invited:test', source_event_id: '$private-root', sender_mxid: '@alice:test', ...overrides });
  try {
    for (const name of names) context.internals.approvalStoreForTest.upsertBinding({ agent: name, project: 'project',
      project_room_id: '!project:test', owner_mxid: '@owner:test', owner_dm_room_id: '!approval:test' });
    await post('/api/matrix/direct-rooms').send({ agent: 'one', roomId: '!invited:test', humanMxid: '@alice:test' }).expect(200);
    await post('/api/messages').send(message()).expect(200);
    const privateCommand = router.claimMatrixCommand();
    const privateTask = router.recordMatrixDelivery({ commandId: privateCommand.commandId,
      claimToken: privateCommand.claimToken, eventId: '$private-anchor' });
    await post('/api/matrix/direct-rooms').send({ agent: 'two', roomId: '!invited:test', humanMxid: '@alice:test', mode: 'group', sinceTs: 200 }).expect(200);
    expect(router.conversations.direct('!invited:test', 'one')).toMatchObject({ mode: 'group', privateRootEventId: '$private-root' });
    const second = message({ to: 'two', room_agent_targets: ['two'], source_event_id: '$second', thread_root_event_id: '$shared-thread', mentions: ['two'] });
    await post('/api/messages').send({ ...second, mentions: [] }).expect(403);
    await post('/api/messages').send({ ...second, sender_mxid: '@alice:foreign' }).expect(403);
    await post('/api/messages').send({ ...second, from: 'one', type: 'agent', sender_mxid: '@ac_one:test' }).expect(400);
    expect(router.snapshot().tasks).toHaveLength(1);
    await post('/api/messages').send(message({ source_event_id: '$public-promotion', thread_root_event_id: '$private-root',
      mentions: ['one'], summary: '@one new public work' })).expect(200);
    const publicCommand = router.claimMatrixCommand();
    expect(publicCommand.threadRootEventId).toBe('$public-promotion');
    const publicTask = router.recordMatrixDelivery({ commandId: publicCommand.commandId,
      claimToken: publicCommand.claimToken, eventId: '$public-anchor' });
    expect(publicTask.taskId).not.toBe(privateTask.taskId);
    expect(router.assembleContext(publicTask.sessionId).messages.map(m => m.body)).toEqual(['@one new public work']);
  } finally { await context.cleanup(); await new Promise(resolve => hs.close(resolve)); }
});
