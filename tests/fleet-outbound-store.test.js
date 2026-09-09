import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { FleetOutboundStore, outboundDigest } from '../lib/fleet-outbound-store.js';

const binding = { sideId: 'test', fleetId: `hf_${'a'.repeat(32)}`, registration: 'registered-matrix-appservice' };
const dirs = [], stores = [];
afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const open = (file = ':memory:', registration = binding) => {
  const store = new FleetOutboundStore(file, registration); stores.push(store); return store;
};
const disk = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-outbound-store-')); dirs.push(dir); return path.join(dir, 'outbound.sqlite');
};
const delivery = (id, lane = 'matrix', kind = 'transaction', payload = { transactionId: id, body: { events: [] } }) =>
  ({ id, lane, kind, token: `lease-${id}`, payload });
const addRequest = (store, id, status = 'pending') => {
  const payload = { v: 1, requestId: id, fleetId: binding.fleetId, role: 'coding', requestedTokens: 100 };
  store.receive(delivery(id, 'work', 'request', payload)); store.finish(id, { request: payload, lane: 'work' });
  store.observeRequest(id, { ...payload, state: status });
};
const update = store => store.enqueueUpdate({ v: 2, generation: Number(store.meta('generation')) || 1,
  heartbeat: true, statuses: store.requestSnapshots() });

test('outbound inbox distinguishes simultaneous lane IDs through acknowledgement and completion', () => {
  const store = open();
  store.receive(delivery('shared'));
  store.receive(delivery('shared', 'work', 'request', { requestId: 'shared' }));
  expect(() => store.acknowledged('shared')).toThrow('ambiguous');
  store.acknowledged('shared', 'matrix'); store.reclaim('shared', 'work');
  expect(store.next('matrix')).toMatchObject({ id: 'shared', state: 'acked', generation: 1 });
  expect(store.next('work')).toBeNull();
  store.receive(delivery('shared', 'work', 'request', { requestId: 'shared' }));
  store.retry('shared', 'temporary', 10, 'work');
  expect(store.next('work', 10)).toBeNull();
  expect(store.next('matrix', 10)?.state).toBe('acked');
  store.finish('shared', { request: { requestId: 'shared' }, lane: 'work' });
  expect(store.next('work', 10000)).toBeNull();
  expect(store.next('matrix')?.state).toBe('acked');
  expect(() => store.receive(delivery('shared', 'matrix', 'transaction', { transactionId: 'changed' }))).toThrow('content conflict');
  store.finish('shared', { lane: 'matrix' });
  expect(store.next('matrix')).toBeNull();
});

test('201 outbound statuses rotate bounded batches without starvation or losing pending changes', () => {
  const file = disk(); let store = open(file);
  store.activateTransport({ generation: 1, fingerprint: 'machine-one' });
  for (let i = 0; i < 201; i++) addRequest(store, `request-${i}`);
  const first = update(store);
  expect(first.statuses).toHaveLength(200);
  expect(first.statuses.at(-1).requestId).toBe('request-199');
  store.observeRequest('request-0', { ...first.statuses[0], state: 'active' });
  expect(update(store)).toEqual(first);
  expect(() => store.updateAccepted({ ...first, sequence: first.sequence + 1 })).toThrow('mismatch');
  expect(store.meta('status_cursor')).toBeUndefined();
  store.close(); store = open(file);
  store.activateTransport({ generation: 1, fingerprint: 'machine-one' });
  expect(update(store)).toEqual(first); // lost HTTP response/restart retries byte-equivalent content
  expect(outboundDigest(update(store))).toBe(outboundDigest(first));
  store.updateAccepted(first);
  const second = update(store);
  expect(second.statuses.map(row => row.requestId)).toEqual(['request-200']);
  store.updateAccepted(second);
  const third = update(store);
  expect(third.statuses).toHaveLength(200);
  expect(third.statuses[0]).toMatchObject({ requestId: 'request-0', state: 'active' });
  expect(new Set([...first.statuses, ...second.statuses].map(row => row.requestId)).size).toBe(201);
});

