import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FleetOutboundStore } from '../lib/fleet-outbound-store.js';
import { FleetOutboundClient } from '../lib/fleet-outbound-client.js';
import { ProjectSideStore } from '../lib/project-side-store.js';
import { parseFleetCredentialImport, fleetImportSummary } from '../mockup/lib/fleet-credential-import.js';

const fleetId = `hf_${'a'.repeat(32)}`;
const transport = { mode: 'outbound', url: `https://palpo.test/api/fleet/v2/${fleetId}`,
  token: 'machine-fixture-private', generation: 1 };
const binding = { fleetId, generation: 1 };
const delivery = (id = 'tx1', lane = 'matrix', kind = 'transaction', payload = { transactionId: id, body: { events: [] } }) =>
  ({ id, lane, kind, payload, token: `lease-${id}` });
const roots = [], stores = [];
const open = (file = ':memory:') => { const store = new FleetOutboundStore(file, binding); stores.push(store); return store; };
const fixtureFile = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-outbound-')); roots.push(dir); return path.join(dir, 'inbox.sqlite'); };
const response = (body = {}, status = 200) => new Response(JSON.stringify(body), { status });
const client = (store, options = {}) => new FleetOutboundClient({ fleetId, transport, store,
  transaction: async () => ({ status: 200 }), protocol: async () => ({ status: 200, body: { v: 1, fleetId } }), ...options });
