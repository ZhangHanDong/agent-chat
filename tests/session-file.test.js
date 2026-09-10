import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, truncateSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ReadableStream } from 'node:stream/web';
import os from 'node:os';
import path from 'node:path';
import { Attachment } from '@matrix-org/matrix-sdk-crypto-nodejs';
import { snapshotSessionFile, SESSION_FILE_MAX_BYTES } from '../lib/session-file.js';
import { prepareMatrixFile, receiveMatrixFile } from '../lib/matrix-file.js';
import { openRouter } from '../router/dist/index.js';
const cleanup = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function files() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'session-files-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'work'), directory = path.join(root, 'cache'); mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'report.txt'), 'private file bytes\n');
  return { root, workspace, directory, snapshot: (requestedPath = 'report.txt', extra = {}) => snapshotSessionFile({ workspace, directory, requestedPath, ...extra }) };
}
function dispatch(router, id = 'one', room = '!room:test') {
  const input = router.ingestMessage({ messageId: id, matrixEventId: `$${id}`, roomId: room, threadRootEventId: `$${id}`,
    senderName: 'owner', senderMxid: '@alice:test', recipientAgentId: `id-${id}`, recipientAgentName: id, normalizedBody: 'work' });
  router.enqueueDispatch({ sessionId: input.session.sessionId, framework: 'codex', localServerId: 'local', mayWrite: false, payload: {} });
  const claim = router.claimDispatch({ runnerId: `runner-${id}`, leaseMs: 60000, capabilityTtlMs: 60000, maxLiveRunners: 5 });
  expect(router.takePayload(claim).ok).toBe(true); return claim;
}
test('session file snapshots reject escapes special files oversized inputs and preserve bytes', () => {
  const f = files(), file = f.snapshot(); expect(readFileSync(file.path)).toEqual(readFileSync(path.join(f.workspace, 'report.txt')));
  writeFileSync(path.join(f.root, 'secret'), 'secret');
  symlinkSync(path.join(f.root, 'secret'), path.join(f.workspace, 'escape'));
  symlinkSync(f.root, path.join(f.workspace, 'parent'));
  linkSync(path.join(f.root, 'secret'), path.join(f.workspace, 'hard'));
  execFileSync('mkfifo', [path.join(f.workspace, 'pipe')]);
  for (const name of ['../secret', 'escape', 'parent/secret', 'hard', 'pipe', '.']) expect(() => f.snapshot(name)).toThrow();
  writeFileSync(path.join(f.workspace, 'huge'), ''); truncateSync(path.join(f.workspace, 'huge'), SESSION_FILE_MAX_BYTES + 1);
  expect(() => f.snapshot('huge')).toThrow('exceeds');
  expect(f.snapshot('report.txt', { name: '../safe\n.txt' }).name).toBe('.._safe_.txt');
  writeFileSync(path.join(f.workspace, 'report.txt'), 'changed'); expect(readFileSync(file.path, 'utf8')).toBe('private file bytes\n');
});
test('Matrix files encrypt media before upload and retain private thread routing', async () => {
  const f = files(), file = f.snapshot(); const crypto = { encryptMedia(bytes) {
    const encrypted = Attachment.encrypt(bytes);
    return { buffer: Buffer.from(encrypted.encryptedData), file: JSON.parse(encrypted.mediaEncryptionInfo) };
  } }; let uploaded;
  const relation = { rel_type: 'm.thread', event_id: '$thread' };
  const content = await prepareMatrixFile({ file, encrypted: true, crypto, relation, upload: async (bytes, mime) => {
    expect(mime).toBe('application/octet-stream'); uploaded = bytes; return 'mxc://test/encrypted';
  } });
  expect(content.url).toBeUndefined(); expect(content.file.key).toBeDefined(); expect(content['m.relates_to']).toEqual(relation);
  expect(uploaded).not.toEqual(readFileSync(file.path)); expect(uploaded.toString()).not.toContain('private file');
  const received = await receiveMatrixFile({ content, baseUrl: 'https://matrix.test', token: 'room-token', directory: path.join(f.root, 'receive'), fetchImpl: async (url, opts) => {
    expect(url.origin).toBe('https://matrix.test'); expect(url.pathname).toBe('/_matrix/client/v1/media/download/test/encrypted');
    expect(opts.headers.Authorization).toBe('Bearer room-token'); expect(opts.redirect).toBe('error'); return new Response(uploaded);
  } });
  expect(readFileSync(received.path)).toEqual(readFileSync(file.path)); expect(received.sha256).toBe(file.sha256);
  const corrupted = Buffer.from(uploaded); corrupted[0] ^= 1;
  await expect(receiveMatrixFile({ content, baseUrl: 'https://matrix.test', token: 'room-token', directory: path.join(f.root, 'bad'),
    fetchImpl: async () => new Response(corrupted) })).rejects.toMatchObject({ code: 'file_decryption_failed' });
  const plain = await prepareMatrixFile({ file, encrypted: false, relation, upload: async bytes => {
    expect(bytes).toEqual(readFileSync(file.path)); return 'mxc://test/plain';
  } }); expect(plain.file).toBeUndefined(); expect(plain.url).toBe('mxc://test/plain');
});
test('file outbox replays immutable snapshots and fences foreign receipts', () => {
  const f = files(); let now = Date.now(); const options = { dbPath: path.join(f.root, 'router.db'), now: () => now };
  let router = openRouter(options); cleanup.push(() => router.close());
  const cap = dispatch(router), foreign = dispatch(router, 'two', '!foreign:test'), file = f.snapshot();
  const input = { ...cap, requestKey: 'call', requestDigest: 'digest', file, body: 'report' };
  const queued = router.queueFileReply(input); expect(queued.delivery.status).toBe('queued');
  expect(JSON.stringify(queued)).not.toContain(file.path);
  const cmd = router.claimReplyCommand(1000); expect(cmd).toMatchObject({ roomId: '!room:test', threadRootEventId: '$one', senderAgentName: 'one', file: { sha256: file.sha256 } });
  const content = { msgtype: 'm.file', body: 'report.txt', url: 'mxc://test/media' };
  expect(router.prepareFileReply({ commandId: cmd.commandId, claimToken: cmd.claimToken, content }).ok).toBe(true);
  router.close(); now += 1001; router = openRouter(options);
  const retry = router.claimReplyCommand(); expect(retry.transactionId).toBe(cmd.transactionId); expect(retry.file.preparedContent).toEqual(content);
  expect(router.prepareFileReply({ commandId: cmd.commandId, claimToken: cmd.claimToken, content }).ok).toBe(false);
  expect(router.prepareFileReply({ commandId: cmd.commandId, claimToken: retry.claimToken, content: { ...content, url: 'mxc://evil/other' } }).ok).toBe(false);
  expect(router.recordReplyDelivery({ commandId: cmd.commandId, claimToken: cmd.claimToken, eventId: '$wrong' }).ok).toBe(false);
  expect(router.readFileReply({ ...foreign, commandId: cmd.commandId }).ok).toBe(false);
  expect(router.recordReplyDelivery({ commandId: retry.commandId, claimToken: retry.claimToken, eventId: '$sent' }).ok).toBe(true);
  expect(router.findFileReply(input).delivery).toMatchObject({ status: 'delivered', eventId: '$sent' });
  expect(router.findFileReply({ ...input, requestDigest: 'changed' }).ok).toBe(false);
});
test('attachment failures remain observable and never claim delivery', async () => {
  const f = files(), file = f.snapshot();
  await expect(prepareMatrixFile({ file, encrypted: true, upload: () => { throw new Error('should not upload'); } })).rejects.toMatchObject({ code: 'file_crypto_unavailable' });
  writeFileSync(file.path, 'corrupted');
  await expect(prepareMatrixFile({ file, encrypted: false })).rejects.toMatchObject({ code: 'file_integrity_mismatch', permanent: true });
  await expect(receiveMatrixFile({ content: { url: 'https://evil.test/secret' } })).rejects.toMatchObject({ code: 'invalid_media' });
  await expect(receiveMatrixFile({ content: { url: 'mxc://test/huge', info: { size: SESSION_FILE_MAX_BYTES + 1 } } })).rejects.toMatchObject({ code: 'file_too_large' });
  let cancelled = false;
  await expect(receiveMatrixFile({ content: { url: 'mxc://test/undeclared' }, baseUrl: 'https://matrix.test', token: 'token',
    directory: f.directory, fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(SESSION_FILE_MAX_BYTES + 1)); }, cancel() { cancelled = true; },
    })) })).rejects.toMatchObject({ code: 'file_too_large' });
  expect(cancelled).toBe(true);
  const router = openRouter({ dbPath: path.join(f.root, 'router.db') }); cleanup.push(() => router.close()); const cap = dispatch(router);
  router.queueFileReply({ ...cap, requestKey: 'failed', requestDigest: 'd', file, body: '' }); const cmd = router.claimReplyCommand();
  expect(router.recordReplyFailure({ commandId: cmd.commandId, claimToken: cmd.claimToken, errorCode: 'upload_forbidden', permanent: true }).ok).toBe(true);
  expect(router.readFileReply({ ...cap, commandId: cmd.commandId }).delivery).toMatchObject({ status: 'failed', eventId: null, errorCode: 'upload_forbidden' });
});
test('incoming files retain sender authority mention gating and scoped readable content', () => {
  const f = files(), file = f.snapshot(), router = openRouter({ dbPath: path.join(f.root, 'router.db') }); cleanup.push(() => router.close());
  const archive = (eventId, roomId = '!room:test', timestamp = 100) => router.conversations.archive({ roomId, eventId, senderMxid: '@alice:test', body: file.name, timestamp, attachment: file });
  archive('$upload'); expect(router.snapshot().dispatches).toEqual([]); archive('$one');
  archive('$foreign', '!foreign:test'); const cap = dispatch(router); archive('$future');
  const page = router.readConversation(cap); expect(page.messages[0]).toMatchObject({ sender: '@alice:test', attachment: { name: 'report.txt', eventId: '$upload' } });
  expect(JSON.stringify(page)).not.toContain(file.path);
  expect(router.receiveFile({ ...cap, eventId: '$upload' })).toMatchObject({ ok: true, file });
  expect(router.receiveFile({ ...cap, eventId: '$foreign' }).ok).toBe(false); expect(router.receiveFile({ ...cap, eventId: '$future' }).ok).toBe(false);
  router.conversations.bindDirect({ roomId: '!dm:test', agent: 'new', humanMxid: '@alice:test', projectRoomId: '!room:test', engagementId: 'new', mode: 'group', sinceTs: 200 });
  archive('$private', '!dm:test'); archive('$new', '!dm:test', 300); const group = dispatch(router, 'new', '!dm:test');
  expect(router.receiveFile({ ...group, eventId: '$private' }).ok).toBe(false); expect(router.receiveFile({ ...group, eventId: '$new' }).ok).toBe(true);
});
