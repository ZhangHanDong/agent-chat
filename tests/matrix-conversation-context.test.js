import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRouter } from '../router/dist/index.js';

const cleanup = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'conversation-'));
  const dbPath = path.join(dir, 'router.db');
  let router = openRouter({ dbPath, ...options });
  cleanup.push(() => { router.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get router() { return router; }, restart() { router.close(); router = openRouter({ dbPath, ...options }); } };
}
function archive(router, id, body, sender = '@alice:test', room = '!project:test') {
  return router.conversations.archive({ roomId: room, eventId: `$${id}`, senderMxid: sender, body, timestamp: 100 });
}
function start(router, id, agent = 'worker', room = '!project:test') {
  const input = router.ingestMessage({ messageId: id, matrixEventId: `$${id}`, roomId: room,
    senderMxid: '@alice:test', senderName: 'alice', recipientAgentId: `id-${agent}`,
    recipientAgentName: agent, normalizedBody: `@${agent} summarize discussion` });
  expect(input.ok).toBe(true);
  const queued = router.enqueueDispatch({ sessionId: input.session.sessionId, framework: 'codex', localServerId: 'local',
    mayWrite: false, payload: {} });
  expect(queued.ok).toBe(true);
  const capability = router.claimDispatch({ runnerId: `runner-${id}-${agent}`, leaseMs: 60000,
    capabilityTtlMs: 60000, maxLiveRunners: 10 });
  expect(capability.ok).toBe(true);
  const payload = router.takePayload(capability);
  expect(payload.ok).toBe(true);
  return { capability, payload };
}
function deliver(router, capability) {
  expect(router.settleAndRelease({ ...capability, outcome: 'completed', output: { text: 'summary' } }).ok).toBe(true);
  const reply = router.claimReplyCommand();
  expect(reply).toBeTruthy();
  const input = { commandId: reply.commandId, claimToken: reply.claimToken, eventId: `$reply-${capability.dispatchId}` };
  expect(router.recordReplyDelivery(input).ok).toBe(true);
  return input;
}

test('room promotion preserves bindings without exposing prior private context', () => {
  const f = fixture(), room = '!dm:test';
  const binding = { roomId: room, agent: 'worker', humanMxid: '@alice:test', projectRoomId: '!project:test', engagementId: 'a' };
  f.router.conversations.bindDirect(binding);
  f.router.conversations.directRoot(room, '$private', 'worker');
  archive(f.router, 'private', 'private before promotion', '@alice:test', room);
  f.router.conversations.bindDirect({ ...binding, agent: 'second', engagementId: 'b', mode: 'group', sinceTs: 200 });
  expect(f.router.conversations.roomBindings(room)).toHaveLength(2);
  expect(f.router.conversations.direct(room, 'worker')).toMatchObject({ mode: 'group', rootEventId: null, privateRootEventId: '$private' });
  f.restart();
  expect(f.router.conversations.direct(room, 'second')).toMatchObject({ mode: 'group', engagementId: 'b', sinceTs: 200 });
  f.router.conversations.archive({ roomId: room, eventId: '$new', senderMxid: '@alice:test', body: 'group after promotion', timestamp: 300 });
  const { capability } = start(f.router, 'new', 'second', room);
  expect(f.router.readConversation(capability).messages.map(m => m.body)).toEqual(['group after promotion']);
  expect(f.router.conversations.direct(room)).toBeNull(); // No arbitrary first-Agent lookup.
});

test('discussion archives without creating a dispatch and survives restart', () => {
  const f = fixture();
  const first = archive(f.router, 'a', 'Use Rust', '@alice:test');
  archive(f.router, 'b', 'Include Python bindings', '@bob:test');
  expect(archive(f.router, 'a', 'Use Rust').replayed).toBe(true);
  expect(() => archive(f.router, 'a', 'changed')).toThrow('identity conflict');
  expect(f.router.snapshot().dispatches).toEqual([]);
  f.restart();
  expect(archive(f.router, 'a', 'Use Rust').seq).toBe(first.seq);
  archive(f.router, 'trigger', '@worker summarize');
  const work = start(f.router, 'trigger');
  expect(f.router.readConversation(work.capability).messages.map(m => m.sender)).toEqual(['@alice:test', '@bob:test', '@alice:test']);
});

test('mention context ends at the trigger and advances only after successful delivery', () => {
  const { router } = fixture();
  archive(router, 'a', 'First opinion'); archive(router, 'trigger', '@worker summarize');
  const first = start(router, 'trigger');
  archive(router, 'later', 'After the mention');
  const page = router.readConversation(first.capability);
  expect(page.messages.map(m => m.body)).toEqual(['First opinion', '@worker summarize']);
  expect(router.db.prepare('SELECT * FROM room_conversation_positions').all()).toEqual([]);
  const receipt = deliver(router, first.capability);
  expect(router.recordReplyDelivery(receipt)).toMatchObject({ ok: true, replayed: true });
  archive(router, 'next', '@worker next summary');
  const next = start(router, 'next');
  expect(router.readConversation(next.capability).messages.map(m => m.body)).toEqual(['After the mention', '@worker next summary']);
  archive(router, 'peer', '@reviewer summarize');
  const peer = start(router, 'peer', 'reviewer');
  expect(router.readConversation(peer.capability).messages[0].body).toBe('First opinion');
});

