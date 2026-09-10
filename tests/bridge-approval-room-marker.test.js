import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import { MatrixClient } from 'matrix-bot-sdk';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';
import { markerOwnedJsonRequest } from '../lib/approval-marker-bridge.js';

const previousEnv = {
  MATRIX_SERVER_NAME: process.env.MATRIX_SERVER_NAME,
  MATRIX_BOT_USERNAME: process.env.MATRIX_BOT_USERNAME,
};
process.env.MATRIX_SERVER_NAME = 'test';
process.env.MATRIX_BOT_USERNAME = 'bot';

let api;
let bridgeModule;
let context;
const secret = 'marker-adapter-secret';

function apiRequest(method, route, body) {
  const requestMethod = method.toLowerCase();
  const pending = request(context.app)[requestMethod](route).set('X-Bridge-Secret', secret);
  return (body ? pending.send(body) : pending).then((response) => {
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(response.body?.error || `backend HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.body;
  });
}

function installLocalActor(bridge, doRequest, generation = 'bot-g1') {
  const client = {
    doRequest,
    crypto: {},
    homeserverUrl: 'https://local.test',
    accessToken: 'test-local-token',
  };
  const state = bridgeModule.bridgeStateForTest();
  state.botCredentialGeneration = generation;
  bridge.botClient = client;
  bridge.botUserId = '@bot:test';
  bridge.approvalBotPublisherReady = {
    client,
    mxid: '@bot:test',
    credentialGeneration: generation,
  };
  return client;
}

beforeAll(async () => {
  bridgeModule = await import('../bridge-matrix.js');
  context = await createBackendTestContext('hafleet-marker-adapter-', {
    agents: {
      oldprobe: { name: 'oldprobe', kind: 'agent' },
      claude: { name: 'claude', kind: 'agent' },
      codex: { name: 'codex', kind: 'agent' },
    },
    env: {
      MATRIX_BRIDGE_SECRET: secret,
      MATRIX_SERVER_NAME: 'test',
      MATRIX_BOT_USERNAME: 'bot',
    },
  });
  api = (method, route, body) => apiRequest(method, route, body);
});

afterAll(() => {
  context?.cleanup();
  if (previousEnv.MATRIX_SERVER_NAME === undefined) delete process.env.MATRIX_SERVER_NAME;
  else process.env.MATRIX_SERVER_NAME = previousEnv.MATRIX_SERVER_NAME;
  if (previousEnv.MATRIX_BOT_USERNAME === undefined) delete process.env.MATRIX_BOT_USERNAME;
  else process.env.MATRIX_BOT_USERNAME = previousEnv.MATRIX_BOT_USERNAME;
});

async function seedFourBindings() {
  const common = {
    owner_mxid: '@owner:test',
    owner_dm_room_id: '!approval:test',
  };
  for (const binding of [
    { agent: 'oldprobe', project: 'p1', project_room_id: '!p1:test', agent_joined: null },
    { agent: 'claude', project: 'p1', project_room_id: '!p1:test', agent_joined: null },
    { agent: 'claude', project: 'p2', project_room_id: '!p2:test', agent_joined: null },
    { agent: 'codex', project: 'p2', project_room_id: '!p2:test', agent_joined: true },
  ]) {
    await api('PUT', '/api/approval-bindings', { ...common, ...binding });
  }
}

function concreteBridge(doRequest) {
  const bridge = Object.create(bridgeModule.MatrixBridge.prototype);
  bridge.callBackendApi = api;
  bridge.approvalMarkerMatrixTimeoutMs = 50;
  bridge.actingSideFor = () => null;
  bridge.approvalMarkerFetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const content = init.body ? JSON.parse(init.body) : null;
    const result = await doRequest(init.method, parsed.pathname, null, content, 50);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  installLocalActor(bridge, doRequest);
  return bridge;
}

async function dueMarkers() {
  return (await api('GET', '/api/approval-bindings/matrix/markers?limit=100')).markers;
}

describe('approval room marker production adapter', () => {
  test('concrete bridge sync and publish preserve the four-binding canonical manifest', async () => {
    await seedFourBindings();
    const calls = [];
    const bridge = concreteBridge(vi.fn(async (...args) => {
      calls.push(args);
      return { event_id: '$v2-state' };
    }));
    await bridge.syncApprovalRoomMarker({
      agent: 'claude',
      owner_mxid: '@owner:test',
      approval_room_id: '!approval:test',
    });
    const row = (await dueMarkers()).find((item) => item.marker_channel === 'room_marker_v2');
    expect(row.marker.project_room_associations).toEqual([
      { agent: 'claude', project_room_id: '!p1:test', active: true },
      { agent: 'claude', project_room_id: '!p2:test', active: true },
      { agent: 'codex', project_room_id: '!p2:test', active: true },
      { agent: 'oldprobe', project_room_id: '!p1:test', active: true },
    ]);

    await expect(bridge.publishApprovalMarker(row))
      .resolves.toEqual({ ok: true, event_id: '$v2-state' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'PUT',
      '/_matrix/client/v3/rooms/!approval%3Atest/state/com.agentchat.approval.room.v2/',
      null,
      row.marker,
      50,
    ]);
    expect((await dueMarkers()).some((item) => (
      item.marker_channel === 'room_marker_v1_retirement'
    ))).toBe(true);
  });

  test('v2 receipt precedes distinct v1 retirement and v2 failure blocks retirement', async () => {
    await api('PUT', '/api/approval-bindings', {
      agent: 'claude', project: 'failure', project_room_id: '!failure:test',
      owner_mxid: '@owner:test', owner_dm_room_id: '!failure-dm:test',
    });
    const failing = concreteBridge(vi.fn().mockRejectedValue(new Error('response lost')));
    await failing.syncApprovalRoomMarker({
      agent: 'claude', owner_mxid: '@owner:test', approval_room_id: '!failure-dm:test',
    });
    const v2 = (await dueMarkers()).find((item) => (
      item.approval_room_id === '!failure-dm:test' && item.marker_channel === 'room_marker_v2'
    ));
    const stableApi = failing.callBackendApi;
    failing.callBackendApi = (method, route, body, contextLabel) => {
      if (route.endsWith('/retry')) throw new Error('retry response lost');
      return stableApi(method, route, body, contextLabel);
    };
    await expect(failing.publishApprovalMarker(v2))
      .resolves.toMatchObject({
        ok: false,
        uncertain: true,
        retry_error: expect.objectContaining({ message: 'retry response lost' }),
      });
    expect((await dueMarkers()).some((item) => (
      item.approval_room_id === '!failure-dm:test'
      && item.marker_channel === 'room_marker_v1_retirement'
    ))).toBe(false);

    const sent = [];
    const restarted = concreteBridge(vi.fn(async (method, endpoint, query, content) => {
      sent.push({ method, endpoint, query, content });
      return { event_id: sent.length === 1 ? '$v2-replay' : '$v1-retirement' };
    }));
    const uncertain = (await dueMarkers()).find((item) => (
      item.approval_room_id === '!failure-dm:test' && item.marker_channel === 'room_marker_v2'
    ));
    await restarted.publishApprovalMarker(uncertain);
    const retirement = (await dueMarkers()).find((item) => (
      item.approval_room_id === '!failure-dm:test'
      && item.marker_channel === 'room_marker_v1_retirement'
    ));
    await restarted.publishApprovalMarker(retirement);
    expect(sent).toHaveLength(2);
    expect(sent[0].endpoint).toContain('/state/com.agentchat.approval.room.v2/');
    expect(sent[0].content).toEqual(uncertain.plan.prepared_payload);
    expect(sent[1].endpoint).toContain('/state/com.agentchat.approval.room.v1/');
    expect(sent[1].content).toEqual({});
  });

  test('uncertain marker retry reuses the stored plan and rejects rotated or rebound context', async () => {
    await api('PUT', '/api/approval-bindings', {
      agent: 'claude', project: 'rotation', project_room_id: '!rotation:test',
      owner_mxid: '@owner:test', owner_dm_room_id: '!rotation-dm:test',
    });
    const sends = vi.fn().mockResolvedValue({ event_id: '$must-not-send' });
    const bridge = concreteBridge(sends);
    await bridge.syncApprovalRoomMarker({
      agent: 'claude', owner_mxid: '@owner:test', approval_room_id: '!rotation-dm:test',
    });
    const row = (await dueMarkers()).find((item) => (
      item.approval_room_id === '!rotation-dm:test' && item.marker_channel === 'room_marker_v2'
    ));
    const originalApi = bridge.callBackendApi;
    bridge.callBackendApi = async (method, route, body, contextLabel) => {
      const result = await originalApi(method, route, body, contextLabel);
      if (route.endsWith('/prepare')) installLocalActor(bridge, sends, 'bot-g2');
      return result;
    };

    await expect(bridge.publishApprovalMarker(row))
      .rejects.toThrow(/changed after durable preparation/);
    expect(sends).not.toHaveBeenCalled();
  });

  test('concrete marker seam distinguishes local appservice and representative state routes', async () => {
    const captures = [];
    const side = {
      serverName: 'remote.test',
      apiBaseUrl: 'https://remote.test',
      representative: { mxid: '@representative:remote.test' },
    };
    let credential = {
      kind: 'appservice',
      asToken: 'test-as-token',
      senderLocalpart: 'representative',
      outboundGeneration: 'side-g1',
    };
    const bridge = Object.create(bridgeModule.MatrixBridge.prototype);
    bridge.approvalMarkerMatrixTimeoutMs = 50;
    bridge.approvalMarkerFetchImpl = vi.fn(async (url, init) => {
      captures.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ event_id: `$side-${captures.length}` }) };
    });
    bridge.actingSideFor = () => ({ side, credential });
    const io = bridgeModule.approvalMarkerIoForTest(bridge);
    const row = { approval_room_id: '!approval:remote.test' };
    let actor = await io.resolveActor(row);
    await expect(io.send({
      prepared_event_type: 'com.agentchat.approval.room.v2',
      state_key: '',
      prepared_payload: { version: 2 },
      publisher_mxid: '@representative:remote.test',
    }, actor, row)).resolves.toBe('$side-1');
    expect(new URL(captures[0].url).searchParams.get('user_id'))
      .toBe('@representative:remote.test');
    expect(captures[0].init.headers.Authorization).toBe('Bearer test-as-token');

    credential = {
      kind: 'registrationToken',
      representativeToken: 'test-representative-token',
      representativeMxid: '@representative:remote.test',
      outboundGeneration: 'side-g2',
    };
    actor = await io.resolveActor(row);
    await expect(io.send({
      prepared_event_type: 'com.agentchat.approval.room.v1',
      state_key: '',
      prepared_payload: {},
      publisher_mxid: '@representative:remote.test',
    }, actor, row)).resolves.toBe('$side-2');
    expect(new URL(captures[1].url).searchParams.has('user_id')).toBe(false);
    expect(captures[1].init.headers.Authorization).toBe('Bearer test-representative-token');

    const unavailableLocal = Object.create(bridgeModule.MatrixBridge.prototype);
    unavailableLocal.botClient = null;
    unavailableLocal.botUserId = null;
    unavailableLocal.approvalBotPublisherReady = null;
    unavailableLocal.actingSideFor = () => ({
      side: { ...side, serverName: 'test' },
      credential,
    });
    await expect(bridgeModule.approvalMarkerIoForTest(unavailableLocal).resolveActor({
      approval_room_id: '!configured-local:test',
    })).resolves.toBeNull();
  });

  test('side marker deadline covers response body and rechecks current actor', async () => {
    const side = {
      serverName: 'slow.test',
      apiBaseUrl: 'https://slow.test',
      representative: { mxid: '@representative:slow.test' },
    };
    let credential = {
      kind: 'registrationToken',
      representativeToken: 'test-token',
      representativeMxid: '@representative:slow.test',
      outboundGeneration: 'slow-g1',
    };
    const bridge = Object.create(bridgeModule.MatrixBridge.prototype);
    bridge.approvalMarkerMatrixTimeoutMs = 5;
    bridge.actingSideFor = () => ({ side, credential });
    bridge.approvalMarkerFetchImpl = vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted body')));
      }),
    }));
    const io = bridgeModule.approvalMarkerIoForTest(bridge);
    const row = { approval_room_id: '!approval:slow.test' };
    const actor = await io.resolveActor(row);
    await expect(io.send({
      prepared_event_type: 'com.agentchat.approval.room.v2',
      state_key: '',
      prepared_payload: { version: 2 },
      publisher_mxid: '@representative:slow.test',
    }, actor, row)).rejects.toThrow(/state send failed|aborted|event_id/);

    bridge.approvalMarkerMatrixTimeoutMs = 50;
    bridge.approvalMarkerFetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        credential = { ...credential, outboundGeneration: 'slow-g2' };
        return { event_id: '$stale-side-response' };
      },
    }));
    await expect(io.send({
      prepared_event_type: 'com.agentchat.approval.room.v2',
      state_key: '',
      prepared_payload: { version: 2 },
      publisher_mxid: '@representative:slow.test',
    }, actor, row)).rejects.toThrow(/state send failed|changed during side response|event_id/);
  });

  test('local marker HTTP owns success stalled and continuous trickle deadlines', async () => {
    const requests = [];
    let responseMode = 'success';
    const server = createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => requests.push({
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks).toString('utf8'),
        authorized: req.headers.authorization === 'Bearer test-local-token',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (responseMode === 'success') {
        res.end('{"event_id":"$prompt"}');
        return;
      }
      if (responseMode === 'stalled') {
        res.write('{"event_id":"$late"}');
      }
      const interval = responseMode === 'trickle'
        ? setInterval(() => res.write(' '), 10)
        : null;
      const finish = setTimeout(() => res.end('{"event_id":"$late"}'), 350);
      res.on('close', () => {
        if (interval) clearInterval(interval);
        clearTimeout(finish);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const client = new MatrixClient(`http://127.0.0.1:${address.port}`, 'test-local-token');
    client.crypto = {};
    client.doRequest = vi.fn(() => {
      throw new Error('marker state must not use the SDK inactivity timeout');
    });
    const bridge = Object.create(bridgeModule.MatrixBridge.prototype);
    bridge.callBackendApi = api;
    bridge.approvalMarkerMatrixTimeoutMs = 50;
    bridge.actingSideFor = () => null;
    const state = bridgeModule.bridgeStateForTest();
    state.botCredentialGeneration = 'bot-g1';
    bridge.botClient = client;
    bridge.botUserId = '@bot:test';
    bridge.approvalBotPublisherReady = {
      client,
      mxid: '@bot:test',
      credentialGeneration: 'bot-g1',
    };
    const row = {
      approval_room_id: '!bounded:test',
      publisher_scope: 'local_bot',
      publisher_mxid: '@bot:test',
      credential_kind: 'local_bot',
      credential_generation: 'bot-g1',
    };
    const actor = await bridgeModule.approvalMarkerIoForTest(bridge).resolveActor(row);
    const started = Date.now();
    try {
      await expect(bridgeModule.approvalMarkerIoForTest(bridge).send({
        prepared_event_type: 'com.agentchat.approval.room.v2',
        state_key: '',
        prepared_payload: { version: 2 },
        publisher_mxid: '@bot:test',
      }, actor, row)).resolves.toBe('$prompt');
      expect(client.doRequest).not.toHaveBeenCalled();

      responseMode = 'stalled';
      await expect(bridgeModule.approvalMarkerIoForTest(bridge).send({
        prepared_event_type: 'com.agentchat.approval.room.v2',
        state_key: '',
        prepared_payload: { version: 2 },
        publisher_mxid: '@bot:test',
      }, actor, row)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(200);

      responseMode = 'trickle';
      const trickleStarted = Date.now();
      await expect(bridgeModule.approvalMarkerIoForTest(bridge).send({
        prepared_event_type: 'com.agentchat.approval.room.v2',
        state_key: '',
        prepared_payload: { version: 2 },
        publisher_mxid: '@bot:test',
      }, actor, row)).rejects.toThrow(/deadline/);
      expect(Date.now() - trickleStarted).toBeLessThan(200);
      expect(requests).toContainEqual({
        method: 'PUT',
        url: '/_matrix/client/v3/rooms/!bounded%3Atest/state/com.agentchat.approval.room.v2/',
        body: '{"version":2}',
        authorized: true,
      });
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('local marker HTTP bounds a rate-limit body before observation', async () => {
    const observed = vi.fn();
    await expect(markerOwnedJsonRequest('https://local.test/state', {
      fetchImpl: async () => new Response('x'.repeat(65 * 1024), { status: 429 }),
      observeResponse: observed,
    }, 500)).rejects.toThrow(/too large/);
    expect(observed).not.toHaveBeenCalled();
  });

  test('authenticated nonempty v1 observation queues exact room reconciliation', async () => {
    const calls = [];
    const bridge = concreteBridge(vi.fn(async (method, endpoint, query, content, timeout) => {
      calls.push({ method, endpoint, query, content, timeout });
      if (method === 'GET') return {
        version: 1,
        binding_generation: 1,
        publisher_mxid: '@retired-bot:test',
        owner_mxid: '@owner:test',
        agent: 'claude',
        project_room_associations: [{ project_room_id: '!p1:test', active: true }],
      };
      return { event_id: `$marker-observation-${calls.length}` };
    }));
    await api('PUT', '/api/approval-bindings', {
      agent: 'claude',
      project: 'observed',
      project_room_id: '!observed-project:test',
      owner_mxid: '@owner:test',
      owner_dm_room_id: '!observed:test',
    });
    await bridge.syncApprovalRoomMarker({
      agent: 'claude',
      owner_mxid: '@owner:test',
      approval_room_id: '!observed:test',
    });
    const v2 = (await dueMarkers()).find((item) => (
      item.approval_room_id === '!observed:test'
      && item.marker_channel === 'room_marker_v2'
    ));
    await bridge.publishApprovalMarker(v2);
    const retirement = (await dueMarkers()).find((item) => (
      item.approval_room_id === '!observed:test'
      && item.marker_channel === 'room_marker_v1_retirement'
    ));
    await bridge.publishApprovalMarker(retirement);
    await expect(bridge.reconcileObservedLegacyMarker({
      approval_room_id: '!observed:test',
    })).resolves.toMatchObject({
      observed_nonempty: true,
      reconciliation: { reconciliation: { examined: 1, queued: 1 } },
    });
    expect(calls.find((entry) => entry.method === 'GET')).toMatchObject({
      endpoint: '/_matrix/client/v3/rooms/!observed%3Atest/state/com.agentchat.approval.room.v1/',
      timeout: 50,
    });
  });
});
