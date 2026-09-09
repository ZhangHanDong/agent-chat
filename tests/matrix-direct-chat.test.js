import { afterEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

function cachedDevice() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'direct-endpoint-')); dirs.push(directory);
  const sender = { agentUserId: '@ac_worker:test', side: { apiBaseUrl: 'https://new-matrix.invalid' },
    credential: { namespace: '^@ac_.*:test$', asToken: 'appservice-token' } };
  const session = { user_id: sender.agentUserId, device_id: 'original-device', access_token: 'original-device-token',
    refresh_token: 'original-refresh-token', baseUrl: 'http://127.0.0.1:18010' };
  mkdirSync(path.join(directory, 'crypto'));
  writeFileSync(path.join(directory, 'session.json'), JSON.stringify(session), { mode: 0o600 });
  for (const file of ['sync.json', 'rooms.json', 'crypto/crypto.sqlite']) writeFileSync(path.join(directory, file), `preserve ${file}`);
  const contents = () => Object.fromEntries(['session.json', 'sync.json', 'rooms.json', 'crypto/crypto.sqlite']
    .map(file => [file, readFileSync(path.join(directory, file), 'utf8')]));
  return { sender, directory, session, contents };
}

test('unchanged direct device endpoint reuses cached identity without a request or file rewrite', async () => {
  const f = cachedDevice(); f.sender.side.apiBaseUrl = f.session.baseUrl;
  const before = f.contents(), fetchImpl = vi.fn();
  expect(await ensureDirectDevice({ ...f, fetchImpl })).toEqual(f.session);
  expect(fetchImpl).not.toHaveBeenCalled(); expect(f.contents()).toEqual(before);
});

test('changed direct device endpoint verifies the original token and preserves device and crypto state', async () => {
  const f = cachedDevice(), before = f.contents();
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200,
    json: async () => ({ user_id: f.session.user_id, device_id: f.session.device_id }) }));
  const migrated = await ensureDirectDevice({ ...f, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(fetchImpl).toHaveBeenCalledWith('https://new-matrix.invalid/_matrix/client/v3/account/whoami', {
    method: 'GET', headers: { Authorization: `Bearer ${f.session.access_token}` }, redirect: 'error', signal: expect.any(AbortSignal),
  });
  expect(migrated).toEqual({ ...f.session, baseUrl: f.sender.side.apiBaseUrl });
  expect(f.contents()).toEqual({ ...before, 'session.json': JSON.stringify(migrated) });
  expect(statSync(path.join(f.directory, 'session.json')).mode & 0o777).toBe(0o600);
  expect(await ensureDirectDevice({ ...f, fetchImpl })).toEqual(migrated);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

test.each([
  ['foreign homeserver identity', { user_id: '@ac_worker:foreign', device_id: 'original-device' }],
  ['different user', { user_id: '@ac_other:test', device_id: 'original-device' }],
  ['different device', { user_id: '@ac_worker:test', device_id: 'another-device' }],
  ['missing device', { user_id: '@ac_worker:test' }],
  ['missing user', { device_id: 'original-device' }],
  ['empty response', null],
  ['array response', []],
])('direct endpoint migration refuses %s without rewriting any cached state', async (_name, identity) => {
  const f = cachedDevice(), before = f.contents();
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => identity }));
  await expect(ensureDirectDevice({ ...f, fetchImpl })).rejects.toThrow('endpoint verification failed');
  expect(f.contents()).toEqual(before); expect(fetchImpl).toHaveBeenCalledOnce();
});

test.each(['HTTP error', 'malformed JSON', 'network error'])('direct endpoint migration preserves cached state after %s', async failure => {
  const f = cachedDevice(), before = f.contents();
  const fetchImpl = vi.fn(async () => {
    if (failure === 'network error') throw new Error(`untrusted error ${f.session.access_token}`);
    return { ok: failure !== 'HTTP error', status: failure === 'HTTP error' ? 401 : 200,
      json: async () => { throw new Error(`untrusted body ${f.session.access_token}`); } };
  });
  const error = await ensureDirectDevice({ ...f, fetchImpl }).catch(value => value);
  expect(error.message).toBe('direct device endpoint verification failed');
  expect(f.contents()).toEqual(before); expect(fetchImpl).toHaveBeenCalledOnce();
});

test('direct endpoint migration has a finite verification timeout and retains the original cache on abort', async () => {
  const f = cachedDevice(), before = f.contents(), controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const fetchImpl = vi.fn(async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  try {
    const pending = ensureDirectDevice({ ...f, fetchImpl });
    const failed = expect(pending).rejects.toThrow('endpoint verification failed');
    expect(timeout).toHaveBeenCalledWith(8000);
    controller.abort(new Error('fixture endpoint timeout')); await failed;
    expect(f.contents()).toEqual(before); expect(fetchImpl).toHaveBeenCalledOnce();
  } finally { timeout.mockRestore(); }
});

test('direct endpoint migration refuses a mismatched or incomplete cached identity before sending its token', async () => {
  const f = cachedDevice(), fetchImpl = vi.fn();
  for (const mutation of [{ user_id: '@ac_other:test' }, { device_id: null }, { device_id: '' }, { access_token: null }, { access_token: '' }]) {
    writeFileSync(path.join(f.directory, 'session.json'), JSON.stringify({ ...f.session, ...mutation }));
    const before = f.contents();
    await expect(ensureDirectDevice({ ...f, fetchImpl })).rejects.toThrow();
    expect(f.contents()).toEqual(before);
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

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
