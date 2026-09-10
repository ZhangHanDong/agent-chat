import { afterEach, describe, expect, test, vi } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

let context;
const auth = { Authorization: 'Bearer projection-test-token' };
afterEach(async () => { vi.restoreAllMocks(); await context?.cleanup(); context = null; });

async function setup() {
  context = await createBackendTestContext('agent-runtime-projection-', {
    env: { HAGENCY_THREAD_SESSIONS: '1', HAGENCY_ROUTER_TASK_CUTOVER: '1', API_TOKEN: 'projection-test-token' },
    agents: Object.fromEntries(['worker', 'peer'].map((name) => [name, {
      name, agentId: `agent_${name}`, kind: 'agent', type: 'codex', server: 'local', online: true,
      runtimeProfile: { primary: { framework: 'codex', model: 'gpt-5.3-codex', reasoning: 'high' } },
    }])),
  });
  context.internals.stopRouterPumpForTest();
  const router = context.internals.routerStoreForTest;
  for (const name of ['worker', 'peer']) {
    const ingested = router.ingestMessage({ messageId: `input-${name}`, roomId: `!${name}:test`, matrixEventId: `$${name}`,
      senderName: 'owner', recipientAgentId: `agent_${name}`, recipientAgentName: name, normalizedBody: 'work' });
    router.setSessionOverrides({ agentId: `agent_${name}`, agentName: name, roomId: `!${name}:test`, mode: 'auto', requestedBy: '@owner:test' });
    router.registerWorkspace({ resourceId: name, safeLabel: name, backendPath: process.cwd() });
    expect(router.enqueueDispatch({ sessionId: ingested.session.sessionId, framework: 'codex', localServerId: 'local',
      workspaceResourceId: name, mayWrite: true, payload: {} }).ok).toBe(true);
  }
  return router;
}

describe('agent runtime projections', () => {
  test('roster and capability reuse one router snapshot for every agent in a response', async () => {
    const router = await setup();
    const snapshot = vi.spyOn(router, 'snapshot');
    const roster = await request(context.app).get('/api/agents').set(auth).expect(200);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(roster.body.filter((row) => ['worker', 'peer'].includes(row.name))).toHaveLength(2);
    expect(roster.body.find((row) => row.name === 'worker')).toMatchObject({ transport: 'thread-session', state: 'queued' });
    snapshot.mockClear();
    await request(context.app).get('/api/capability').set(auth).expect(200);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  test.each(['/Users/operator/private/project', '~/private/project', 'C:\\Users\\operator\\private'])('router and roster redact runtime paths from %s while retaining private inspection evidence', async (privatePath) => {
    const router = await setup();
    const claim = router.claimDispatch({ runnerId: 'fixture', leaseMs: 60000, capabilityTtlMs: 60000, maxLiveRunners: 4 });
    expect(router.takePayload(claim).ok).toBe(true);
    const agentName = router.getLaunchDescriptor(claim).agentName;
    const reason = `codex_runner_error:ENOENT: failed to open '${privatePath}'`;
    expect(router.markOutcomeUnknown(claim.dispatchId, reason).ok).toBe(true);
    const stored = router.db.prepare('SELECT terminal_reason FROM dispatches WHERE dispatch_id = ?').get(claim.dispatchId);
    expect(stored.terminal_reason).toBe(reason);
    const snapshot = await request(context.app).get('/api/router/snapshot').set(auth).expect(200);
    expect(JSON.stringify(snapshot.body)).not.toContain(privatePath);
    expect(snapshot.body.dispatches.find((row) => row.dispatchId === claim.dispatchId).terminalReason).toContain('redacted');
    expect(JSON.stringify(router.eventsAfter(0))).not.toContain(privatePath);
    const agent = await request(context.app).get(`/api/agents/${agentName}`).set(auth).expect(200);
    expect(agent.body.blockedReason).toContain('redacted');
    expect(JSON.stringify(agent.body)).not.toContain(privatePath);
  });
});