test('outbound observation age survives restart and only a fresh check restores readiness', () => {
  const file = disk(), observedAt = 1000000; let store = open(file);
  addRequest(store, 'observed');
  const status = { requestId: 'observed', state: 'active', bound: true, ready: true,
    fulfillment: { phase: 'ready', incomplete: false } };
  store.observeRequest('observed', status, observedAt);
  expect(store.requestSnapshots(observedAt + 89999)).toEqual([{ ...status, observedAt: new Date(observedAt).toISOString() }]);
  const uncertain = store.enqueueUpdate({ v: 2, generation: 1, heartbeat: true,
    statuses: store.requestSnapshots(observedAt + 89999) });
  store.close(); store = open(file);
  const expired = store.requestSnapshots(observedAt + 90000)[0];
  expect(expired).toEqual({ ...status, ready: false, observedAt: new Date(observedAt).toISOString(),
    fulfillment: { phase: 'verification', incomplete: true,
      error: 'HAFleet must refresh request verification before this agent is usable.' } });
  // Cache reads and republishing cannot rewrite the original observation or
  // alter a frozen update after an uncertain HTTP response.
  expect(store.requestSnapshots(observedAt + 180000)[0]).toEqual(expired);
  expect(store.trackedRequests()[0]).toMatchObject({ status: JSON.stringify(status), observed_at: observedAt });
  expect(store.pendingUpdate()).toEqual(uncertain);
  expect(store.pendingUpdate().statuses[0].observedAt).toBe(new Date(observedAt).toISOString());
  store.updateAccepted(uncertain);
  store.observeRequest('observed', status, observedAt + 180000);
  expect(store.requestSnapshots(observedAt + 180000)).toEqual([{ ...status, observedAt: new Date(observedAt + 180000).toISOString() }]);
});

test('outbound invalid or future observation times cannot establish ready snapshots', () => {
  const store = open(), now = 1000000;
  addRequest(store, 'invalid-time');
  const status = { requestId: 'invalid-time', state: 'active', ready: true };
  for (const observedAt of [0, -1, NaN, Infinity, '1000000', Number.MAX_SAFE_INTEGER, now + 1]) {
    store.observeRequest('invalid-time', status, observedAt);
    expect(store.requestSnapshots(now)[0]).toMatchObject({ ready: false,
      fulfillment: { phase: 'verification', incomplete: true } });
  }
  store.observeRequest('invalid-time', status, now);
  for (const readTime of [NaN, Infinity, 0, now - 1]) expect(store.requestSnapshots(readTime)[0].ready).toBe(false);
  expect(store.requestSnapshots(now)[0].ready).toBe(true);
});

test('201 expired outbound observations retain bounded cursor rotation and fresh changes', () => {
  const store = open(), observedAt = 1000000, now = observedAt + 90000;
  for (let i = 0; i < 201; i++) {
    const id = `expired-${i}`; addRequest(store, id);
    store.observeRequest(id, { requestId: id, state: 'active', ready: true }, observedAt);
  }
  const first = store.enqueueUpdate({ v: 2, generation: 1, statuses: store.requestSnapshots(now) });
  expect(first.statuses).toHaveLength(200);
  expect(first.statuses.every(row => row.ready === false)).toBe(true);
  store.observeRequest('expired-0', { requestId: 'expired-0', state: 'active', ready: true }, now);
  expect(store.pendingUpdate()).toEqual(first);
  store.updateAccepted(first);
  const second = store.enqueueUpdate({ v: 2, generation: 1, statuses: store.requestSnapshots(now) });
  expect(second.statuses.map(row => row.requestId)).toEqual(['expired-200']);
  expect(second.statuses[0].ready).toBe(false); store.updateAccepted(second);
  const third = store.requestSnapshots(now);
  expect(third).toHaveLength(200); expect(third[0].ready).toBe(true);
  expect(third.slice(1).every(row => row.ready === false)).toBe(true);
  expect(new Set([...first.statuses, ...second.statuses].map(row => row.requestId)).size).toBe(201);
});