afterEach(() => { for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('outbound import keeps machine credentials private and rejects another fleet', () => {
  const registration = { id: fleetId, url: `http://palpo-relay:8090/api/relay/v2/${fleetId}`,
    as_token: 'fixture-as-private', hs_token: 'fixture-hs-private', sender_localpart: `${fleetId}_representative`,
    namespaces: { users: [{ exclusive: true, regex: `^@${fleetId}_[a-z0-9_]+:palpo\\.test$` }], rooms: [], aliases: [] } };
  const envelope = { fleetId, serverName: 'palpo.test', credentialVersion: 1, registration, transport };
  const imported = parseFleetCredentialImport(JSON.stringify(envelope), { serverName: 'palpo.test' });
  expect(imported.credential.transport).toEqual(transport);
  const sideStore = new ProjectSideStore(fixtureFile() + '.json');
  sideStore.upsertSide({ serverName: 'palpo.test', apiBaseUrl: 'https://palpo.test' });
  sideStore.setCredential('palpo.test', imported.credential);
  expect(sideStore.credentialFor('palpo.test').transport).toEqual(transport);
  expect(sideStore.getSide('palpo.test')).toMatchObject({ connectionMode: 'outbound', outboundEndpoint: transport.url });
  const publicText = JSON.stringify([sideStore.listSides(), sideStore.listAudit(), fleetImportSummary(imported)]);
  for (const secret of [transport.token, registration.as_token, registration.hs_token]) expect(publicText).not.toContain(secret);
  for (const mutation of [{ url: transport.url.replace(fleetId, `hf_${'b'.repeat(32)}`) },
    { generation: 0 }, { token: registration.as_token }, { url: `http://public.test/api/fleet/v2/${fleetId}` },
    { url: transport.url + '?token=secret' }, { url: transport.url.replace('https://', 'https://user:secret@') }]) {
    const bad = { ...envelope, transport: { ...transport, ...mutation } };
    expect(() => parseFleetCredentialImport(JSON.stringify(bad), { serverName: 'palpo.test' })).toThrow('cr.importInvalid');
    expect(() => sideStore.setCredential('palpo.test', { ...imported.credential, transport: bad.transport })).toThrow();
  }
});

test('outbound inbox commits before acknowledgement and resumes after restart', async () => {
  const file = fixtureFile(), first = open(file), dispatch = vi.fn(async () => ({ status: 200 }));
  const fetchImpl = vi.fn(async (url, options) => {
    expect(options.headers.Authorization).toBe(`Bearer ${transport.token}`);
    expect(options.headers['X-HAFleet-Generation']).toBe('1');
    if (url.includes('/poll?')) return response({ v: 2, generation: 1, delivery: delivery() });
    // Inspect a separate DB connection before ACK succeeds: durability is the contract.
    const inspection = new FleetOutboundStore(file, binding);
    expect(inspection.next('matrix')).toMatchObject({ id: 'tx1', state: 'received' }); inspection.close();
    throw new Error('response lost');
  });
  await expect(client(first, { fetchImpl, transaction: dispatch }).receiveOnce('matrix', 0)).rejects.toThrow('response lost');
  expect(dispatch).not.toHaveBeenCalled();
  const consumer = first.meta('consumer'); first.close();
  const restarted = open(file); expect(restarted.meta('consumer')).toBe(consumer);
  const resumed = client(restarted, { fetchImpl: async () => response(), transaction: dispatch });
  expect(await resumed.processOnce('matrix')).toBe(true);
  expect(dispatch).toHaveBeenCalledTimes(1); expect(restarted.next('matrix')).toBeNull();
});

test('outbound update outbox retries identical sequence after lost response', async () => {
  const file = fixtureFile(), first = open(file), sent = [];
  first.receive(delivery('probe1', 'work', 'probe', { sourceEventId: '$probe' }));
  first.finish('probe1', { receipt: { sourceEventId: '$probe', received: true } });
  const original = client(first, { fetchImpl: async (_url, options) => { sent.push(options.body); throw new Error('lost'); } });
  await expect(original.publishOnce()).rejects.toThrow('lost'); first.close();
  const restarted = open(file), protocol = vi.fn(async () => ({ status: 200, body: { changed: true } }));
  const resumed = client(restarted, { protocol, fetchImpl: async (_url, options) => { sent.push(options.body); return response(); } });
  await resumed.publishOnce(); expect(sent[0]).toBe(sent[1]); expect(protocol).not.toHaveBeenCalled();
  expect(JSON.parse(sent[1])).toMatchObject({ sequence: 1, probeReceipts: [{ sourceEventId: '$probe' }] });
  await resumed.publishOnce(); expect(JSON.parse(sent[2])).toMatchObject({ sequence: 2, probeReceipts: [], capabilities: { changed: true } });
});

test('outbound lease recovery never executes a conflicting delivery', async () => {
  const store = open(), dispatch = vi.fn(async () => ({ status: 200 }));
  store.receive(delivery());
  const worker = client(store, { transaction: dispatch,
    fetchImpl: async () => response({ code: 'stale_lease' }, 409) });
  await expect(worker.processOnce('matrix')).rejects.toMatchObject({ code: 'stale_lease' });
  expect(store.next('matrix')).toBeNull(); expect(dispatch).not.toHaveBeenCalled();
  expect(() => store.receive({ ...delivery(), payload: { transactionId: 'changed', body: { events: [] } } })).toThrow('content conflict');
  store.receive({ ...delivery(), token: 'new-lease' });
  worker.fetch = async () => response(); await worker.processOnce('matrix');
  expect(dispatch).toHaveBeenCalledTimes(1);
  // A repeated completed delivery still needs ACK but must not repeat its effect.
  worker.fetch = async url => url.includes('/poll?') ? response({ v: 2, generation: 1, delivery: delivery() }) : response();
  await worker.receiveOnce('matrix', 0); expect(await worker.processOnce('matrix')).toBe(false);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test('outbound Matrix retries preserve order while probe work remains independent', async () => {
  const store = open(); store.receive(delivery('first')); store.acknowledged('first');
  store.receive(delivery('second')); store.acknowledged('second'); store.retry('first', 'temporary');
  expect(store.next('matrix')).toBeNull();
  store.receive(delivery('probe', 'work', 'probe', { sourceEventId: '$probe' })); store.acknowledged('probe');
  const worker = client(store, { protocol: async () => ({ status: 200, body: { sourceEventId: '$probe', received: true } }) });
  expect(await worker.processOnce('work')).toBe(true); expect(store.next('matrix')).toBeNull();
  expect(store.next('matrix', Date.now() + 6000).id).toBe('first');
});

test('outbound verification failure removes previously usable status', async () => {
  const store = open(), payload = { v: 1, fleetId, requestId: 'request1', role: 'coding' };
  store.receive(delivery('request1', 'work', 'request', payload)); store.finish('request1', { request: payload });
  store.admitted('request1'); store.observeRequest('request1', { ...payload, state: 'active', bound: true, ready: true });
  const worker = client(store, { protocol: async () => ({ status: 503, body: { code: 'unavailable' } }) });
  await worker.reconcileRequestsOnce();
  expect(store.requestSnapshots()).toEqual([{ ...payload, state: 'active', bound: true, ready: false, observedAt: expect.any(String),
    fulfillment: { phase: 'verification', incomplete: true, error: expect.any(String) } }]);
});

test('outbound stop cancels in-flight polling and shares completion across callers', async () => {
  const store = open(), aborted = [];
  const worker = client(store, { fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted.push(true); reject(signal.reason); }, { once: true });
  }) });
  worker.start(); await Promise.resolve(); await Promise.resolve();
  const a = worker.stop(), b = worker.stop(); expect(a).toBe(b); await a;
  expect(aborted.length).toBeGreaterThanOrEqual(2); expect(store.db.open).toBe(false);
});
