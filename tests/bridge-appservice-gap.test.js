import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

let collectorOptions;
vi.mock('../lib/appservice-sync.js', async (importOriginal) => ({
  ...await importOriginal(),
  startAppserviceSyncCollector: (options) => { collectorOptions = options; return { stop() {} }; },
}));

const SIDE = 'side.test';
const ROOM = '!gap:side.test';
const acting = {
  side: { serverName: SIDE, apiBaseUrl: 'https://side.test' },
  credential: { kind: 'appservice', asToken: 'as', senderLocalpart: 'hagency' },
};
let MatrixBridge;
let runtimeDir;
let env;
let bridge;
let sends;
let requests;

beforeAll(async () => {
  const keys = ['HAGENCY_RUNTIME_DIR', 'HAGENCY_APPSERVICE_SYNC_SIDE', 'HAGENCY_APPSERVICE_SYNC_URL',
    'HAGENCY_APPSERVICE_PORT', 'HAGENCY_EDGE_LINK_URL', 'HAGENCY_EDGE_LINK_SIDE', 'HAGENCY_EDGE_LINK_TOKEN',
    'MATRIX_JOIN_BACKFILL_PAGES', 'MATRIX_JOIN_BACKFILL_MAX_EVENTS', 'MATRIX_JOIN_BACKFILL_LIMIT'];
  env = snapshotEnv(keys);
  for (const key of keys) delete process.env[key];
  runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hagency-gap-'));
  mkdirSync(path.join(runtimeDir, 'data', 'matrix'), { recursive: true });
  writeFileSync(path.join(runtimeDir, 'data', 'matrix', 'bridge-state.json'), JSON.stringify({
    appserviceSyncReconcile: { [SIDE]: { '!legacy:side.test': 1234 } },
  }));
  Object.assign(process.env, { HAGENCY_RUNTIME_DIR: runtimeDir,
    HAGENCY_APPSERVICE_SYNC_SIDE: SIDE, HAGENCY_APPSERVICE_SYNC_URL: 'https://side.test',
    MATRIX_JOIN_BACKFILL_PAGES: '2', MATRIX_JOIN_BACKFILL_MAX_EVENTS: '4', MATRIX_JOIN_BACKFILL_LIMIT: '2' });
  ({ MatrixBridge } = await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?sync-gap-test`));
});
afterAll(() => { restoreEnv(env); rmSync(runtimeDir, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  bridge = new MatrixBridge();
  bridge.refreshAppserviceSides = async () => {};
  bridge.actingSideFor = () => acting;
  bridge.appserviceSideTokens = new Map([[SIDE, 'hs']]);
  await bridge.startAppserviceIntake();
  collectorOptions.writePendingReconcile(ROOM, 'cleared');
  sends = [];
  requests = [];
  bridge.appserviceRouter = { handle: async (req) => { sends.push(req); return { status: 200 }; } };
});

function history(responseFor) {
  vi.stubGlobal('fetch', async (raw, init) => {
    const url = new URL(raw);
    requests.push({ url, init });
    return responseFor(url, requests.length);
  });
}
function pending(bounds = { kind: 'gap', from: 'before', to: 'after' }) {
  collectorOptions.writePendingReconcile(ROOM, 'pending', bounds);
}
const reconcile = () => collectorOptions.onRoomsNeedingReconcile(SIDE, [ROOM]);
const event = (id) => ({ event_id: id, type: 'm.room.message', sender: '@alex:side.test', content: { body: id } });

test('persisted sync gaps route forward history through the authenticated router', async () => {
  pending();
  pending({ kind: 'gap', from: 'after', to: 'newest' });
  history((_url, n) => Response.json(n === 1
    ? { chunk: [event('$missed'), event('$latest')], end: 'page-2' }
    : { chunk: [], end: null }));
  await reconcile();
  expect(requests.map(({ url }) => [url.searchParams.get('from'), url.searchParams.get('to'), url.searchParams.get('dir')]))
    .toEqual([['before', 'newest', 'f'], ['page-2', 'newest', 'f']]);
  expect(requests[0].url.searchParams.get('user_id')).toBe('@hagency:side.test');
  expect(sends).toHaveLength(1);
  expect(sends[0].headers.authorization).toBe('Bearer hs');
  expect(sends[0].body.mode).toBe('sync');
  expect(sends[0].body.events.map((e) => [e.event_id, e.room_id])).toEqual([['$missed', ROOM], ['$latest', ROOM]]);
});

test('failed or malformed gap reads do not deliver or clear the pending record', async () => {
  pending();
  for (const response of [Response.json({ errcode: 'M_UNAVAILABLE' }, { status: 503 }),
    Response.json({ wrong: [] }), Response.json({ chunk: [null], end: null }),
    Response.json({ chunk: [{ event_id: '$broken' }], end: null })]) {
    history(() => response);
    await expect(reconcile()).rejects.toThrow(/unreadable|malformed/i);
    expect(sends).toEqual([]);
    expect(collectorOptions.readPendingReconcile()).toContain(ROOM);
  }
});

test('missing bounds and stalled gap pages refuse without replaying history', async () => {
  pending();
  history(() => Response.json({ chunk: [event('$unproven')], end: 'before' }));
  await expect(reconcile()).rejects.toThrow(/progress|stalled/i);
  expect(sends).toEqual([]);
  collectorOptions.writePendingReconcile(ROOM, 'cleared');
  pending({ kind: 'gap' });
  await expect(reconcile()).rejects.toThrow(/bound/i);
  expect(sends).toEqual([]);
});

test('rejected gap delivery retries with the same transaction identity', async () => {
  pending();
  history(() => Response.json({ chunk: [event('$missed')], end: null }));
  bridge.appserviceRouter.handle = async (req) => { sends.push(req); return { status: 503 }; };
  await expect(reconcile()).rejects.toThrow(/503/);
  await expect(reconcile()).rejects.toThrow(/503/);
  expect(sends).toHaveLength(2);
  expect(sends[0].path).toBe(sends[1].path);
  expect(collectorOptions.readPendingReconcile()).toContain(ROOM);
});

test('initial history still uses only the invite-to-join policy', async () => {
  pending({ kind: 'join', from: null, to: 'initial' });
  bridge.backfillJoinedRoomOnSide = vi.fn(async () => 0);
  await reconcile();
  expect(bridge.backfillJoinedRoomOnSide).toHaveBeenCalledWith(SIDE, ROOM, '@hagency:side.test');
  expect(sends).toEqual([]);
});

test('exhausted or oversized gap pages retain pending recovery without partial delivery', async () => {
  pending();
  history((_url, n) => Response.json({ chunk: [event(`$${n}`)], end: `page-${n}` }));
  await expect(reconcile()).rejects.toThrow(/budget/);
  expect(requests).toHaveLength(2);
  expect(sends).toEqual([]);
  history(() => Response.json({ chunk: [event('$1'), event('$2'), event('$3')], end: null }));
  await expect(reconcile()).rejects.toThrow(/budget/);
  expect(sends).toEqual([]);
  expect(collectorOptions.readPendingReconcile()).toContain(ROOM);
});

test('later gaps do not overwrite legacy pending recovery with unknown bounds', async () => {
  collectorOptions.writePendingReconcile('!legacy:side.test', 'pending', { kind: 'gap', from: 'new-from', to: 'new-to' });
  history(() => Response.json({ chunk: [], end: null }));
  await expect(collectorOptions.onRoomsNeedingReconcile(SIDE, ['!legacy:side.test'])).rejects.toThrow(/bound/);
  expect(requests).toEqual([]);
  expect(collectorOptions.readPendingReconcile()).toContain('!legacy:side.test');
});

test('gap messages recover without replaying stale membership over current sync state', async () => {
  pending();
  let member = 'join'; // The normal sync already applied the newer join.
  history(() => Response.json({ chunk: [
    { event_id: '$old-leave', type: 'm.room.member', sender: '@worker:side.test',
      state_key: '@worker:side.test', content: { membership: 'leave' } },
    event('$missed-message'),
  ], end: null }));
  bridge.appserviceRouter.handle = async (req) => {
    sends.push(req);
    for (const e of req.body.events) if (e.type === 'm.room.member') member = e.content.membership;
    return { status: 200 };
  };
  await reconcile();
  expect(member).toBe('join');
  expect(sends[0].body.events.map((e) => e.event_id)).toEqual(['$missed-message']);
});