test('outbound receipts are bounded and exact ACK preserves receipts changed during an update', () => {
  const store = open();
  for (let i = 0; i < 11; i++) {
    store.receive(delivery(`probe-${i}`, 'work', 'probe', { sourceEventId: `$probe-${i}` }));
    store.finish(`probe-${i}`, { receipt: { sourceEventId: `$probe-${i}`, receivedAt: 1 }, lane: 'work' });
  }
  const first = update(store); expect(first.probeReceipts).toHaveLength(10);
  store.finish('probe-0', { receipt: { sourceEventId: '$probe-0', receivedAt: 2 }, lane: 'work' });
  expect(update(store)).toEqual(first);
  store.updateAccepted({ ...first, probeReceipts: first.probeReceipts.map(row => ({ receivedAt: row.receivedAt, sourceEventId: row.sourceEventId })) });
  expect(update(store).probeReceipts).toEqual([{ sourceEventId: '$probe-0', receivedAt: 2 }, { sourceEventId: '$probe-10', receivedAt: 1 }]);
});

test('outbound generation handover retains ACKed and uncertain-response input without stale lease ACK', () => {
  const file = disk(); let store = open(file);
  store.activateTransport({ generation: 1, fingerprint: 'old-machine' });
  store.receive(delivery('acked-message'), 1); store.acknowledged('acked-message', 'matrix');
  store.receive(delivery('uncertain-ack-response'), 1);
  store.receive(delivery('expired-lease'), 1); store.reclaim('expired-lease', 'matrix');
  store.receive(delivery('completed-message'), 1); store.finish('completed-message', { lane: 'matrix' });
  store.receive(delivery('work-request', 'work', 'request', { requestId: 'work-request' }), 1);
  store.receive(delivery('old-probe', 'work', 'probe', { sourceEventId: '$old' }), 1);
  store.receive(delivery('receipt-probe', 'work', 'probe', { sourceEventId: '$receipt' }), 1);
  store.finish('receipt-probe', { receipt: { sourceEventId: '$receipt', received: true }, lane: 'work' });
  addRequest(store, 'tracked-request');
  const oldUpdate = update(store); expect(oldUpdate.probeReceipts).toHaveLength(1);
  const payloads = store.db.prepare('SELECT lane,id,payload,generation FROM inbox ORDER BY rowid').all();
  store.close(); store = open(file);
  expect(store.activateTransport({ generation: 2, fingerprint: 'new-machine' })).toMatchObject({ changed: true, previousGeneration: 1 });
  expect(store.pendingUpdate()).toBeNull(); expect(store.requestSnapshots()).toEqual([]);
  expect(store.trackedRequests()).toHaveLength(1);
  expect(store.db.prepare('SELECT lane,id,payload,generation FROM inbox ORDER BY rowid').all()).toEqual(payloads);
  for (const id of ['acked-message', 'uncertain-ack-response', 'expired-lease']) {
    expect(store.next('matrix')).toMatchObject({ id, state: 'acked', generation: 1 });
    store.finish(id, { lane: 'matrix' });
  }
  expect(store.next('matrix')).toBeNull();
  expect(store.next('work')).toMatchObject({ id: 'work-request', state: 'acked', generation: 1 });
  store.finish('work-request', { request: { requestId: 'work-request' }, lane: 'work' });
  expect(store.next('work')).toBeNull();
  expect(store.db.prepare('SELECT state,error FROM inbox WHERE id=?').get('old-probe'))
    .toEqual({ state: 'done', error: 'transport_generation_retired' });
  expect(() => store.receive(delivery('stale-source'), 1)).toThrow('generation mismatch');
  expect(() => store.activateTransport({ generation: 1, fingerprint: 'old-machine' })).toThrow('stale');
  expect(() => store.activateTransport({ generation: 2, fingerprint: 'changed-without-generation' })).toThrow('without a new generation');
  const fresh = update(store); expect(fresh).toMatchObject({ sequence: 1, generation: 2, probeReceipts: [] });
  expect(() => store.updateAccepted(oldUpdate)).toThrow('mismatch');
  store.close(); store = open(file);
  expect(store.activateTransport({ generation: 2, fingerprint: 'new-machine' }).changed).toBe(false);
  expect(update(store)).toEqual(fresh);
  expect(store.next('matrix')).toBeNull();
  expect(() => new FleetOutboundStore(file, { ...binding, registration: 'other-appservice' })).toThrow('another registration');
});

