import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotEnv, restoreEnv } from './helpers/env.js';

let MatrixBridge, runtimeDir, environment;
const fleetId = `hf_${'c'.repeat(32)}`, sideId = 'palpo.test';
const transport = { mode: 'outbound', url: `https://palpo.test/api/fleet/v2/${fleetId}`,
  token: 'private-machine-fixture', generation: 1 };
beforeAll(async () => {
  runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-outbound-'));
  const keys = ['HAGENCY_RUNTIME_DIR', 'MATRIX_BRIDGE_SECRET', 'HAGENCY_APPSERVICE_PORT',
    'HAGENCY_EDGE_URL', 'HAGENCY_EDGE_LINK_TOKEN', 'HAGENCY_EDGE_SIDE', 'HAGENCY_APPSERVICE_SYNC_SIDE', 'HAGENCY_APPSERVICE_SYNC_URL'];
  environment = snapshotEnv(keys); for (const key of keys) delete process.env[key];
  process.env.HAGENCY_RUNTIME_DIR = runtimeDir; process.env.MATRIX_BRIDGE_SECRET = 'fixture-bridge';
  ({ MatrixBridge } = await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?outbound-start`));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(() => { restoreEnv(environment); rmSync(runtimeDir, { recursive: true, force: true }); });

function fixture() {
  const bridge = new MatrixBridge(), started = [], options = [];
  const row = { sideId, serverName: sideId, hsToken: 'hs-fixture', registration: 'registration-1' };
  const acting = { kind: 'appservice', ...row, asToken: 'as-fixture', senderLocalpart: `${fleetId}_representative`, transport };
  bridge.actingCredentials = new Map([[sideId, acting]]);
  bridge.backendApiForSides = async () => ({ sides: [row] });
  bridge.refreshRepresentativeCollectors = () => {};
  bridge.outboundClientFactory = config => {
    const worker = { start: vi.fn(), stop: vi.fn(async () => {}) };
    started.push(worker); options.push(config); return worker;
  };
  return { bridge, row, acting, started, options };
}

test('outbound bridge works without a listener and stops replaced registrations', async () => {
  vi.useFakeTimers(); const f = fixture();
  await f.bridge.startAppserviceIntake();
  expect(f.bridge.appserviceListener).toBeUndefined();
  expect(f.bridge.appserviceRouter.sideIds()).toEqual([sideId]);
  expect(f.started).toHaveLength(1); expect(f.started[0].start).toHaveBeenCalledTimes(1);
  await f.bridge.refreshAppserviceSides(); expect(f.started).toHaveLength(1);
  let release;
  f.started[0].stop.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  f.bridge.actingCredentials.set(sideId, { ...f.acting, transport: { ...transport, generation: 2, token: 'new-machine-private-fixture' } });
  const first = f.bridge.refreshOutboundFleets();
  await Promise.resolve(); await Promise.resolve();
  const second = f.bridge.refreshOutboundFleets();
  expect(f.started[0].stop).toHaveBeenCalledTimes(1); release(); await Promise.all([first, second]);
  expect(f.started).toHaveLength(2); expect(f.options[1].transport.generation).toBe(2);
  expect(f.bridge.outboundFleets.get(sideId).client).toBe(f.started[1]);
  f.bridge.actingCredentials.clear(); await f.bridge.refreshOutboundFleets();
  expect(f.started[1].stop).toHaveBeenCalledTimes(1); expect(f.bridge.outboundFleets.size).toBe(0);
  clearInterval(f.bridge.appserviceRefreshTimer);
});

test('outbound bridge accepts only collector provenance and never upgrades an old generation probe', async () => {
  vi.useFakeTimers(); const f = fixture();
  const accepted = []; f.bridge.handleAppserviceEvents = async (_side, events, meta) => { accepted.push({ events, meta }); };
  await f.bridge.startAppserviceIntake();
  const event = { type: 'm.room.message', event_id: '$chat', room_id: '!room:palpo.test', sender: '@human:palpo.test', content: { body: 'hello' } };
  const probe = { ...event, type: 'com.hagency.connection.probe.v1' };
  const body = { events: [event, probe] };
  const push = await f.bridge.appserviceRouter.handle({ method: 'PUT', path: '/_matrix/app/v1/transactions/push',
    headers: { authorization: 'Bearer hs-fixture' }, body, transport: { mode: 'push', sideId } });
  expect(push.status).toBe(500); expect(accepted).toHaveLength(0);
  expect((await f.options[0].transaction({ transactionId: 'old-generation', body }, { generation: 0 })).status).toBe(200);
  expect(accepted[0].events).toEqual([event]); expect(accepted[0].meta.provenance.mode).toBe('edge');
  expect((await f.options[0].transaction({ transactionId: 'current-generation', body }, { generation: 1 })).status).toBe(200);
  expect(accepted[1].events).toEqual(body.events);
  clearInterval(f.bridge.appserviceRefreshTimer);
});
