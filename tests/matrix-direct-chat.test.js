import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDirectAdmission } from '../lib/matrix-direct-admission.js';
import { assertPrivateMembers, ensureDirectDevice, sendDirectEvent, MatrixDirectChats } from '../lib/matrix-direct-chat.js';
import { openRouter } from '../router/dist/index.js';

const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function admission() { return { agent: { name: 'worker' }, eligible: true, humanMxid: '@alice:test', roomId: '!dm:test',
  engagements: [{ id: 'engagement', agent: 'worker', state: 'active', projectRoomId: '!project:test' }],
  bindings: [{ agent: 'worker', projectRoomId: '!project:test', ownerMxid: '@owner:test', ownerDmRoomId: '!approval:test' }],
  membersForProject: vi.fn(async () => ({ known: true, members: ['@alice:test'] })) }; }

test('direct admission requires a unique active project and current human membership', async () => {
  const f = admission();
  expect(await resolveDirectAdmission(f)).toMatchObject({ projectRoomId: '!project:test', humanMxid: '@alice:test', engagementId: 'engagement' });
  await expect(resolveDirectAdmission({ ...f, humanMxid: '@alice:foreign' })).rejects.toThrow('not_authorized');
  const other = { id: 'other', agent: 'worker', state: 'active', projectRoomId: '!other:test' };
  await expect(resolveDirectAdmission({ ...f, engagements: [...f.engagements, other], bindings: [...f.bindings,
    { ...f.bindings[0], projectRoomId: '!other:test' }] })).rejects.toThrow('ambiguous');
  await expect(resolveDirectAdmission({ ...f, bindings: [] })).rejects.toThrow('not_authorized');
});

test('direct chat refuses revoked projects and additional human members', async () => {
  const f = admission();
  const existing = await resolveDirectAdmission(f);
  await expect(resolveDirectAdmission({ ...f, existing, engagements: [] })).rejects.toThrow('not_authorized');
  await expect(resolveDirectAdmission({ ...f, existing, eligible: false })).rejects.toThrow('not_authorized');
  const state = [{ type: 'm.room.join_rules', content: { join_rule: 'invite' } },
    ...['@alice:test', '@agent:test'].map(state_key => ({ type: 'm.room.member', state_key, content: { membership: 'join' } }))];
  expect(() => assertPrivateMembers(state, '@agent:test', '@alice:test')).not.toThrow();
  expect(() => assertPrivateMembers([...state, { type: 'm.room.member', state_key: '@bob:test', content: { membership: 'invite' } }], '@agent:test', '@alice:test')).toThrow('exactly');
  f.membersForProject.mockResolvedValue({ known: false, members: [] });
  await expect(resolveDirectAdmission(f)).rejects.toThrow('unavailable');
});

test('direct agent devices preserve identity and never send encrypted-room replies as plaintext', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'direct-device-')); dirs.push(directory);
  const sender = { agentUserId: '@ac_worker:test', side: { apiBaseUrl: 'https://matrix.invalid' },
    credential: { namespace: '^@ac_.*:test$', asToken: 'as-secret' } };
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ user_id: '@ac_worker:test', access_token: 'private-token', device_id: 'device' }) }));
  const first = await ensureDirectDevice({ sender, directory, fetchImpl });
  expect(await ensureDirectDevice({ sender, directory, fetchImpl })).toEqual(first);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(statSync(path.join(directory, 'session.json')).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path.join(directory, 'session.json'), 'utf8')).device_id).toBe('device');
  const client = { getRoomState: vi.fn(async () => [{ type: 'm.room.encryption', content: { algorithm: 'm.megolm.v1.aes-sha2' } }]),
    crypto: { encryptRoomEvent: vi.fn(async () => ({ ciphertext: 'encrypted payload' })) },
    doRequest: vi.fn(async () => ({ event_id: '$reply' })) };
  expect(await sendDirectEvent(client, '!dm:test', { body: 'private content' }, 'stable-transaction')).toBe('$reply');
  expect(client.doRequest).toHaveBeenCalledWith('PUT', expect.stringContaining('/send/m.room.encrypted/stable-transaction'), null, { ciphertext: 'encrypted payload' });
  client.crypto = null;
  await expect(sendDirectEvent(client, '!dm:test', { body: 'secret' }, 'next')).rejects.toThrow('unavailable');
  expect(client.doRequest).toHaveBeenCalledTimes(1);
});

