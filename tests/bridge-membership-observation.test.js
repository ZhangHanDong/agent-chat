import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

const ROOM = '!observed:side.test';
const GROUP = 'observed-membership';
const AGENT = '@ac_worker:side.test';
const SECRET = 'membership-observation-test-secret';
let context;
let backend;
let matrixServer;
let matrixBase;
let bridge;
let currentMembers;
let matrixCalls;
let membershipReadable;
let pendingSse;
let notifications;
let sseClient;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  currentMembers = new Set(['@hafleet:side.test', AGENT]);
  matrixCalls = [];
  membershipReadable = true;
  pendingSse = [];
  notifications = [];
  matrixServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://fixture');
    const pathname = decodeURIComponent(url.pathname);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    matrixCalls.push({ method: req.method, path: pathname, body, actor: url.searchParams.get('user_id') });
    let status = 200;
    let result = {};
    if (pathname.endsWith('/joined_members')) {
      if (membershipReadable) result = { joined: Object.fromEntries([...currentMembers].map((mxid) => [mxid, {}])) };
      else { status = 403; result = { errcode: 'M_FORBIDDEN' }; }
    } else if (pathname.endsWith('/kick')) {
      currentMembers.delete(body.user_id);
    } else if (pathname.includes('/join/')) {
      currentMembers.add(url.searchParams.get('user_id'));
    } else if (!pathname.endsWith('/invite')) {
      status = 404;
      result = { errcode: 'M_NOT_FOUND' };
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve) => matrixServer.listen(0, '127.0.0.1', resolve));
  matrixBase = `http://127.0.0.1:${matrixServer.address().port}`;
  context = await createBackendTestContext('hafleet-membership-observation-', {
    agents: { worker: { name: 'worker', kind: 'agent', type: 'claude' } },
    groups: { [GROUP]: { name: GROUP, members: ['worker'], createdAt: 1 } },
    env: {
      MATRIX_BRIDGE_SECRET: SECRET,
      MATRIX_TRUST_MODE: 'audit',
      MATRIX_AGENT_PREFIX: 'ac_',
      MATRIX_HOMESERVER: `${matrixBase}/home`,
      MATRIX_SERVER_NAME: 'home.test',
      HAFLEET_API: 'http://127.0.0.1:1',
    },
  });
  backend = await context.listen();
  process.env.HAFLEET_API = backend.baseUrl;
  const bridgeUrl = new URL('../bridge-matrix.js', import.meta.url).href;
  const module = await import(`${bridgeUrl}?membership-observation=${Date.now()}-${Math.random()}`);
  const state = module.bridgeStateForTest();
  state.groupRoomMap = { [`${GROUP}@side.test`]: ROOM };
  state.roomGroupMap = { [ROOM]: `${GROUP}@side.test` };
  state.agentTokens = {};
  bridge = Object.assign(Object.create(module.MatrixBridge.prototype), {
    startupTs: 0,
    botClient: null,
    botUserId: null,
    recentlyCreatedRooms: new Set(),
    knownAgents: new Set(['worker']),
    knownAgentIndex: new Map([['worker', 'worker']]),
    actingCredentials: new Map([['side.test', {
      kind: 'appservice', serverName: 'side.test', apiBaseUrl: matrixBase,
      asToken: 'fixture-as-token', senderLocalpart: 'hafleet', namespace: '@ac_.*:side\\.test',
    }]]),
    postWarning: vi.fn(),
  });
  sseClient = {
    write(frame) {
      if (frame.startsWith('event: group_members\n')) {
        const event = JSON.parse(frame.match(/^data: (.*)$/m)[1]);
        notifications.push(event);
        pendingSse.push(event);
      }
      return true;
    },
  };
  context.internals.sseAdapterForTest.clients.add(sseClient);
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (url, init) => {
    if (![matrixBase, backend.baseUrl].includes(new URL(url).origin)) throw new Error(`Non-fixture HTTP forbidden: ${url}`);
    return realFetch(url, init);
  });
});

