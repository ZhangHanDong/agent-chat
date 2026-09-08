import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Attachment, EncryptedAttachment } from '@matrix-org/matrix-sdk-crypto-nodejs';
import { SESSION_FILE_MAX_BYTES, snapshotSessionFile } from './session-file.js';
import { setMasqueradeUserParam } from './matrix-representative.js';

export class MatrixFileError extends Error {
  constructor(code, message) { super(message); this.code = code; this.permanent = true; }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const encryptedRoom = state => state.some(e => e.type === 'm.room.encryption');

export async function prepareMatrixFile({ file, caption, relation, encrypted, crypto, upload }) {
  try {
    const checked = snapshotSessionFile({ workspace: path.dirname(file.path), requestedPath: file.path, name: file.name, directory: path.dirname(file.path) });
    if (checked.sha256 !== file.sha256 || checked.size !== file.size) throw new Error('integrity');
  } catch { throw new MatrixFileError('file_integrity_mismatch', 'Staged attachment is unavailable or changed'); }
  const bytes = readFileSync(file.path);
  if (hash(bytes) !== file.sha256) throw new MatrixFileError('file_integrity_mismatch', 'Staged attachment changed');
  const content = { msgtype: file.kind === 'image' ? 'm.image' : 'm.file', filename: file.name,
    body: caption || file.name, info: { mimetype: file.mime, size: bytes.length } };
  if (relation) content['m.relates_to'] = relation;
  if (encrypted) {
    if (!crypto?.encryptMedia) throw new MatrixFileError('file_crypto_unavailable', 'Encrypted file transport is unavailable');
    const protectedFile = await crypto.encryptMedia(bytes);
    const url = await upload(protectedFile.buffer, 'application/octet-stream');
    if (!/^mxc:\/\/[^/]+\/[^/?#]+$/.test(url)) throw new Error('Matrix upload returned no valid media URI');
    content.file = { ...protectedFile.file, url };
  } else {
    content.url = await upload(bytes, file.mime);
    if (!/^mxc:\/\/[^/]+\/[^/?#]+$/.test(content.url)) throw new Error('Matrix upload returned no valid media URI');
  }
  return content;
}

export async function receiveMatrixFile({ content, baseUrl, token, directory, asUserId = null, fetchImpl = fetch }) {
  const mxc = content.file?.url || content.url;
  const match = typeof mxc === 'string' && /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxc);
  if (!match) throw new MatrixFileError('invalid_media', 'Matrix attachment has no valid media URI');
  if (Number(content.info?.size) > SESSION_FILE_MAX_BYTES) throw new MatrixFileError('file_too_large', 'Attachment exceeds 20 MiB');
  const url = new URL(`/_matrix/client/v1/media/download/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`, baseUrl);
  if (asUserId) setMasqueradeUserParam(url, asUserId);
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (response.status === 404 || response.status === 410) throw new MatrixFileError('media_unavailable', 'Matrix attachment is no longer available');
  if (!response.ok) throw new Error(`Matrix media download failed (HTTP ${response.status})`);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > SESSION_FILE_MAX_BYTES) { await reader.cancel(); throw new MatrixFileError('file_too_large', 'Attachment exceeds 20 MiB'); }
      chunks.push(Buffer.from(next.value));
    }
  } finally { reader.releaseLock(); }
  let bytes = Buffer.concat(chunks);
  if (content.file) {
    // The same authenticated primitive used by matrix-bot-sdk, over bounded bytes.
    try { bytes = Buffer.from(Attachment.decrypt(new EncryptedAttachment(bytes, JSON.stringify(content.file)))); }
    catch { throw new MatrixFileError('file_decryption_failed', 'Attachment integrity or decryption failed'); }
  }
  const sha256 = hash(bytes), filePath = path.join(directory, `${sha256}.bin`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { writeFileSync(filePath, bytes, { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || hash(readFileSync(filePath)) !== sha256) throw error; }
  let name = String(content.filename || content.body || 'attachment.bin').normalize('NFC').replace(/[\x00-\x1f\x7f/\\]/g, '_');
  name = Array.from(name).reduce((out, char) => Buffer.byteLength(out + char) <= 240 ? out + char : out, '');
  if (!name || name === '.' || name === '..') name = 'attachment.bin';
  return { path: filePath, name, mime: String(content.info?.mimetype || 'application/octet-stream'), size: bytes.length, sha256 };
}
