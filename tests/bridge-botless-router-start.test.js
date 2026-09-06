import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { restoreEnv, snapshotEnv } from './helpers/env.js';

// Satisfies REQ-TSS-TASK-ACTIVATION and ADR-016's appservice reachability contract.
describe('appservice startup drains thread outboxes without a bot', () => {
  let MatrixBridge;
  let runtimeDir;
  let envSnapshot;

  beforeAll(async () => {
    runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'hafleet-botless-router-'));
    envSnapshot = snapshotEnv([
      'HAFLEET_RUNTIME_DIR', 'MATRIX_BRIDGE_SECRET', 'HAFLEET_THREAD_SESSIONS',
      'HAFLEET_APPSERVICE_SYNC_SIDE', 'HAFLEET_APPSERVICE_SYNC_URL',
      'HAFLEET_ROUTER_OUTBOX_POLL_MS',
    ]);
    Object.assign(process.env, {
      HAFLEET_RUNTIME_DIR: runtimeDir,
      MATRIX_BRIDGE_SECRET: 'test-bridge-secret',
      HAFLEET_THREAD_SESSIONS: '1',
      HAFLEET_APPSERVICE_SYNC_SIDE: 'palpo.test',
      HAFLEET_APPSERVICE_SYNC_URL: 'http://palpo.test',
      HAFLEET_ROUTER_OUTBOX_POLL_MS: '250',
    });
    ({ MatrixBridge } = await import(`${pathToFileURL(path.resolve('bridge-matrix.js')).href}?botless-router-start`));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    restoreEnv(envSnapshot);
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  test('a pending task acknowledgement and a later reply both leave after bot login fails', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async () => new Response('{"ok":true}', { status: 200 }));
    const bridge = new MatrixBridge();
    // Replace unrelated startup I/O; start(), both outbox polls, and delivery stay real.
    for (const method of ['replayPendingMatrixDeliveries', 'refreshActingCredentials',
      'pollAgentInvites', 'pollRegistrations', 'startAppserviceIntake', 'connectSSE', 'writeHealthRecord']) {
      bridge[method] = async () => {};
    }
    bridge.startBotSide = async () => { throw new Error('bot password missing'); };
    bridge.getAgentToken = () => null;
    bridge.ensureAgentToken = async () => null;
    const sender = { kind: 'appservice' };
    bridge.agentSenderFor = () => sender;
    const sends = [];
    bridge.sendAsAgentContent = async (...args) => { sends.push(args); return '$sent'; };
    const command = (id) => ({ commandId: id, senderAgentName: 'worker', roomId: '!room:palpo.test',
      threadRootEventId: '$root', body: id, transactionId: id, claimToken: 'claim' });
    const pending = { matrix: command('task-ack'), reply: null };
    const receipts = [];
    bridge.callBackendApi = async (_method, route, body) => {
      const claim = /\/(matrix|reply)-outbox\/claim$/.exec(route);
      if (claim) {
        const next = pending[claim[1]];
        pending[claim[1]] = null;
        return { command: next };
      }
      receipts.push({ route, body });
      return { ok: true };
    };

    await bridge.start();
    expect(sends.map((args) => args[2].body)).toEqual(['task-ack']);
    expect(sends[0][0]).toBe(sender);
    expect(sends[0][2]['m.relates_to'].event_id).toBe('$root');
    expect(receipts[0].route).toBe('/api/router/matrix-outbox/task-ack/delivered');
    pending.reply = command('task-result');
    await vi.advanceTimersByTimeAsync(250);
    expect(sends.map((args) => args[2].body)).toEqual(['task-ack', 'task-result']);
    expect(receipts[1].route).toBe('/api/router/reply-outbox/task-result/delivered');
  });
});
