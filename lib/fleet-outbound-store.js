import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

const canonical = value => JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
export const outboundDigest = value => createHash('sha256').update(canonical(value)).digest('hex');

const INBOX_SCHEMA = `CREATE TABLE inbox (id TEXT NOT NULL, lane TEXT NOT NULL, kind TEXT NOT NULL,
  digest TEXT NOT NULL, payload TEXT NOT NULL, token TEXT NOT NULL, state TEXT NOT NULL,
  generation INTEGER NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY(lane,id))`;

/** Registration-bound durable custody; machine and Matrix credentials are never stored here. */
export class FleetOutboundStore {
  constructor(file, binding) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.pragma('journal_mode = DELETE'); this.db.pragma('synchronous = FULL');
    this.db.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const existing = this.meta('binding');
    if (existing && existing !== outboundDigest(binding)) { this.db.close(); throw new Error('outbound inbox belongs to another registration'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, payload TEXT NOT NULL, admitted INTEGER NOT NULL DEFAULT 0,
        status TEXT, check_at INTEGER NOT NULL DEFAULT 0, observed_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, cursor_after INTEGER);`);
    this.db.transaction(() => {
      const columns = this.db.pragma('table_info(inbox)');
      if (!columns.length) this.db.exec(INBOX_SCHEMA);
      else if (!columns.some(column => column.name === 'generation') || columns.filter(column => column.pk).length !== 2) {
        this.db.exec('ALTER TABLE inbox RENAME TO inbox_previous');
        this.db.exec(INBOX_SCHEMA);
        const generation = columns.some(column => column.name === 'generation') ? 'generation' : '1';
        this.db.exec(`INSERT INTO inbox(id,lane,kind,digest,payload,token,state,generation,retry_at,error)
          SELECT id,lane,kind,digest,payload,token,state,${generation},retry_at,error FROM inbox_previous ORDER BY rowid;
          DROP TABLE inbox_previous;`);
      }
      if (!this.db.pragma('table_info(outbox)').some(column => column.name === 'cursor_after')) {
        this.db.exec('ALTER TABLE outbox ADD COLUMN cursor_after INTEGER');
      }
      if (!this.db.pragma('table_info(requests)').some(column => column.name === 'observed_at')) {
        // A previous cache has no evidence of when its membership was checked.
        this.db.exec('ALTER TABLE requests ADD COLUMN observed_at INTEGER NOT NULL DEFAULT 0');
      }
    })();
    if (!existing) this.db.transaction(() => {
      this.setMeta('binding', outboundDigest(binding)); this.setMeta('consumer', randomUUID()); this.setMeta('sequence', '0');
    })();
  }
  meta(key) { return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value; }
  setMeta(key, value) { this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  activateTransport({ generation, fingerprint }) {
    if (!Number.isSafeInteger(generation) || generation < 1 || typeof fingerprint !== 'string' || !fingerprint || fingerprint.length > 512) {
      throw new Error('invalid outbound transport identity');
    }
    return this.db.transaction(() => {
      const savedGeneration = Number(this.meta('generation')) || null;
      const inferredGeneration = this.pendingUpdate()?.generation
        ?? this.db.prepare('SELECT MAX(generation) AS generation FROM inbox').get()?.generation ?? null;
      const previousGeneration = savedGeneration ?? inferredGeneration;
      if (!savedGeneration && (!previousGeneration || previousGeneration === generation)) {
        // Initial activation (including a pre-metadata inbox upgrade) must not
        // discard an update whose response may already have been committed.
        this.setMeta('generation', String(generation)); this.setMeta('fingerprint', fingerprint);
        return { changed: true, generation, previousGeneration };
      }
      if (previousGeneration === generation) {
        if (this.meta('fingerprint') !== fingerprint) throw new Error('outbound transport changed without a new generation');
        return { changed: false, generation, previousGeneration };
      }
      if (previousGeneration && generation < previousGeneration) throw new Error('outbound transport generation is stale');
      // ACK transferred custody to this registration, including when its HTTP
      // response was lost. Retain that work across transport credential rotation
      // without attempting another ACK using the retired transport lease.
      this.db.prepare(`UPDATE inbox SET state='acked',retry_at=0,error=NULL
        WHERE kind!='probe' AND state!='done'`).run();
      this.db.prepare(`UPDATE inbox SET state='done',retry_at=0,error='transport_generation_retired'
        WHERE kind='probe' AND state!='done' AND generation<?`).run(generation);
      this.db.exec('DELETE FROM receipts; DELETE FROM outbox; UPDATE requests SET status=NULL,check_at=0,observed_at=0');
      this.setMeta('generation', String(generation)); this.setMeta('fingerprint', fingerprint);
      this.setMeta('sequence', '0'); this.setMeta('status_cursor', '0');
      return { changed: true, generation, previousGeneration };
    })();
  }
  receive(delivery, generation = Number(this.meta('generation')) || 1) {
    if (!Number.isSafeInteger(generation) || generation < 1
      || this.meta('generation') && generation !== Number(this.meta('generation'))) throw new Error('outbound delivery generation mismatch');
    if (!delivery || typeof delivery.id !== 'string' || !delivery.id || delivery.id.length > 512
      || !['matrix', 'work'].includes(delivery.lane) || !['transaction', 'probe', 'request'].includes(delivery.kind)
      || (delivery.lane === 'matrix') !== (delivery.kind === 'transaction')
      || typeof delivery.token !== 'string' || !delivery.token || delivery.token.length > 4096
      || !delivery.payload || typeof delivery.payload !== 'object' || Array.isArray(delivery.payload)) throw new Error('invalid outbound delivery');
    const digest = outboundDigest({ lane: delivery.lane, kind: delivery.kind, payload: delivery.payload });
    const previous = this.db.prepare('SELECT * FROM inbox WHERE lane=? AND id=?').get(delivery.lane, delivery.id);
    if (previous && previous.digest !== digest) throw new Error('outbound delivery content conflict');
    const payload = JSON.stringify(delivery.payload);
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw new Error('outbound delivery exceeds inbox limit');
    this.db.prepare(`INSERT INTO inbox(id,lane,kind,digest,payload,token,state,generation) VALUES(?,?,?,?,?,?,'received',?)
      ON CONFLICT(lane,id) DO UPDATE SET token=excluded.token,
      state=CASE WHEN inbox.state='done' THEN 'done' ELSE 'received' END, retry_at=0`).run(
      delivery.id, delivery.lane, delivery.kind, digest, payload, delivery.token, generation);
  }
  next(lane, now = Date.now()) {
    const row = lane === 'matrix'
      ? this.db.prepare("SELECT * FROM inbox WHERE lane=? AND state NOT IN ('done','reclaim') ORDER BY rowid LIMIT 1").get(lane)
      : this.db.prepare("SELECT * FROM inbox WHERE lane=? AND state NOT IN ('done','reclaim') AND retry_at<=? ORDER BY rowid LIMIT 1").get(lane, now);
    if (row?.retry_at > now) return null;
    return row ? { ...row, payload: JSON.parse(row.payload) } : null;
  }
  laneFor(id, lane) {
    if (lane !== undefined) {
      if (!['matrix', 'work'].includes(lane)) throw new Error('invalid outbound lane');
      return lane;
    }
    const rows = this.db.prepare('SELECT lane FROM inbox WHERE id=?').all(id);
    if (rows.length !== 1) throw new Error('outbound delivery lane is missing or ambiguous');
    return rows[0].lane;
  }
  acknowledged(id, lane) { this.db.prepare("UPDATE inbox SET state='acked' WHERE lane=? AND id=? AND state!='done'").run(this.laneFor(id, lane), id); }
  reclaim(id, lane) { this.db.prepare("UPDATE inbox SET state='reclaim' WHERE lane=? AND id=? AND state!='done'").run(this.laneFor(id, lane), id); }
  retry(id, code, now = Date.now(), lane) { this.db.prepare('UPDATE inbox SET retry_at=?,error=? WHERE lane=? AND id=?').run(now + 5000, String(code).slice(0,160), this.laneFor(id, lane), id); }
  finish(id, { request, receipt, lane } = {}) {
    this.db.transaction(() => {
      const selectedLane = this.laneFor(id, lane);
      if (request) {
        const existing = this.db.prepare('SELECT payload FROM requests WHERE id=?').get(request.requestId);
        if (existing && outboundDigest(JSON.parse(existing.payload)) !== outboundDigest(request)) throw new Error('outbound request content conflict');
        this.db.prepare('INSERT INTO requests(id,payload) VALUES(?,?) ON CONFLICT(id) DO NOTHING').run(request.requestId, JSON.stringify(request));
      }
      if (receipt) this.db.prepare('INSERT INTO receipts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(receipt.sourceEventId, JSON.stringify(receipt));
      this.db.prepare("UPDATE inbox SET state='done',error=NULL WHERE lane=? AND id=?").run(selectedLane, id);
    })();
  }
  trackedRequests() { return this.db.prepare('SELECT * FROM requests ORDER BY rowid').all().map(row => ({ ...row, payload: JSON.parse(row.payload) })); }
  dueRequests(now = Date.now()) { return this.db.prepare('SELECT * FROM requests WHERE check_at<=? ORDER BY check_at,rowid LIMIT 3').all(now).map(row => ({ ...row, payload: JSON.parse(row.payload) })); }
  deferRequest(id, now = Date.now()) { this.db.prepare('UPDATE requests SET check_at=? WHERE id=?').run(now + 15000, id); }
  observeRequest(id, status, now = Date.now()) {
    this.db.prepare('UPDATE requests SET status=?,observed_at=? WHERE id=?')
      .run(JSON.stringify(status), Number.isSafeInteger(now) && now > 0 ? now : 0, id);
  }
  requestSnapshots(now = Date.now()) {
    const cursor = Number(this.meta('status_cursor')) || 0;
    let rows = this.db.prepare('SELECT status,observed_at FROM requests WHERE status IS NOT NULL AND rowid>? ORDER BY rowid LIMIT 200').all(cursor);
    if (!rows.length) rows = this.db.prepare('SELECT status,observed_at FROM requests WHERE status IS NOT NULL ORDER BY rowid LIMIT 200').all();
    return rows.map(row => {
      const observed = Number.isSafeInteger(row.observed_at) && row.observed_at > 0 ? new Date(row.observed_at) : null;
      const observedAt = observed && Number.isFinite(observed.getTime()) ? observed.toISOString() : null;
      // Preserve the original observation time on the wire, including inside a
      // frozen outbox whose first successful delivery may be much later.
      const status = { ...JSON.parse(row.status), observedAt };
      if (observedAt && Number.isSafeInteger(now)
        && now >= row.observed_at && now - row.observed_at < 90000) return status;
      // Publishing a cached result cannot renew the underlying Matrix proof.
      // Keep the stored observation intact for cursor selection and reconciliation.
      return { ...status, ready: false, fulfillment: { phase: 'verification', incomplete: true,
        error: 'Hagency must refresh request verification before this agent is usable.' } };
    });
  }
  waiting(lane) { return this.db.prepare("SELECT retry_at FROM inbox WHERE lane=? AND state IN ('received','acked') ORDER BY rowid LIMIT 1").get(lane); }
  admitted(id) { this.db.prepare('UPDATE requests SET admitted=1 WHERE id=?').run(id); }
  pendingUpdate() { const row = this.db.prepare('SELECT payload FROM outbox WHERE id=1').get(); return row ? JSON.parse(row.payload) : null; }
  enqueueUpdate(body) {
    return this.db.transaction(() => {
      const pending = this.pendingUpdate(); if (pending) return pending;
      const sequence = Number(this.meta('sequence')) + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error('outbound sequence exhausted');
      if (body.statuses && (!Array.isArray(body.statuses) || body.statuses.length > 200)) throw new Error('outbound status batch exceeds limit');
      const probeReceipts = this.db.prepare('SELECT payload FROM receipts ORDER BY rowid LIMIT 10').all().map(row => JSON.parse(row.payload));
      const payload = { ...body, sequence, probeReceipts };
      const lastRequest = payload.statuses?.at(-1)?.requestId;
      const cursor = lastRequest ? this.db.prepare('SELECT rowid FROM requests WHERE id=?').get(lastRequest)?.rowid ?? null : null;
      this.setMeta('sequence', String(sequence));
      this.db.prepare('INSERT INTO outbox(id,payload,cursor_after) VALUES(1,?,?)').run(JSON.stringify(payload), cursor);
      return payload;
    })();
  }
  updateAccepted(payload) {
    this.db.transaction(() => {
      const pending = this.pendingUpdate();
      if (!pending || outboundDigest(pending) !== outboundDigest(payload)) throw new Error('outbound update receipt mismatch');
      for (const receipt of pending.probeReceipts) this.db.prepare('DELETE FROM receipts WHERE id=? AND payload=?').run(receipt.sourceEventId, JSON.stringify(receipt));
      const cursor = this.db.prepare('SELECT cursor_after FROM outbox WHERE id=1').get()?.cursor_after;
      if (cursor !== null && cursor !== undefined) this.setMeta('status_cursor', String(cursor));
      this.db.prepare('DELETE FROM outbox WHERE id=1').run();
    })();
  }
  close() { this.db.close(); }
}