test('direct invite history paginates and retries a persisted unfinished backfill', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'direct-history-')); dirs.push(directory);
  const binding = { roomId: '!dm:test', agent: 'worker', humanMxid: '@alice:test', projectRoomId: '!project:test', engagementId: 'allocation' };
  const manager = new MatrixDirectChats({ directory, backend: vi.fn(async () => ({ binding })),
    onMessage: vi.fn(), onBinding: vi.fn(), warning: vi.fn() });
  const state = [{ type: 'm.room.join_rules', content: { join_rule: 'invite' } }, ...['@alice:test', '@agent:test'].map(state_key =>
    ({ type: 'm.room.member', state_key, content: { membership: 'join' } }))];
  const event = id => ({ type: 'm.room.message', event_id: id, sender: '@alice:test', content: { body: id } });
  const client = { joinRoom: vi.fn(), getRoomState: vi.fn(async () => state), doRequest: vi.fn()
    .mockRejectedValueOnce(new Error('history temporarily unavailable'))
    .mockResolvedValueOnce({ chunk: [event('$newer')], end: 'older-page' })
    .mockResolvedValueOnce({ chunk: [event('$older')] }) };
  const entry = { client, sender: { agentName: 'worker', agentUserId: '@agent:test' }, rooms: {}, file: path.join(directory, 'rooms.json') };
  await expect(manager.invite(entry, '!dm:test', { sender: '@alice:test', state_key: '@agent:test', content: { is_direct: true } })).rejects.toThrow('temporarily');
  expect(JSON.parse(readFileSync(entry.file, 'utf8'))['!dm:test'].historyPending).toBe(true);
  expect(manager.onMessage).not.toHaveBeenCalled();
  await manager.message(entry, '!dm:test', event('$live'));
  expect(manager.onMessage.mock.calls.map(call => call[1].event_id)).toEqual(['$older', '$newer', '$live']);
  expect(JSON.parse(readFileSync(entry.file, 'utf8'))['!dm:test'].historyPending).toBe(false);
});

test('ordinary invitations support two agents with independent room bindings and mention routing', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'invited-agents-')); dirs.push(directory);
  const router = openRouter({ dbPath: path.join(directory, 'router.db') });
  const room = '!room:test';
  const makeState = members => members.map(state_key => ({ type: 'm.room.member', state_key, origin_server_ts: 200,
    content: { membership: 'join' } }));
  let state = makeState(['@alice:test', '@one:test']);
  const manager = new MatrixDirectChats({ directory, onMessage: vi.fn(), onBinding: vi.fn(), warning: vi.fn(),
    backend: vi.fn(async (_method, _path, input) => {
      const binding = { roomId: input.roomId, agent: input.agent, humanMxid: '@alice:test', projectRoomId: '!project:test', engagementId: input.agent };
      if (input.mode === 'group') router.conversations.promoteRoom(room, input.sinceTs || 200);
      return { binding: router.conversations.bindDirect({ ...binding, mode: input.mode, sinceTs: input.sinceTs }) };
    }) });
  const makeEntry = name => ({ sender: { agentName: name, agentUserId: `@${name}:test` }, rooms: {}, file: path.join(directory, `${name}.json`),
    client: { joinRoom: vi.fn(), getRoomState: vi.fn(async () => state), doRequest: vi.fn(async (method) => method === 'GET' ? { chunk: [] } : { event_id: `$${name}-reply` }) } });
  const one = makeEntry('one'), two = makeEntry('two');
  manager.clients.set('@one:test', one); manager.clients.set('@two:test', two);
  try {
    await manager.invite(one, room, { sender: '@alice:test', state_key: '@one:test', origin_server_ts: 100, content: { is_direct: true } });
    expect(one.rooms[room].mode).toBe('direct');
    router.conversations.directRoot(room, '$private-root', 'one');
    state = makeState(['@alice:test', '@one:test', '@two:test']);
    await manager.invite(two, room, { sender: '@alice:test', state_key: '@two:test', origin_server_ts: 200, content: {} });
    await manager.verify(one, one.rooms[room]);
    expect(one.rooms[room].mode).toBe('group');
    expect(two.client.joinRoom).toHaveBeenCalledWith(room);
    const relation = { rel_type: 'm.thread', event_id: '$group-root' };
    await manager.send(room, { msgtype: 'm.text', body: 'second reply', 'm.relates_to': relation }, 'txn-two', 'two');
    expect(two.client.doRequest).toHaveBeenLastCalledWith('PUT', expect.stringContaining('/txn-two'), null,
      expect.objectContaining({ body: 'second reply', 'm.relates_to': relation }));
    expect(one.client.doRequest.mock.calls.some(call => call[0] === 'PUT')).toBe(false);
    await expect(manager.send(room, { msgtype: 'm.text', body: 'private result',
      'm.relates_to': { rel_type: 'm.thread', event_id: '$private-root' } }, 'private-txn', 'one')).rejects.toThrow('private reply');
    expect(one.client.doRequest.mock.calls.some(call => call[0] === 'PUT')).toBe(false);
    await expect(manager.send(room, { body: 'ambiguous' }, 'txn')).rejects.toThrow('agent identity');
    await manager.message(two, room, { event_id: '$old', sender: '@alice:test', origin_server_ts: 100, content: { body: 'old private' } }, true);
    expect(manager.onMessage).not.toHaveBeenCalled();
  } finally { router.close(); }
});
