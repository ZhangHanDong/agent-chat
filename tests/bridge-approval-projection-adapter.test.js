import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';
import {
  MatrixBridge, bridgeStateForTest, ourServerNameForTest,
  approvalProjectionIoForTest, publishApprovalProjectionWithBridgeForTest,
} from '../bridge-matrix.js';

const SECRET = 'adapter-bridge-secret';
const AGENT_TOKEN = 'adapter-agent-token';
const server = ourServerNameForTest().toLowerCase();
let context;
let originalBotState;

function bridgeRequest(method, url, body) {
  const req = request(context.app)[method.toLowerCase()](url).set('X-Bridge-Secret', SECRET);
  return body === undefined ? req : req.send(body);
}

beforeAll(async () => {
  context = await createBackendTestContext('hafleet-projection-adapter-', {
    agents: { worker: { name: 'worker', type: 'agent', kind: 'agent', online: true } },
    agentTokens: { worker: AGENT_TOKEN },
    env: { MATRIX_BRIDGE_SECRET: SECRET, HAFLEET_AGENT_TOKEN_MODE: 'hard',
      MATRIX_SERVER_NAME: server, MATRIX_BOT_USERNAME: 'bot' },
  });
  const state = bridgeStateForTest();
  originalBotState = { botMxid: state.botMxid, botCredentialGeneration: state.botCredentialGeneration };
  state.botMxid = `@bot:${server}`;
  state.botCredentialGeneration = 'adapter-bot-generation';
});

afterAll(async () => {
  const state = bridgeStateForTest();
  state.botMxid = originalBotState.botMxid;
  state.botCredentialGeneration = originalBotState.botCredentialGeneration;
  await context.cleanup();
});

