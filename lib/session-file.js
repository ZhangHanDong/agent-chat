import { constants, openSync, closeSync, fstatSync, statSync, realpathSync, readSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SESSION_FILE_MAX_BYTES = 20 * 1024 * 1024;
export class SessionFileError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const inside = (root, file) => { const relative = path.relative(root, file); return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const MIMES = { '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.js': 'text/javascript', '.html': 'text/html', '.svg': 'image/svg+xml' };

export function snapshotSessionFile({ workspace, requestedPath, name, directory, maxBytes = SESSION_FILE_MAX_BYTES }) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim() || requestedPath.includes('\0')) throw new SessionFileError('invalid_file', 'A workspace file path is required');
  const root = realpathSync(workspace);
  const alias = path.resolve(workspace), lexical = path.resolve(alias, requestedPath);
  const requested = path.resolve(root, inside(alias, lexical) ? path.relative(alias, lexical) : requestedPath);
  if (!inside(root, requested)) throw new SessionFileError('file_outside_workspace', 'File must be inside the current workspace', 403);
  let resolved;
  try { resolved = realpathSync(requested); } catch { throw new SessionFileError('file_not_found', 'Workspace file was not found', 404); }
  if (!inside(root, resolved)) throw new SessionFileError('file_outside_workspace', 'File resolves outside the current workspace', 403);
  const filename = String(name || path.basename(requested)).normalize('NFC').replace(/[\x00-\x1f\x7f/\\]/g, '_').trim();
  if (!filename || filename === '.' || filename === '..' || Buffer.byteLength(filename) > 240) throw new SessionFileError('invalid_filename', 'Filename must be between 1 and 240 UTF-8 bytes');
  let fd;
  try {
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) throw new SessionFileError('invalid_file', 'Only regular, non-hardlinked workspace files can be sent');
    const confirmed = realpathSync(requested), observed = statSync(confirmed);
    if (!inside(root, confirmed) || observed.dev !== before.dev || observed.ino !== before.ino) throw new SessionFileError('file_changed', 'File changed while opening it; retry');
    if (before.size > maxBytes) throw new SessionFileError('file_too_large', `File exceeds ${maxBytes} bytes`, 413);
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, before.size + 1));
    let length = 0, count;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    const after = fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new SessionFileError('file_changed', 'File changed while reading it; retry');
    const bytes = buffer.subarray(0, length), sha256 = hash(bytes);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const staged = path.join(directory, `${sha256}.bin`);
    try { writeFileSync(staged, bytes, { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (hash(readFileSync(staged)) !== sha256) throw new SessionFileError('file_integrity_mismatch', 'Staged file integrity check failed');
    }
    const mime = MIMES[path.extname(filename).toLowerCase()] || 'application/octet-stream';
    return { path: staged, name: filename, mime, kind: /^image\/(png|jpeg|gif|webp)$/.test(mime) ? 'image' : 'file', size: length, sha256 };
  } finally { if (fd !== undefined) closeSync(fd); }
}
