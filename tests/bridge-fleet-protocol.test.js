import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotEnv, restoreEnv } from './helpers/env.js';
import { createAppserviceRouter } from '../lib/appservice-receiver.js';
import { FLEET_PROBE_EVENT, FLEET_REQUEST_EVENT } from '../lib/fleet-protocol.js';

let MatrixBridge;
let temp;
let env;
beforeAll(async () => {
  temp = mkdtempSync(path.join(os.tmpdir(), 'bridge-fleet-protocol-'));
  env = snapshotEnv(['HAFLEET_RUNTIME_DIR']);
  process.env.HAFLEET_RUNTIME_DIR = temp;
  ({ MatrixBridge } = await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?fleet=${Date.now()}`));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => { restoreEnv(env); rmSync(temp, { recursive: true, force: true }); });

test('real bridge records the push probe and forwards only verified private-owner requests', async () => {
  const fleetId = `hf_${'d'.repeat(32)}`;
  const sideId = 'palpo.test';
  const registration = `${sideId}@generation`;
  const rep = `@${fleetId}_representative:${sideId}`;
  const borrower = '@owner:palpo.test';
  const bot = '@approvalbot:palpo.test';
  const source = '!reception:palpo.test';
  const target = '!target:palpo.test';
  const dm = '!private:palpo.test';
  const probeEvent = { type: FLEET_PROBE_EVENT, sender: rep, room_id: source, event_id: '$probe-adapter',
    content: { fleetId, challenge: 'unique_challenge_12345' } };
  const content = { v: 1, fleetId, requestId: 'adapter_request', requesterMxid: borrower,
    sourceRoomId: source, targetProjectId: 'project_1', targetRoomId: target,
    ownerMxid: borrower, ownerDmRoomId: dm, role: 'coding', requestedTokens: 10000,
    ratePerDay: 1000, authVersion: 1 };
  const requestEvent = { type: FLEET_REQUEST_EVENT, sender: borrower, room_id: source, event_id: '$adapter-request',
    content: Object.fromEntries(Object.entries(content).filter(([key]) => key !== 'ownerDmRoomId')) };
  const row = { sideId, serverName: sideId, apiBaseUrl: 'https://fixture.invalid', kind: 'appservice',
    senderLocalpart: `${fleetId}_representative`, asToken: 'own-as-token', hsToken: 'own-hs-token',
    namespace: `^@${fleetId}_[a-z0-9_]+:palpo\\.test$`, registration, representative: { mxid: rep } };
  const bridge = new MatrixBridge();
  bridge.botUserId = bot;
  bridge.actingCredentials = new Map([[sideId, row]]);
  bridge.appserviceRouter = createAppserviceRouter({ logger: {} });
  bridge.backendApiForSides = vi.fn(async () => ({ sides: [row] }));
  bridge.callBackendApi = vi.fn(async (_method, route, payload) => {
    expect(route).toBe('/api/fleet-control');
    expect(payload).toMatchObject({ action: 'request', sideId, registration,
      context: { ...content, sourceEventId: requestEvent.event_id } });
    return { ok: true, state: 'pending', fleetId, requestId: content.requestId };
  });
  bridge.onRoomMessage = vi.fn(); bridge.onRoomEvent = vi.fn(); bridge.commands = { handle: vi.fn() };
  bridge.botClient = { doRequest: vi.fn(async (method, endpoint) => {
    expect(method).toBe('GET'); expect(endpoint).toContain(encodeURIComponent(dm));
    if (endpoint.endsWith('joined_members')) return { joined: { [borrower]: {}, [bot]: {} } };
    if (endpoint.endsWith('m.room.join_rules/')) return { join_rule: 'invite' };
    if (endpoint.endsWith('m.room.encryption/')) return { algorithm: 'm.megolm.v1.aes-sha2' };
    throw new Error('unexpected private bot operation');
  }) };
  vi.stubGlobal('fetch', vi.fn(async (input, options) => {
    const url = new URL(input);
    expect(url.origin).toBe('https://fixture.invalid');
    expect(url.searchParams.get('user_id')).toBe(rep);
    expect(options.headers.Authorization).toBe('Bearer own-as-token');
    expect(url.pathname).not.toContain(encodeURIComponent(dm));
    let value;
    if (url.pathname.endsWith('/joined_members')) value = { joined: { [borrower]: {}, [rep]: {} } };
    else if (url.pathname.includes('/event/')) value = url.pathname.includes('%24probe-adapter') ? probeEvent : requestEvent;
    else if (url.pathname.endsWith('m.room.join_rules/')) value = { join_rule: 'invite' };
    else if (url.pathname.endsWith('m.room.encryption/')) return { ok: false, status: 404 };
    else if (url.pathname.endsWith('m.room.power_levels/')) value = { invite: 0, users: { [borrower]: 100 } };
    else if (url.pathname.includes('com.hafleet.admin.binding.v1/')) value = { v: 1, fleetId,
      purpose: 'project', projectId: 'project_1', ownerMxid: borrower, authVersion: 1 };
    else throw new Error(`unexpected representative request: ${url.pathname}`);
    return { ok: true, status: 200, json: async () => value };
  }));
  await bridge.refreshAppserviceSides();
  const delivered = await bridge.appserviceRouter.handle({ method: 'PUT', path: '/_matrix/app/v1/transactions/probe_1',
    headers: { authorization: 'Bearer own-hs-token' }, body: { events: [probeEvent, requestEvent] }, transport: { mode: 'push' } });
  expect(delivered.status).toBe(200);
  const persisted = JSON.parse(readFileSync(path.join(temp, 'data', 'matrix', 'bridge-state.json'), 'utf8'));
  expect(persisted.fleetProtocol[fleetId].receipts[probeEvent.event_id]).toMatchObject({ sourceRoomId: source, mode: 'push' });
  const probe = await bridge.appserviceRouter.handle({ method: 'POST', path: '/api/fleet/v1/probe',
    headers: { authorization: 'Bearer own-hs-token' }, body: { fleetId, sourceRoomId: source,
      sourceEventId: probeEvent.event_id, challenge: probeEvent.content.challenge } });
  expect(probe).toMatchObject({ status: 200, body: { received: true } });
  const accepted = await bridge.appserviceRouter.handle({ method: 'POST', path: '/api/fleet/v1/requests',
    headers: { authorization: 'Bearer own-hs-token' }, body: { ...content, sourceEventId: requestEvent.event_id } });
  expect(accepted).toMatchObject({ status: 200, body: { state: 'pending' } });
  expect(bridge.botClient.doRequest).toHaveBeenCalledTimes(3);
  expect(bridge.onRoomMessage).not.toHaveBeenCalled();
  expect(bridge.onRoomEvent).not.toHaveBeenCalled();
  expect(bridge.commands.handle).not.toHaveBeenCalled();
});