describe('approval projection production request adapter', () => {
  test('public agent and botless private representative resolve as distinct canonical actors', async () => {
    const side = { side: { serverName: server, apiBaseUrl: 'https://side.invalid' },
      credential: { kind: 'appservice', senderLocalpart: 'hafleet', asToken: 'secret',
        outboundGeneration: 'side-generation' } };
    const publicSender = { kind: 'appservice', ...side, agentUserId: `@ac_worker:${server}`, agentName: 'worker' };
    const io = approvalProjectionIoForTest({ actingSideFor: () => side, agentSenderFor: () => publicSender });
    const approval = { agent: 'worker', project: 'adapter' };
    await expect(io.resolveActor({ channel: 'public_notice', target_room_id: `!project:${server}`, approval }))
      .resolves.toMatchObject({ scope: `agent:worker:${server}`, publisher_mxid: `@ac_worker:${server}` });
    await expect(io.resolveActor({ channel: 'private_request', target_room_id: `!owner:${server}`, approval }))
      .resolves.toMatchObject({ scope: `side-representative:${server}`, publisher_mxid: `@hafleet:${server}` });
  });

  test('side plaintext policy requires a positively absent encryption state', async () => {
    const side = { side: { serverName: server, apiBaseUrl: 'https://side.invalid' },
      credential: { kind: 'appservice', senderLocalpart: 'hafleet', asToken: 'secret',
        outboundGeneration: 'side-generation' } };
    const io = approvalProjectionIoForTest({ actingSideFor: () => side });
    const row = { request_id: 'approval_side', revision: 1, channel: 'private_request', state: 'pending',
      migration_kind: 'native_v2', target_room_id: `!owner:${server}`,
      approval: { agent: 'worker', project: 'adapter', project_room_id: `!project:${server}`,
        owner_mxid: `@owner:${server}`, input_digest: 'b'.repeat(64), expires_at: Date.now() + 1000 } };
    const actor = await io.resolveActor(row);
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404, ok: false,
      clone() { return this; }, json: async () => ({ errcode: 'M_NOT_FOUND' }) })));
    await expect(io.prepareContent(row, actor)).resolves.toMatchObject({ event_type: 'm.room.message' });
    expect(fetch.mock.calls[0][0]).toContain(`user_id=${encodeURIComponent(`@hafleet:${server}`)}`);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404, ok: false,
      clone() { return this; }, json: async () => ({ errcode: 'M_UNRECOGNIZED' }) })));
    await expect(io.prepareContent(row, actor)).rejects.toThrow(/absence was not confirmed/);
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true,
      clone() { return this; }, json: async () => ({ algorithm: 'm.megolm.v1.aes-sha2' }) })));
    await expect(io.prepareContent(row, actor)).rejects.toThrow(/encrypted project-side/);
  });

  test('registration representative security uses its verified token without masquerade', async () => {
    const side = { side: { serverName: server, apiBaseUrl: 'https://side.invalid',
      representative: { mxid: `@representative:${server}` } },
    credential: { kind: 'registrationToken', representativeToken: 'representative-secret',
      representativeMxid: `@representative:${server}`, outboundGeneration: 'registration-generation' } };
    const io = approvalProjectionIoForTest({ actingSideFor: () => side });
    const row = { request_id: 'approval_registration', revision: 1, channel: 'private_request', state: 'pending',
      migration_kind: 'native_v2', target_room_id: `!owner:${server}`,
      approval: { agent: 'worker', project: 'adapter', expires_at: Date.now() + 1000 } };
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404, ok: false,
      clone() { return this; }, json: async () => ({ errcode: 'M_NOT_FOUND' }) })));
    await expect(io.prepareContent(row, await io.resolveActor(row))).resolves.toBeTruthy();
    expect(fetch.mock.calls[0][0]).not.toContain('user_id=');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer representative-secret');
  });

  test('side security lookup aborts a real stalled socket within its owned deadline', async () => {
    const socket = createServer((_req, _res) => {});
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const address = socket.address();
    const side = { side: { serverName: server, apiBaseUrl: `http://127.0.0.1:${address.port}` },
      credential: { kind: 'appservice', senderLocalpart: 'hafleet', asToken: 'secret',
        outboundGeneration: 'side-generation' } };
    const bridge = { actingSideFor: () => side, approvalProjectionSecurityTimeoutMs: 25 };
    const io = approvalProjectionIoForTest(bridge);
    const row = { request_id: 'approval_timeout', revision: 1, channel: 'private_request', state: 'pending',
      migration_kind: 'native_v2', target_room_id: `!owner:${server}`,
      approval: { agent: 'worker', project: 'adapter', expires_at: Date.now() + 1000 } };
    vi.unstubAllGlobals();
    try {
      await expect(io.prepareContent(row, await io.resolveActor(row))).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      await new Promise(resolve => socket.close(resolve));
    }
  });

  test('local private preparation fails closed when crypto readiness disappears', async () => {
    const bridge = { botClient: { crypto: null }, botUserId: `@bot:${server}`, approvalDmMode: 'encrypted',
      actingSideFor: () => null, ensureApprovalDmSecurity: vi.fn(async () => {}) };
    bridge.approvalBotPublisherReady = { client: bridge.botClient, mxid: bridge.botUserId,
      credentialGeneration: 'adapter-bot-generation' };
    const io = approvalProjectionIoForTest(bridge);
    const row = { channel: 'private_request', target_room_id: `!owner:${server}`,
      approval: { id: 'approval_x', agent: 'worker', project: 'adapter', expires_at: Date.now() + 1000 } };
    const actor = await io.resolveActor(row);
    await expect(io.prepareContent(row, actor)).rejects.toThrow(/encryption is unavailable/);
  });

  test('saved bot fields alone are not publisher readiness and selected status state wins', async () => {
    const client = { crypto: {} };
    const bridge = { botClient: client, botUserId: `@bot:${server}`, actingSideFor: () => null,
      approvalDmMode: 'plaintext-test', ensureApprovalDmSecurity: vi.fn(async () => {}) };
    let io = approvalProjectionIoForTest(bridge);
    const row = { request_id: 'approval_0123456789abcdef0123456789abcdef', revision: 2, channel: 'private_status', state: 'approved',
      migration_kind: 'native_v2', target_room_id: `!owner:${server}`,
      publisher: { scope: 'local_bot' },
      approval: { id: 'approval_0123456789abcdef0123456789abcdef', agent: 'worker', project: 'adapter',
        project_room_id: `!project:${server}`, owner_mxid: `@owner:${server}`,
        input_digest: 'a'.repeat(64), status: 'consumed', decision: 'allow' } };
    await expect(io.resolveActor(row)).resolves.toBeNull();
    bridge.approvalBotPublisherReady = { client, mxid: bridge.botUserId,
      credentialGeneration: 'adapter-bot-generation' };
    io = approvalProjectionIoForTest(bridge);
    const actor = await io.resolveActor(row);
    const prepared = await io.prepareContent(row, actor);
    expect(prepared.content['com.agentchat.approval']).toMatchObject({
      version: 1, request_id: row.request_id, revision: 2, state: 'approved', decision: 'allow',
      migration_kind: 'native_v2', agent: 'worker', project: 'adapter',
      project_room_id: `!project:${server}`, owner_mxid: `@owner:${server}`,
      publisher_mxid: `@bot:${server}`, input_digest: 'a'.repeat(64),
    });
  });

  test('bot readiness installation binds the exact verified client and clears on replacement failure', () => {
    const verified = { crypto: {} };
    const bridge = { botClient: verified, botUserId: `@bot:${server}`, approvalBotPublisherReady: null,
      clearApprovalBotPublisherReady: MatrixBridge.prototype.clearApprovalBotPublisherReady };
    MatrixBridge.prototype.installApprovalBotPublisherReady.call(
      bridge, verified, bridge.botUserId, 'adapter-bot-generation',
    );
    expect(bridge.approvalBotPublisherReady).toEqual({ client: verified, mxid: bridge.botUserId,
      credentialGeneration: 'adapter-bot-generation' });
    bridge.botClient = { crypto: {} };
    expect(() => MatrixBridge.prototype.installApprovalBotPublisherReady.call(
      bridge, verified, bridge.botUserId, 'adapter-bot-generation',
    )).toThrow(/verified.*context/);
    expect(bridge.approvalBotPublisherReady).toBeNull();
  });

  test('stored local plaintext is security-checked and refused before raw replay', async () => {
    const client = { crypto: {}, doRequest: vi.fn() };
    const bridge = { botClient: client, botUserId: `@bot:${server}`, approvalDmMode: 'encrypted',
      actingSideFor: () => null, ensureApprovalDmSecurity: vi.fn(async () => {}) };
    bridge.approvalBotPublisherReady = { client, mxid: bridge.botUserId,
      credentialGeneration: 'adapter-bot-generation' };
    const io = approvalProjectionIoForTest(bridge);
    const row = { request_id: 'approval_plain', revision: 1, channel: 'private_request',
      target_room_id: `!owner:${server}`, approval: { agent: 'worker' } };
    const actor = await io.resolveActor(row);
    await expect(io.send({ prepared_event_type: 'm.room.message', prepared_payload: { body: 'old' },
      transaction_id: 'stored_plain' }, actor, row)).rejects.toThrow(/stored plaintext/);
    expect(bridge.ensureApprovalDmSecurity).toHaveBeenCalledOnce();
    expect(client.doRequest).not.toHaveBeenCalled();
  });

  test('real store/API prepares encrypted bytes once, begins before exact raw PUT, and receipts', async () => {
    await bridgeRequest('put', '/api/approval-bindings', {
      agent: 'worker', project: 'adapter', project_room_id: `!project:${server}`,
      owner_mxid: `@owner:${server}`, owner_dm_room_id: `!owner:${server}`,
    });
    const created = await request(context.app).post('/api/approvals').set('X-Agent-Token', AGENT_TOKEN).send({
      agent: 'worker', runtime: 'codex', project: 'adapter', project_room_id: `!project:${server}`,
      upstream_request_id: 'adapter-native', tool_name: 'Bash', input_preview: 'pwd',
    });
    expect(created.status).toBe(201);
    const due = await bridgeRequest('get', '/api/approvals/matrix/projections?limit=20');
    const row = due.body.projections.find(item => item.request_id === created.body.approval.id
      && item.channel === 'private_request');
    const order = [];
    const encryptRoomEvent = vi.fn(async (_room, _type, content) => {
      order.push('encrypt');
      return { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: JSON.stringify(content) };
    });
    let matrixAttempts = 0;
    const doRequest = vi.fn(async (method, path, _query, content) => {
      order.push('matrix');
      matrixAttempts += 1;
      expect(method).toBe('PUT');
      expect(path).toContain('/send/m.room.encrypted/');
      expect(content).toEqual(expect.objectContaining({ ciphertext: expect.any(String) }));
      const stored = (await bridgeRequest('get', '/api/approvals/matrix/projections?limit=20')).body.projections
        .find(item => item.request_id === row.request_id && item.channel === row.channel);
      expect(stored.plan.attempt_state).toBe('attempted');
      expect(path.endsWith(`/${stored.plan.transaction_id}`)).toBe(true);
      expect(content).toEqual(stored.plan.prepared_payload);
      const canonical = JSON.parse(content.ciphertext)['com.agentchat.approval'];
      expect(canonical).toMatchObject({ version: 1, request_id: row.request_id, revision: 1,
        state: 'pending', migration_kind: 'native_v2', owner_mxid: `@owner:${server}`,
        publisher_mxid: `@bot:${server}`, project_room_id: `!project:${server}`,
        input_digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      if (matrixAttempts === 1) throw Object.assign(new Error('connection reset'), { code: 'timeout' });
      return { event_id: '$adapter-event' };
    });
    const bridge = {
      botClient: {
        getRoomStateEvent: vi.fn(async () => ({ algorithm: 'm.megolm.v1.aes-sha2' })),
        crypto: { onRoomEvent: vi.fn(async () => {}), isRoomEncrypted: vi.fn(async () => true), encryptRoomEvent },
        doRequest,
      },
      botUserId: `@bot:${server}`,
      approvalDmMode: 'encrypted',
      actingSideFor: () => null,
      ensureApprovalDmEncrypted: MatrixBridge.prototype.ensureApprovalDmEncrypted,
      ensureApprovalDmSecurity: MatrixBridge.prototype.ensureApprovalDmSecurity,
      callBackendApi: async (method, url, body) => {
        order.push(url.endsWith('/prepare') ? 'prepare' : url.endsWith('/begin-send') ? 'begin'
          : url.endsWith('/receipt') ? 'receipt' : 'api');
        const response = await bridgeRequest(method, url, body);
        if (response.status >= 400) throw new Error(`backend ${response.status}`);
        return response.body;
      },
    };
    bridge.approvalBotPublisherReady = { client: bridge.botClient, mxid: bridge.botUserId,
      credentialGeneration: 'adapter-bot-generation' };
    const first = await publishApprovalProjectionWithBridgeForTest(bridge, row);
    expect(first).toMatchObject({ ok: false, uncertain: true });
    expect(encryptRoomEvent).toHaveBeenCalledTimes(1);
    expect(order.indexOf('prepare')).toBeLessThan(order.indexOf('begin'));
    expect(order.indexOf('begin')).toBeLessThan(order.indexOf('matrix'));
    const retryRows = (await bridgeRequest('get', '/api/approvals/matrix/projections?limit=20')).body.projections;
    const retryRow = retryRows.find(item => item.request_id === row.request_id && item.channel === row.channel);
    expect(retryRow.plan.attempt_state).toBe('uncertain');
    bridge.botClient.crypto.encryptRoomEvent = vi.fn(async () => { throw new Error('must not re-encrypt'); });
    const result = await publishApprovalProjectionWithBridgeForTest(bridge, retryRow);
    expect(result).toEqual({ ok: true, event_id: '$adapter-event' });
    expect(encryptRoomEvent).toHaveBeenCalledTimes(1);
    expect(doRequest).toHaveBeenCalledTimes(2);
    expect(doRequest.mock.calls[1][3]).toEqual(doRequest.mock.calls[0][3]);
    expect(doRequest.mock.calls[1][1]).toBe(doRequest.mock.calls[0][1]);
    expect(order.lastIndexOf('matrix')).toBeLessThan(order.indexOf('receipt'));
    const after = await bridgeRequest('get', '/api/approvals/matrix/projections?limit=20');
    expect(after.body.projections.some(item => item.request_id === row.request_id
      && item.channel === row.channel)).toBe(false);
  });

  test('side security 429 performs one bounded request and defers publication', async () => {
    const side = { side: { serverName: server, apiBaseUrl: 'https://side.invalid' },
      credential: { kind: 'appservice', senderLocalpart: 'hafleet', asToken: 'secret',
        outboundGeneration: 'side-generation' } };
    const io = approvalProjectionIoForTest({ actingSideFor: () => side });
    const row = { request_id: 'approval_limited', revision: 1, channel: 'private_request', state: 'pending',
      migration_kind: 'native_v2', target_room_id: `!owner:${server}`,
      approval: { agent: 'worker', project: 'adapter', expires_at: Date.now() + 1000 } };
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 429, ok: false,
      clone: () => ({ json: async () => ({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1 }) }) })));
    await expect(io.prepareContent(row, await io.resolveActor(row))).rejects.toThrow(/rate limited/);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
