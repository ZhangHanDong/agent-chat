import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { PendingEncryptedEventStore } from './pending-encrypted-event-store.js';
import { validateMasqueradeUserId } from './matrix-representative.js';

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function saveJson(file, data) {
  writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export async function ensureDirectDevice({ sender, directory, fetchImpl = fetch }) {
  validateMasqueradeUserId({ userId: sender.agentUserId, namespace: sender.credential.namespace,
    isRegisteredAgent: mxid => mxid === sender.agentUserId, label: 'direct-agent-device' });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'session.json');
  const cached = readJson(file, null);
  if (cached) {
    if (cached.user_id !== sender.agentUserId) throw new Error('direct device identity mismatch');
    if (cached.baseUrl === sender.side.apiBaseUrl) return cached;
    // A configured homeserver endpoint may move while its Matrix identity and
    // existing encrypted device remain the same. Prove that identity with the
    // cached device token before changing only its endpoint; never log in again.
    try {
      if (typeof cached.access_token !== 'string' || !cached.access_token
        || typeof cached.device_id !== 'string' || !cached.device_id) throw new Error();
      const target = new URL(sender.side.apiBaseUrl);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
        || target.search || target.hash) throw new Error();
      const response = await fetchImpl(`${target.href.replace(/\/+$/, '')}/_matrix/client/v3/account/whoami`, {
        method: 'GET', headers: { Authorization: `Bearer ${cached.access_token}` },
        redirect: 'error', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error();
      const identity = await response.json();
      if (!identity || Array.isArray(identity) || identity.user_id !== cached.user_id
        || identity.device_id !== cached.device_id) throw new Error();
    } catch {
      // Remote errors can contain request details; keep tokens out of warnings.
      throw new Error('direct device endpoint verification failed');
    }
    const migrated = { ...cached, baseUrl: sender.side.apiBaseUrl };
    saveJson(file, migrated);
    return migrated;
  }
  const response = await fetchImpl(`${sender.side.apiBaseUrl.replace(/\/+$/, '')}/_matrix/client/v3/login`, {
    method: 'POST', headers: { Authorization: `Bearer ${sender.credential.asToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'm.login.application_service', identifier: { type: 'm.id.user', user: sender.agentUserId },
      initial_device_display_name: 'HAFleet agent private chat' }),
  });
  const session = await response.json();
  if (!response.ok || session.user_id !== sender.agentUserId || !session.access_token || !session.device_id) {
    throw new Error(`direct agent device login failed: ${response.status} ${session.errcode || 'invalid device identity'}`);
  }
  const saved = { ...session, baseUrl: sender.side.apiBaseUrl };
  saveJson(file, saved);
  return saved;
}

export async function sendDirectEvent(client, roomId, content, transactionId) {
  // Read current room state, rather than assuming the crypto cache has already
  // seen an encryption event that may have arrived just before this send.
  const state = await client.getRoomState(roomId);
  const encrypted = state.some(event => event.type === 'm.room.encryption');
  if (encrypted && !client.crypto) throw new Error('direct room encryption is unavailable');
  const type = encrypted ? 'm.room.encrypted' : 'm.room.message';
  const wire = encrypted ? await client.crypto.encryptRoomEvent(roomId, 'm.room.message', content) : content;
  const result = await client.doRequest('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${type}/${encodeURIComponent(transactionId)}`, null, wire);
  if (!result.event_id) throw new Error('direct reply returned no event id');
  return result.event_id;
}

export function assertPrivateMembers(state, agentMxid, humanMxid) {
  const members = state.filter(event => event.type === 'm.room.member'
    && ['join', 'invite'].includes(event.content?.membership)).map(event => event.state_key);
  if (members.length !== 2 || !members.includes(agentMxid) || !members.includes(humanMxid)
    || !state.some(event => event.type === 'm.room.join_rules' && event.content?.join_rule === 'invite')) {
    throw new Error('direct room must be invite-only with exactly its bound human and agent');
  }
}

export class MatrixDirectChats {
  constructor({ directory, Client, sdk, backend, onMessage, onBinding, warning }) {
    this.directory = directory; this.Client = Client; this.backend = backend;
    this.sdk = sdk;
    this.onMessage = onMessage; this.onBinding = onBinding; this.warning = warning;
    this.clients = new Map(); this.starting = new Map();
  }

  async refresh(senders) {
    const wanted = new Set(senders.map(sender => sender.agentUserId));
    for (const [mxid, entry] of this.clients) if (!wanted.has(mxid)) { entry.client.stop(); this.clients.delete(mxid); }
    for (const sender of senders) {
      try { await this.ensure(sender); }
      catch (error) { this.warning(`Private chat unavailable for ${sender.agentName}: ${error.message}`); }
    }
  }

  async ensure(sender) {
    if (this.starting.has(sender.agentUserId)) return this.starting.get(sender.agentUserId);
    if (this.clients.has(sender.agentUserId)) return this.clients.get(sender.agentUserId);
    const pending = this.start(sender);
    this.starting.set(sender.agentUserId, pending);
    try { return await pending; } finally { this.starting.delete(sender.agentUserId); }
  }

  async start(sender) {
    const directory = path.join(this.directory, createHash('sha256').update(sender.agentUserId).digest('hex'));
    const session = await ensureDirectDevice({ sender, directory });
    const client = new this.Client(sender.side.apiBaseUrl, session.access_token,
      new this.sdk.SimpleFsStorageProvider(path.join(directory, 'sync.json')),
      new this.sdk.RustSdkCryptoStorageProvider(path.join(directory, 'crypto'), 0));
    const file = path.join(directory, 'rooms.json');
    const entry = { client, sender, file, rooms: readJson(file, {}), backfills: new Map(),
      pending: new PendingEncryptedEventStore(path.join(directory, 'pending-encrypted.json'),
        { maxAgeMs: Number.MAX_SAFE_INTEGER, maxEntries: 10000 }) };
    for (const binding of Object.values(entry.rooms)) this.onBinding(binding);
    client.persistTokenAfterSync = true;
    client.agentChatSyncHandler = async (type, roomId, event, error) => {
      if (type === 'room.invite') return this.invite(entry, roomId, event);
      if (type === 'room.message') return this.message(entry, roomId, event);
      if (type === 'room.join') return client.crypto?.onRoomJoin(roomId);
      if (type === 'room.event') return client.crypto?.onRoomEvent(roomId, event);
      if (type === 'room.failed_decryption' && entry.rooms[roomId]) {
        entry.pending.put({ roomId, event });
        this.warning(`Private message awaiting encryption key in ${roomId}: ${error?.message || 'key unavailable'}`);
        return;
      }
      return client.emit(type, roomId, event, error);
    };
    client.onSyncSuccess = async () => {
      for (const [roomId, binding] of Object.entries(entry.rooms)) {
        if (binding.historyPending) await this.backfill(entry, roomId);
      }
      for (const item of entry.pending.list()) {
        try {
          const decrypted = await client.crypto.decryptRoomEvent(new this.sdk.EncryptedRoomEvent(item.event), item.roomId);
          await this.message(entry, item.roomId, decrypted.raw);
          entry.pending.remove(item.eventId);
        } catch { /* retain until keys arrive; never consume undecrypted text */ }
      }
    };
    const who = await client.getUserId();
    if (who !== sender.agentUserId) throw new Error('direct crypto client belongs to another identity');
    this.clients.set(sender.agentUserId, entry);
    try { await client.start(); } catch (error) { this.clients.delete(sender.agentUserId); client.stop(); throw error; }
    return entry;
  }

  async invite(entry, roomId, event) {
    if (event.state_key !== entry.sender.agentUserId) return;
    let binding;
    try {
      const response = await this.backend('POST', '/api/matrix/direct-rooms', {
        agent: entry.sender.agentName, humanMxid: event.sender, roomId,
        mode: event.content?.is_direct === true ? 'direct' : 'group',
        sinceTs: Number.isSafeInteger(event.origin_server_ts) ? event.origin_server_ts : Date.now(),
      });
      binding = response.binding;
    } catch (error) {
      this.warning(`Private invitation not admitted in ${roomId}: ${error.message}`);
      if (/403|not_authorized|ambiguous/.test(error.message)) return;
      throw error;
    }
    await entry.client.joinRoom(roomId);
    entry.rooms[roomId] = { ...binding, historyPending: true };
    await this.verify(entry, binding);
    saveJson(entry.file, entry.rooms); this.onBinding(entry.rooms[roomId]);
    await this.backfill(entry, roomId);
  }

  async backfill(entry, roomId) {
    entry.backfills ??= new Map();
    if (entry.backfills.has(roomId)) return entry.backfills.get(roomId);
    const work = this.readHistory(entry, roomId);
    entry.backfills.set(roomId, work);
    try { await work; } finally { entry.backfills.delete(roomId); }
  }

  async readHistory(entry, roomId) {
    // Invites can precede the user's first message by less than one sync round.
    // Read the joined history once; event dedup handles overlap with live sync.
    const events = []; const cursors = new Set(); let from = null;
    do {
      const history = await entry.client.doRequest('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
        { dir: 'b', limit: 100, ...(from ? { from } : {}) });
      events.push(...(history.chunk || []));
      if (!history.chunk?.length || !history.end) break;
      if (cursors.has(history.end)) throw new Error('direct history pagination repeated a cursor');
      cursors.add(history.end); from = history.end;
    } while (from);
    for (const message of events.reverse()) {
      if (message.type === 'm.room.message') await this.message(entry, roomId, message, true);
      else if (message.type === 'm.room.encrypted') entry.pending.put({ roomId, event: message });
    }
    entry.rooms[roomId].historyPending = false;
    saveJson(entry.file, entry.rooms);
  }

  async verify(entry, binding, senderMxid = null) {
    const state = await entry.client.getRoomState(binding.roomId);
    const membership = state.filter(e => e.type === 'm.room.member' && ['join', 'invite'].includes(e.content?.membership));
    const members = membership.filter(e => e.content.membership === 'join').map(e => e.state_key);
    if (!members.includes(entry.sender.agentUserId) || senderMxid && !members.includes(senderMxid)) throw new Error('room member is not joined');
    const mode = binding.mode === 'group' || membership.length !== 2 || !members.includes(binding.humanMxid) ? 'group' : 'direct';
    const sinceTs = binding.mode === 'group' ? binding.sinceTs : Math.min(...membership
      .filter(e => ![entry.sender.agentUserId, binding.humanMxid].includes(e.state_key))
      .map(e => Number.isSafeInteger(e.origin_server_ts) ? e.origin_server_ts : Date.now()), Date.now());
    const response = await this.backend('POST', '/api/matrix/direct-rooms', { agent: entry.sender.agentName,
      humanMxid: binding.humanMxid, roomId: binding.roomId, mode, ...(mode === 'group' ? { sinceTs: sinceTs ?? 0 } : {}) });
    const current = { ...entry.rooms[binding.roomId], ...response.binding };
    entry.rooms[binding.roomId] = current; saveJson(entry.file, entry.rooms); this.onBinding(current);
    if (senderMxid && senderMxid !== current.humanMxid) await this.backend('POST', '/api/matrix/direct-rooms', {
      agent: entry.sender.agentName, humanMxid: senderMxid, roomId: binding.roomId });
    return { ...response, members, mode: current.mode || mode };
  }

  async message(entry, roomId, event, fromHistory = false) {
    const binding = entry.rooms[roomId];
    // Own-device echoes are still conversation evidence. The bridge archives
    // admitted Agent messages as background without routing them as requests.
    if (!binding) return;
    if (binding.historyPending && !fromHistory) await this.backfill(entry, roomId);
    try { await this.verify(entry, binding); }
    catch (error) {
      this.warning(`Private chat paused in ${roomId}: ${error.message}`);
      if (/403|not_authorized|not joined/.test(error.message)) return;
      throw error;
    }
    if (Number.isFinite(event.origin_server_ts) && event.origin_server_ts < (entry.rooms[roomId].sinceTs || 0)) return;
    return this.onMessage(roomId, event);
  }

  entriesForRoom(roomId) { return [...this.clients.values()].filter(entry => entry.rooms[roomId]); }

  entryForRoom(roomId, agentName = null) {
    return this.entriesForRoom(roomId).find(entry => !agentName || entry.sender.agentName === agentName) || null;
  }

  async send(roomId, content, transactionId, agentName = null) {
    if (!agentName && this.entriesForRoom(roomId).length > 1) throw new Error('room reply requires its agent identity');
    const entry = this.entryForRoom(roomId, agentName);
    if (!entry) throw new Error('direct room device is unavailable');
    await this.verify(entry, entry.rooms[roomId]);
    this.assertReplyScope(entry, roomId, content);
    const directContent = { ...content };
    const binding = entry.rooms[roomId];
    if (binding.mode !== 'group') {
      if (directContent['m.relates_to']?.rel_type !== 'm.replace') delete directContent['m.relates_to'];
      if (directContent['m.new_content']) {
        directContent['m.new_content'] = { ...directContent['m.new_content'] };
        delete directContent['m.new_content']['m.relates_to'];
      }
    }
    return sendDirectEvent(entry.client, roomId, directContent, transactionId);
  }

  assertReplyScope(entry, roomId, content) {
    const binding = entry.rooms[roomId];
    if (binding?.mode === 'group' && binding.privateRootEventId
      && [content['m.relates_to']?.event_id, content['m.new_content']?.['m.relates_to']?.event_id]
        .includes(binding.privateRootEventId)) throw new Error('private reply cannot be delivered after room promotion');
  }
}
