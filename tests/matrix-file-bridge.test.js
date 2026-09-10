import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { snapshotSessionFile } from '../lib/session-file.js';
import { MatrixDirectChats } from '../lib/matrix-direct-chat.js';
import { snapshotEnv, restoreEnv } from './helpers/env.js';
let directory, env;
afterEach(() => { vi.unstubAllGlobals(); if (env) restoreEnv(env); if (directory) rmSync(directory, { recursive: true, force: true }); });
async function fixture() {
  directory = mkdtempSync(path.join(os.tmpdir(), 'file-bridge-'));
  env = snapshotEnv(['HAGENCY_RUNTIME_DIR', 'MATRIX_SERVER_NAME', 'MATRIX_AGENT_PREFIX']);
  process.env.HAGENCY_RUNTIME_DIR = directory; process.env.MATRIX_SERVER_NAME = 'test'; process.env.MATRIX_AGENT_PREFIX = 'ac_';
  const { MatrixBridge } = await import('../bridge-matrix.js?files');
  const bridge = new MatrixBridge(); bridge.addKnownAgent('one');
  return bridge;
}

test('project discussion backfill honors Agent admission and records attachments without downloading', async () => {
  const bridge = await fixture(), roomId = '!project:test';
  bridge.actingSideFor = () => ({ side: { apiBaseUrl: 'https://side.test', serverName: 'test', representative: { mxid: '@rep:test' } },
    credential: { kind: 'registrationToken', representativeToken: 'rep-fixture' } });
  const event = (id, timestamp) => ({ type: 'm.room.message', event_id: id, sender: '@alice:test', origin_server_ts: timestamp,
    content: { msgtype: 'm.file', body: 'report.txt', url: 'mxc://test/report', info: { size: 20 } } });
  const fetcher = vi.fn(async raw => {
    const url = new URL(raw);
    if (url.pathname.endsWith('/state')) return Response.json([{ type: 'm.room.member', state_key: '@ac_one:test', origin_server_ts: 200, content: { membership: 'join' } }]);
    if (url.pathname.endsWith('/messages')) return Response.json({ chunk: [event('$allowed', 300), event('$private-before-join', 100)], end: 'older' });
    throw new Error(`unexpected download: ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetcher);
  bridge.callBackendApi = vi.fn(async () => ({ ok: true }));
  await bridge.archiveProjectDiscussion(roomId, { agents: new Set(['one']), agentMxids: new Map([['one', '@ac_one:test']]) });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(bridge.callBackendApi).toHaveBeenCalledWith('POST', '/api/matrix/conversations/admissions',
    { roomId, admissions: [{ agent: 'one', sinceTs: 200 }] });
  const events = bridge.callBackendApi.mock.calls.filter(call => call[1].endsWith('/events'));
  expect(events).toHaveLength(1);
  expect(events[0][2]).toMatchObject({ eventId: '$allowed', attachment: { remoteContent: { url: 'mxc://test/report' } } });
  expect(events[0][2].attachment.path).toBeUndefined();
});
test('bridge persists media before send retries without upload and blocks promoted private files', async () => {
  const bridge = await fixture(), work = path.join(directory, 'work'); mkdirSync(work); writeFileSync(path.join(work, 'output.txt'), 'report');
  const file = snapshotSessionFile({ workspace: work, requestedPath: 'output.txt', directory: path.join(directory, 'stage') });
  const command = { commandId: 'file', claimToken: 'claim', roomId: '!room:test', senderAgentName: 'one', threadRootEventId: '$root', transactionId: 'txn', body: 'report', file };
  const upload = vi.fn(async () => 'mxc://test/output');
  bridge.fileRoomContext = vi.fn(async () => ({ client: { uploadContent: upload }, encrypted: false, invited: true, sender: { agentName: 'one' } }));
  const order = []; let prepared;
  bridge.callBackendApi = vi.fn(async (_method, route, body) => { order.push(route.endsWith('/prepared-file') ? 'prepare' : 'ack'); prepared ??= body.content; return { ok: true, content: body.content }; });
  bridge.sendAsAgentContent = vi.fn(async (_sender, room, content, _extra, opts) => {
    order.push('send'); expect(room).toBe('!room:test'); expect(content['m.relates_to'].event_id).toBe('$root'); expect(opts.transactionId).toBe('txn'); return '$sent';
  });
  await bridge.deliverRouterFile(command); expect(order).toEqual(['prepare', 'send', 'ack']);
  await bridge.deliverRouterFile({ ...command, file: { ...file, preparedContent: prepared } }); expect(upload).toHaveBeenCalledTimes(1);
  bridge.fileRoomContext.mockImplementation(async () => {
    MatrixDirectChats.prototype.assertReplyScope({ rooms: { '!room:test': { mode: 'group', privateRootEventId: '$root' } } }, '!room:test', { 'm.relates_to': { event_id: '$root' } });
  });
  await expect(bridge.deliverRouterFile(command)).rejects.toThrow('private reply'); expect(upload).toHaveBeenCalledTimes(1);
});
test('room and DM file intake downloads with room authority and preserves mention gating', async () => {
  const bridge = await fixture(), room = '!room:test'; let mode = 'group';
  const entry = { sender: { agentName: 'one', agentUserId: '@ac_one:test' }, rooms: { [room]: {} }, client: { homeserverUrl: 'https://side.test', accessToken: 'room-device' } };
  bridge.directChats = { entriesForRoom: () => [entry], verify: vi.fn(async () => ({ mode, members: ['@alice:test', '@ac_one:test'] })) };
  const fetcher = vi.fn(async (url, options) => { expect(url.origin).toBe('https://side.test'); expect(options.headers.Authorization).toBe('Bearer room-device'); return new Response('a,b\n1,2'); }); vi.stubGlobal('fetch', fetcher);
  bridge.callBackendApi = vi.fn(async () => ({ ok: true })); bridge.submitHumanMessage = vi.fn(async () => ({ id: 'accepted' }));
  bridge.checkpointMatrixEvent = vi.fn(); bridge.beginAgentWork = vi.fn();
  const event = (id, mentioned = false, sender = '@alice:test') => ({ type: 'm.room.message', event_id: id, sender, origin_server_ts: 500,
    content: { msgtype: 'm.file', body: 'table.csv', url: 'mxc://side.test/file', info: { mimetype: 'text/csv', size: 7 }, 'm.mentions': { user_ids: mentioned ? ['@ac_one:test'] : [] } } });
  await bridge.onInvitedAgentRoomMessage(room, event('$background'));
  expect(bridge.submitHumanMessage).not.toHaveBeenCalled();
  const archived = bridge.callBackendApi.mock.calls.at(-1)[2]; expect(archived.senderMxid).toBe('@alice:test'); expect(readFileSync(archived.attachment.path, 'utf8')).toBe('a,b\n1,2');
  await bridge.onInvitedAgentRoomMessage(room, event('$mention', true)); expect(bridge.submitHumanMessage).toHaveBeenCalledTimes(1);
  expect(bridge.submitHumanMessage.mock.calls.at(-1)[1].summary).toContain('Attachment event: $mention');
  mode = 'direct'; await bridge.onInvitedAgentRoomMessage(room, event('$dm')); expect(bridge.submitHumanMessage).toHaveBeenCalledTimes(2);
  await bridge.onInvitedAgentRoomMessage(room, event('$outsider', true, '@mallory:test')); expect(fetcher).toHaveBeenCalledTimes(3);
  const bang = event('$bang'); bang.content.body = '!status';
  await bridge.onInvitedAgentRoomMessage(room, bang); expect(bridge.submitHumanMessage).toHaveBeenCalledTimes(3);
  const huge = event('$huge'); huge.content.info.size = 30 * 1024 * 1024;
  await bridge.onInvitedAgentRoomMessage(room, huge); expect(bridge.callBackendApi.mock.calls.at(-1)[2].attachment.errorCode).toBe('file_too_large');
});