test('outbound redelivery retains origin generation and refuses changed content after rotation', () => {
  const store = open(); store.activateTransport({ generation: 1, fingerprint: 'old' });
  const source = delivery('original'); store.receive(source, 1);
  store.activateTransport({ generation: 2, fingerprint: 'new' });
  store.receive({ ...source, token: 'current-lease' }, 2);
  expect(store.next('matrix')).toMatchObject({ state: 'received', generation: 1, token: 'current-lease' });
  store.acknowledged(source.id, 'matrix');
  expect(() => store.receive({ ...source, payload: { transactionId: 'different' } }, 2)).toThrow('content conflict');
  store.finish(source.id, { lane: 'matrix' });
  store.activateTransport({ generation: 3, fingerprint: 'third' });
  expect(store.next('matrix')).toBeNull();
});

test('outbound store upgrades single-key inbox without discarding payload or an uncertain update', () => {
  const file = disk(), old = new Database(file), source = delivery('legacy');
  const pending = { v: 2, generation: 1, sequence: 7, heartbeat: true, probeReceipts: [], statuses: [] };
  old.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE inbox(id TEXT PRIMARY KEY,lane TEXT NOT NULL,kind TEXT NOT NULL,digest TEXT NOT NULL,
      payload TEXT NOT NULL,token TEXT NOT NULL,state TEXT NOT NULL,retry_at INTEGER NOT NULL DEFAULT 0,error TEXT);
    CREATE TABLE outbox(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE requests(id TEXT PRIMARY KEY,payload TEXT NOT NULL,admitted INTEGER NOT NULL DEFAULT 0,
      status TEXT,check_at INTEGER NOT NULL DEFAULT 0);`);
  const oldStatus = { requestId: 'cached', state: 'active', ready: true };
  old.prepare('INSERT INTO requests(id,payload,status) VALUES(?,?,?)')
    .run('cached', JSON.stringify({ requestId: 'cached' }), JSON.stringify(oldStatus));
  for (const [key, value] of [['binding', outboundDigest(binding)], ['sequence', '7'], ['consumer', 'existing-consumer']]) {
    old.prepare('INSERT INTO metadata VALUES(?,?)').run(key, value);
  }
  old.prepare('INSERT INTO inbox(id,lane,kind,digest,payload,token,state) VALUES(?,?,?,?,?,?,?)')
    .run(source.id, source.lane, source.kind, outboundDigest({ lane: source.lane, kind: source.kind, payload: source.payload }),
      JSON.stringify(source.payload), source.token, 'acked');
  old.prepare('INSERT INTO outbox VALUES(1,?)').run(JSON.stringify(pending)); old.close();
  const store = open(file); store.activateTransport({ generation: 1, fingerprint: 'initial-machine' });
  expect(store.next('matrix')).toMatchObject({ id: 'legacy', state: 'acked', generation: 1, payload: source.payload });
  expect(store.pendingUpdate()).toEqual(pending);
  expect(store.meta('consumer')).toBe('existing-consumer');
  expect(store.requestSnapshots()[0]).toMatchObject({ requestId: 'cached', ready: false, observedAt: null,
    fulfillment: { phase: 'verification', incomplete: true } });
  expect(store.trackedRequests()[0]).toMatchObject({ observed_at: 0, status: JSON.stringify(oldStatus) });
  store.receive(delivery('legacy', 'work', 'request', { requestId: 'legacy' }));
  expect(store.next('work')?.id).toBe('legacy');
});
