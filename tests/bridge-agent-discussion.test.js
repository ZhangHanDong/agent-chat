import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotEnv, restoreEnv } from './helpers/env.js';
import { openRouter } from '../router/dist/index.js';

let MatrixBridge, bridgeStateForTest, runtime, environment;
const room = '!group:test', alice = '@alice:test', one = '@ac_one:test', two = '@ac_two:test';
beforeAll(async () => {
  runtime = mkdtempSync(path.join(os.tmpdir(), 'agent-discussion-'));
  environment = snapshotEnv(['HAGENCY_RUNTIME_DIR', 'MATRIX_AGENT_PREFIX']);
  process.env.HAGENCY_RUNTIME_DIR = runtime; process.env.MATRIX_AGENT_PREFIX = 'ac_';
  ({ MatrixBridge, bridgeStateForTest } = await import('../bridge-matrix.js'));
});
afterEach(() => { bridgeStateForTest().trustedManagedRooms = {}; vi.restoreAllMocks(); });
afterAll(() => { restoreEnv(environment); rmSync(runtime, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(path.join(runtime, 'router-'));
  const router = openRouter({ dbPath: path.join(dir, 'router.db') }), bridge = new MatrixBridge();
  const entries = ['one', 'two'].map(name => ({ sender: { agentName: name, agentUserId: `@ac_${name}:test` },
    rooms: { [room]: { roomId: room, mode: 'group' } } }));
  bridgeStateForTest().trustedManagedRooms[room] = { directChat: true };
  bridge.directChats = { entryForRoom: () => entries[0], entriesForRoom: () => entries,
    verify: vi.fn(async () => ({ mode: 'group', members: [alice, one, two] })) };
  bridge.resolveKnownAgentName = name => ['one', 'two'].includes(name) ? name : null;
  bridge.isAgentActivity = event => Boolean(event.content?.['io.hagency.activity']);
  bridge.callBackendApi = vi.fn(async (_method, endpoint, input) => {
    expect(endpoint).toBe('/api/matrix/conversations/events'); return router.conversations.archive(input);
  });
  bridge.submitHumanMessage = vi.fn(); bridge.commands = { handle: vi.fn() };
  return { router, bridge, entries };
}
const reply = (id = '$reply') => ({ type: 'm.room.message', event_id: id, sender: one, origin_server_ts: 100,
  content: { msgtype: 'm.text', body: '小白：方案需要两天。@two 请参考。',
    'm.mentions': { user_ids: [two] }, 'm.relates_to': { rel_type: 'm.thread', event_id: '$question' } } });

test('already delivered Agent replies remain shared thread context without waking another Agent', async () => {
  const { bridge, router } = fixture();
  try {
    bridge.rememberMatrixEvent('$reply', 'outgoing-result');
    await bridge.onRoomMessage(room, reply()); await bridge.onRoomMessage(room, reply());
    expect(router.db.prepare('SELECT sender_mxid,body,thread_root FROM room_conversation_events').all())
      .toEqual([{ sender_mxid: one, body: reply().content.body, thread_root: '$question' }]);
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled(); expect(bridge.commands.handle).not.toHaveBeenCalled();
    router.conversations.archive({ roomId: room, eventId: '$review', senderMxid: alice, body: '@two 看看小白的方案', timestamp: 200 });
    const input = router.ingestMessage({ messageId: 'review', matrixEventId: '$review', roomId: room,
      senderMxid: alice, senderName: 'alice', recipientAgentId: 'id-two', recipientAgentName: 'two', normalizedBody: '@two review' });
    expect(input.ok).toBe(true);
    expect(router.enqueueDispatch({ sessionId: input.session.sessionId, framework: 'codex', localServerId: 'local', mayWrite: false, payload: {} }).ok).toBe(true);
    const capability = router.claimDispatch({ runnerId: 'reviewer', leaseMs: 60000, capabilityTtlMs: 60000, maxLiveRunners: 1 });
    expect(router.takePayload(capability).ok).toBe(true);
    expect(router.readConversation(capability).messages.map(m => ({ sender: m.sender, body: m.body, thread: m.threadRoot })))
      .toEqual([{ sender: one, body: reply().content.body, thread: '$question' }, { sender: alice, body: '@two 看看小白的方案', thread: null }]);
  } finally { router.close(); }
});

test('background archival keeps admission checks, excludes activity and retries failed persistence', async () => {
  const { bridge, router } = fixture();
  try {
    bridge.rememberMatrixEvent('$reply');
    bridge.callBackendApi.mockRejectedValueOnce(new Error('archive unavailable'));
    await expect(bridge.onRoomMessage(room, reply())).rejects.toThrow('archive unavailable');
    await bridge.onRoomMessage(room, reply());
    expect(router.db.prepare('SELECT count(*) n FROM room_conversation_events').get().n).toBe(1);
    await bridge.onRoomMessage(room, { ...reply('$activity'), content: { ...reply().content, 'io.hagency.activity': {} } });
    bridge.directChats.verify.mockResolvedValue({ mode: 'group', members: [alice, two] });
    await bridge.onRoomMessage(room, reply('$not-joined'));
    expect(router.db.prepare('SELECT count(*) n FROM room_conversation_events').get().n).toBe(1);
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
  } finally { router.close(); }
});

test('human duplicate suppression and other room isolation remain enforced', async () => {
  const { bridge, router } = fixture();
  try {
    bridge.rememberMatrixEvent('$human');
    await bridge.onRoomMessage(room, { ...reply('$human'), sender: alice });
    await bridge.onRoomMessage('!other:test', reply('$elsewhere'));
    expect(router.db.prepare('SELECT count(*) n FROM room_conversation_events').get().n).toBe(0);
    expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
  } finally { router.close(); }
});