afterEach(async () => {
  context?.internals.sseAdapterForTest.clients.delete(sseClient);
  await backend?.close();
  if (matrixServer) await new Promise((resolve) => matrixServer.close(resolve));
  context?.cleanup();
  context = backend = matrixServer = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const matrixWrites = () => matrixCalls.filter((call) => call.method === 'POST');
const event = (membership) => ({
  type: 'm.room.member', event_id: `$${membership}`, state_key: AGENT,
  sender: membership === 'join' ? AGENT : '@hafleet:side.test',
  content: { membership }, origin_server_ts: 1000,
});
async function command(body) {
  const response = await request(context.app).post(`/api/groups/${GROUP}/members`)
    .set('X-Bridge-Secret', SECRET).send(body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}
async function drainSse() {
  while (pendingSse.length) await bridge.onGroupMembersChanged(pendingSse.shift());
}
async function roster() {
  const response = await request(context.app).get(`/api/groups/${GROUP}`);
  expect(response.status).toBe(200);
  return response.body.members;
}

describe('Matrix membership observations', () => {
  test('delayed leave and join observations preserve a restored member without reflected Matrix writes', async () => {
    await command({ remove: ['worker'] });
    await drainSse();
    expect(currentMembers.has(AGENT)).toBe(false);
    await command({ add: ['worker'] });
    await drainSse();
    expect(currentMembers.has(AGENT)).toBe(true);
    expect(matrixWrites()).toHaveLength(3); // The requested kick, invitation, and join.
    notifications.length = 0;

    // Deliver both observations only after the restore has reached Matrix,
    // then feed every real backend SSE frame back through the bridge.
    await bridge.onRoomEvent(ROOM, event('leave'));
    await drainSse();
    await bridge.onRoomEvent(ROOM, event('join'));
    await drainSse();

    expect(await roster()).toEqual(['worker']);
    expect(currentMembers.has(AGENT)).toBe(true);
    expect(matrixWrites()).toHaveLength(3);
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.every((notification) => notification.source === 'matrix')).toBe(true);
  });

  test.each(['leave', 'join'])('a current %s observation updates the roster without another Matrix operation', async (membership) => {
    if (membership === 'leave') currentMembers.delete(AGENT);
    else {
      await command({ remove: ['worker'] });
      pendingSse.length = notifications.length = 0; // The external join is the fact being observed.
    }
    await bridge.onRoomEvent(ROOM, event(membership));
    await drainSse();
    expect(await roster()).toEqual(membership === 'join' ? ['worker'] : []);
    expect(matrixWrites()).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].source).toBe('matrix');
  });

  test('a delayed join reconciles current absence without restoring the member', async () => {
    await command({ remove: ['worker'] });
    await drainSse();
    matrixCalls.length = notifications.length = 0;
    await bridge.onRoomEvent(ROOM, event('join'));
    await drainSse();
    expect(await roster()).toEqual([]);
    expect(currentMembers.has(AGENT)).toBe(false);
    expect(matrixWrites()).toEqual([]);
  });

  test('unreadable current membership rejects the observation without mutations', async () => {
    membershipReadable = false;
    await expect(bridge.onRoomEvent(ROOM, event('leave')))
      .rejects.toMatchObject({ code: 'membership_unknown', retryable: true });
    expect(await roster()).toEqual(['worker']);
    expect(notifications).toEqual([]);
    expect(matrixWrites()).toEqual([]);
  });

  test('room reconciliation preserves Matrix observation provenance', async () => {
    await command({ remove: ['worker'] });
    pendingSse.length = notifications.length = 0;
    bridge._backendHealthy = true;
    bridge._recordMembershipDetail = vi.fn();
    await bridge.reconcileRoomGroupMembership(ROOM, GROUP);
    await drainSse();
    expect(await roster()).toContain('worker');
    expect(notifications).toHaveLength(1);
    expect(notifications[0].source).toBe('matrix');
    expect(matrixWrites()).toEqual([]);
  });

  test('Matrix membership observations require configured bridge authentication', async () => {
    const invalid = await request(context.app).post(`/api/groups/${GROUP}/members`)
      .set('X-Bridge-Secret', 'wrong').send({ source: 'matrix', remove: ['worker'] });
    expect(invalid.status).toBe(403);
    delete process.env.MATRIX_BRIDGE_SECRET;
    const missing = await request(context.app).post(`/api/groups/${GROUP}/members`)
      .send({ source: 'matrix', remove: ['worker'] });
    expect(missing.status).toBe(503);
    expect(await roster()).toEqual(['worker']);
    expect(notifications).toEqual([]);
  });
});