test('conversation pages preserve long messages and reject cross-dispatch reads', () => {
  const { router } = fixture();
  const long = 'A long discussion. '.repeat(2400);
  archive(router, 'long', long); archive(router, 'trigger', '@worker summarize');
  archive(router, 'secret', 'PRIVATE OTHER ROOM', '@alice:test', '!private:test');
  const work = start(router, 'trigger');
  expect(router.readConversation({ ...work.capability, dispatchId: 'another' }).ok).toBe(false);
  expect(router.readConversation(work.capability, 500).ok).toBe(false);
  let offset = 0; const messages = [];
  do { const page = router.readConversation(work.capability, offset); expect(page.ok).toBe(true);
    messages.push(...page.messages); offset = page.next;
  } while (offset !== null);
  expect(messages.filter(m => m.eventId === '$long').map(m => m.body).join('')).toBe(long);
  expect(JSON.stringify(messages)).not.toContain('PRIVATE OTHER ROOM');
  deliver(router, work.capability);
  expect(router.readConversation(work.capability).ok).toBe(false);
});

test('failed conversation dispatches and duplicate deliveries do not lose history', () => {
  const { router } = fixture();
  archive(router, 'a', 'Must retain this'); archive(router, 'trigger', '@worker summarize');
  const work = start(router, 'trigger');
  router.readConversation(work.capability);
  router.settleAndRelease({ ...work.capability, outcome: 'outcome_unknown', reason: 'interrupted' });
  expect(router.db.prepare('SELECT * FROM room_conversation_positions').all()).toEqual([]);
  expect(archive(router, 'a', 'Must retain this').replayed).toBe(true);
  expect(router.db.prepare('SELECT COUNT(*) AS n FROM room_conversation_events').get().n).toBe(2);
});

test('unread context cannot be consumed by a successful but incomplete reader', () => {
  const { router } = fixture();
  archive(router, 'a', 'x'.repeat(20000)); archive(router, 'trigger', '@worker summarize');
  const work = start(router, 'trigger');
  expect(router.readConversation(work.capability).next).not.toBeNull();
  deliver(router, work.capability);
  expect(router.db.prepare('SELECT * FROM room_conversation_positions').all()).toEqual([]);
});

test('bounded conversation windows advance only through fully read events', () => {
  const { router } = fixture();
  for (let i = 0; i < 300; i++) archive(router, `event-${i}`, `discussion ${i}`);
  archive(router, 'trigger', '@worker summarize');
  const first = start(router, 'trigger');
  const page = router.readConversation(first.capability);
  expect(page.totalParts).toBe(200); expect(page.messages).toHaveLength(8);
  expect(page.messages[0].body).toBe('discussion 0');
  deliver(router, first.capability);
  expect(router.db.prepare('SELECT through_seq FROM room_conversation_positions').get().through_seq).toBe(8);
  archive(router, 'next', 'continue');
  const next = start(router, 'next');
  expect(router.readConversation(next.capability).messages[0].body).toBe('discussion 8');
});

test('a project Agent sees only discussion since its own admission', () => {
  const { router } = fixture();
  archive(router, 'earlier', 'before admission');
  router.conversations.setAdmission('!project:test', 'worker', 200);
  router.conversations.archive({ roomId: '!project:test', eventId: '$new', senderMxid: '@alice:test', body: 'after admission', timestamp: 300 });
  const work = start(router, 'new');
  expect(router.readConversation(work.capability).messages.map(message => message.body)).toEqual(['after admission']);
});

test('a bounded history window still admits the current request attachment without exposing later uploads', () => {
  const { router } = fixture();
  for (let i = 0; i < 220; i++) archive(router, `earlier-${i}`, 'background');
  const file = { name: 'request.txt', remoteContent: { msgtype: 'm.file', url: 'mxc://test/request' } };
  router.conversations.archive({ roomId: '!project:test', eventId: '$trigger', senderMxid: '@alice:test', body: 'read request.txt', timestamp: 100, attachment: file });
  const work = start(router, 'trigger');
  expect(router.conversations.prepare(work.capability.dispatchId, '!project:test', 'id-worker').hasMoreHistory).toBe(true);
  expect(router.receiveFile({ ...work.capability, eventId: '$trigger' })).toMatchObject({ ok: true, file });
  router.conversations.archive({ roomId: '!project:test', eventId: '$later', senderMxid: '@alice:test', body: 'later', timestamp: 100, attachment: file });
  expect(router.receiveFile({ ...work.capability, eventId: '$later' }).ok).toBe(false);
});

test('reply outbox preserves null-root session origin after a later room promotion', () => {
  let now = 300;
  const { router } = fixture({ now: () => now });
  router.conversations.bindDirect({ roomId: '!project:test', agent: 'worker', humanMxid: '@alice:test',
    projectRoomId: '!source:test', engagementId: 'engagement', sinceTs: 50 });
  archive(router, 'private', 'private task');
  const work = start(router, 'private');
  router.conversations.promoteRoom('!project:test', 500);
  now = 600;
  router.settleAndRelease({ ...work.capability, outcome: 'completed', output: { text: 'private result' } });
  const reply = router.claimReplyCommand();
  expect(reply).toMatchObject({ threadRootEventId: null, sourceCreatedAt: 300 });
  expect(reply.sourceCreatedAt).toBeLessThan(router.conversations.direct('!project:test', 'worker').sinceTs);
});
