import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
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

  test('local private preparation fails closed when crypto readiness disappears', async () => {
    const bridge = { botClient: { crypto: null }, botUserId: `@bot:${server}`, approvalDmMode: 'encrypted',
      actingSideFor: () => null, ensureApprovalDmSecurity: vi.fn(async () => {}) };
    const io = approvalProjectionIoForTest(bridge);
    const row = { channel: 'private_request', target_room_id: `!owner:${server}`,
      approval: { id: 'approval_x', agent: 'worker', project: 'adapter', expires_at: Date.now() + 1000 } };
    const actor = await io.resolveActor(row);
    await expect(io.prepareContent(row, actor)).rejects.toThrow(/encryption is unavailable/);
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
});
