import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import request from 'supertest';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';

describe('backend on-demand runner projection', () => {
  let context, router;
  const agent = (name, overrides = {}) => ({ name, agentId: `agent_${name}`, kind: 'agent', type: 'codex', workdir: process.cwd(), online: false, tmux: null, ...overrides });
  const records = {
    ready: agent('ready', { offlineReason: 'tmux-missing:auto' }),
    modeled: agent('modeled', { runtimeProfile: { primary: { framework: 'codex', model: 'declared-model', apiKey: 'secret-model-key' } } }),
    stopped: agent('stopped', { manualDown: true, offlineReason: 'manual-offline' }),
    missing: agent('missing', { workdir: '/nonexistent/hafleet-runner-projection-workdir' }),
    file: agent('file', { workdir: `${process.cwd()}/package.json` }),
    credential: agent('credential'),
    error: agent('error', { offlineReason: 'native-runtime-error' }),
    legacy: agent('legacy', { tmux: 'legacy:0.0', online: true }),
    tmux: agent('tmux', { transport: 'tmux' }),
    acp: agent('acp', { transport: 'acp' }),
    unknown: agent('unknown', { transport: 'other' }),
    malformed: agent('malformed', { transport: 0 }),
    invalidpane: agent('invalidpane', { tmux: false }),
    worktree: agent('worktree', { workspaceMode: 'worktree', worktreesDir: null }),
    remote: agent('remote', { server: 'remote-host' }),
    octos: agent('octos', { type: 'octos' }),
    anonymous: agent('anonymous', { agentId: null }),
  };
  const read = async (name = 'ready') => {
    const result = await request(context.app).get(`/api/agents/${name}`);
    expect(result.status).toBe(200);
    return result.body;
  };
  beforeAll(async () => {
    context = await createBackendTestContext('hafleet-runner-projection-', {
      agents: records,
      agentTokens: Object.fromEntries(Object.keys(records).filter(n => n !== 'credential').map(n => [n, `token-${n}`])),
      env: { HAFLEET_THREAD_SESSIONS: '1', HAFLEET_ROUTER_TASK_CUTOVER: '1' },
    });
    router = context.internals.routerStoreForTest;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => { context?.cleanup(); router?.close(); });

  test('projects ready on-demand availability without fabricating a live process or model', async () => {
    const projected = await read();
    expect(projected.runner).toEqual({ mode: 'on-demand', availability: 'ready', reason: null,
      framework: 'codex', activity: 'idle', activeDispatchCount: 0, queuedDispatchCount: 0,
      parkedDispatchCount: 0, model: null, modelSource: 'provider-default' });
    expect(projected).toMatchObject({ online: false, healthy: false, tmux: null, offlineReason: null, workspacePath: null, lastWorkspacePath: null });
    const modeled = await read('modeled');
    expect(modeled.runner).toMatchObject({ model: 'declared-model', modelSource: 'runtime-profile' });
    expect(JSON.stringify(modeled.runner)).not.toContain('secret-model-key');
  });

  test('preserves legacy and unsupported runtime classification', async () => {
    for (const name of ['legacy', 'tmux', 'acp', 'unknown', 'malformed', 'invalidpane', 'remote', 'octos', 'anonymous']) {
      expect((await read(name)).runner, name).toBeNull();
    }
  });

  test('refuses readiness for manual stops and incomplete configuration', async () => {
    for (const [name, reason] of [['stopped', 'manual-stop'], ['missing', 'workspace-unavailable'], ['file', 'workspace-unavailable'], ['worktree', 'workspace-unavailable'], ['credential', 'credential-unavailable'], ['error', 'runtime-unavailable']]) {
      expect((await read(name)).runner, name).toMatchObject({ availability: 'unavailable', reason });
    }
  });

  test('skips missing tmux observations for runners and retains legacy transport after pane loss', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const snapshot = await context.internals.buildLocalPaneMetadataSnapshotForTest(
      vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    );
    for (let i = 0; i < 3; i += 1) await context.internals.sweepLocalActivityDurationsForTest(snapshot);
    expect((await read()).runner.availability).toBe('ready');
    expect((await read()).offlineReason).toBeNull();
    expect(warn.mock.calls.flat().some(value => String(value).includes('agent=ready '))).toBe(false);
    expect(await read('legacy')).toMatchObject({ runner: null, transport: 'tmux', online: false, offlineReason: 'tmux-missing:auto' });
  });

  function enqueue(id, agentName = 'ready') {
    const input = router.ingestMessage({ messageId: id, roomId: `!${id}:test`, matrixEventId: `$${id}`, senderName: 'human', senderMxid: '@human:test', recipientAgentId: `agent_${agentName}`, recipientAgentName: agentName, normalizedBody: 'hello' });
    expect(input.ok).toBe(true);
    const queued = router.enqueueDispatch({ sessionId: input.session.sessionId, framework: 'codex', localServerId: 'local', mayWrite: false, payload: {} });
    expect(queued.ok).toBe(true);
    return queued.dispatchId;
  }

  test('projects current dispatch activity independently of terminal history and display limits', async () => {
    const id = enqueue('current');
    const original = router.db.prepare('SELECT * FROM dispatches WHERE dispatch_id = ?').get(id);
    const columns = Object.keys(original);
    const insert = router.db.prepare(`INSERT INTO dispatches (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    router.db.transaction(() => {
      for (let i = 0; i < 1005; i += 1) {
        const row = { ...original, dispatch_id: `historical-${i}`, state: ['completed', 'cancelled_before_start', 'outcome_unknown'][i % 3], created_at: original.created_at + 1 };
        insert.run(...columns.map(k => row[k]));
      }
    })();
    expect((await read()).runner).toMatchObject({ availability: 'ready', activity: 'queued', queuedDispatchCount: 1, activeDispatchCount: 0 });
    const claim = router.claimDispatch({ runnerId: 'runner-test', leaseMs: 60000, capabilityTtlMs: 60000, maxLiveRunners: 4 });
    // History on this session intentionally includes unresolved outcomes; test the projection
    // independently of scheduling policy using the same ledger state values the scheduler owns.
    if (claim?.ok) router.cancelBeforeStart(claim.dispatchId);
    for (const state of ['leased', 'started', 'parked']) {
      router.db.prepare('UPDATE dispatches SET state = ? WHERE dispatch_id = ?').run(state, id);
      expect((await read()).runner).toMatchObject({ availability: 'ready', activity: state === 'parked' ? 'parked' : 'running', activeDispatchCount: 1, parkedDispatchCount: state === 'parked' ? 1 : 0, queuedDispatchCount: 0 });
    }
    router.db.prepare("UPDATE dispatches SET state = 'completed' WHERE dispatch_id = ?").run(id);
    enqueue('other-agent', 'modeled');
    expect((await read()).runner).toMatchObject({ availability: 'ready', activity: 'idle', activeDispatchCount: 0, queuedDispatchCount: 0 });
  });

  test('fails closed on dispatch query errors and unknown states', async () => {
    const query = vi.spyOn(router, 'agentDispatchActivity').mockImplementation(() => { throw new Error('secret-query-path'); });
    const failed = await read();
    expect(failed.runner).toMatchObject({ availability: 'unknown', activity: 'unknown', reason: 'dispatch-state-unavailable', activeDispatchCount: null });
    expect(JSON.stringify(failed.runner)).not.toContain('secret-query-path');
    query.mockRestore();
    const id = enqueue('unknown-state');
    router.db.pragma('ignore_check_constraints = ON');
    router.db.prepare("UPDATE dispatches SET state = 'future-state' WHERE dispatch_id = ?").run(id);
    router.db.pragma('ignore_check_constraints = OFF');
    expect((await read()).runner).toMatchObject({ availability: 'unknown', activity: 'unknown', reason: 'dispatch-state-unavailable' });
  });
});

describe('backend hybrid thread dispatch projection', () => {
  let context, router;
  const agent = (name, overrides = {}) => ({ name, agentId: `agent_${name}`, kind: 'agent', type: 'claude',
    workdir: process.cwd(), online: true, transport: 'tmux', tmux: `${name}:0.0`, ...overrides });
  beforeEach(async () => {
    context = await createBackendTestContext('hafleet-hybrid-projection-', {
      agents: {
        hybrid: agent('hybrid'), other: agent('other'),
        stopped: agent('stopped', { manualDown: true, online: false, offlineReason: 'manual-offline' }),
        acp: agent('acp', { transport: 'acp', tmux: null }),
        remote: agent('remote', { server: 'remote-host' }),
        octos: agent('octos', { type: 'octos' }), anonymous: agent('anonymous', { agentId: null }),
      },
      agentRuntime: { hybrid: { activeNow: false, idleDurationSec: 119745, activeDurationSec: 0 } },
      agentTokens: { hybrid: 'test-hybrid-token', other: 'test-other-token', acp: 'test-acp-token' },
      env: { HAFLEET_THREAD_SESSIONS: '1', HAFLEET_ROUTER_TASK_CUTOVER: '1' },
    });
    router = context.internals.routerStoreForTest;
  });
  afterEach(() => { vi.restoreAllMocks(); context?.cleanup(); router?.close(); });
  const read = async (name = 'hybrid') => {
    const response = await request(context.app).get(`/api/agents/${name}`);
    expect(response.status).toBe(200);
    return response.body;
  };
  function enqueue(id, name = 'hybrid', state = 'queued') {
    const input = router.ingestMessage({ messageId: id, roomId: `!${id}:test`, matrixEventId: `$${id}`,
      senderName: 'human', senderMxid: '@human:test', recipientAgentId: `agent_${name}`,
      recipientAgentName: name, normalizedBody: 'hello' });
    expect(input.ok).toBe(true);
    const queued = router.enqueueDispatch({ sessionId: input.session.sessionId, framework: 'claude',
      localServerId: 'local', mayWrite: false, payload: {} });
    expect(queued.ok).toBe(true);
    // This test isolates serialization from the scheduler and never launches a real runner.
    router.db.prepare('UPDATE dispatches SET state = ? WHERE dispatch_id = ?').run(state, queued.dispatchId);
    return queued.dispatchId;
  }

  test('projects hybrid dispatch activity without replacing terminal liveness', async () => {
    const before = await read();
    const id = enqueue('hybrid-current');
    for (const [state, activity, active, queued, parked] of [
      ['queued', 'queued', 0, 1, 0], ['leased', 'running', 1, 0, 0],
      ['started', 'running', 1, 0, 0], ['parked', 'parked', 1, 0, 1],
    ]) {
      router.db.prepare('UPDATE dispatches SET state = ? WHERE dispatch_id = ?').run(state, id);
      const projected = await read();
      expect(projected.dispatchActivity).toEqual({ source: 'router-ledger', activity,
        activeDispatchCount: active, queuedDispatchCount: queued, parkedDispatchCount: parked });
      expect(projected).toMatchObject({ runner: null, transport: 'tmux', tmux: 'hybrid:0.0',
        online: before.online, healthy: before.healthy, activeNow: false, idleDurationSec: 119745 });
      const list = await request(context.app).get('/api/agents');
      expect(list.body.find(a => a.name === 'hybrid').dispatchActivity).toEqual(projected.dispatchActivity);
    }
    enqueue('acp-current', 'acp', 'started');
    expect(await read('acp')).toMatchObject({ runner: null, transport: 'acp', tmux: null,
      dispatchActivity: { activity: 'running', activeDispatchCount: 1 } });
  });

  test('ignores terminal history and other agents for hybrid dispatch activity', async () => {
    for (const state of ['completed', 'cancelled_before_start', 'outcome_unknown']) enqueue(state, 'hybrid', state);
    enqueue('other-started', 'other', 'started');
    expect(await read()).toMatchObject({ runner: null, activeNow: false, idleDurationSec: 119745,
      dispatchActivity: { source: 'router-ledger', activity: 'idle', activeDispatchCount: 0,
        queuedDispatchCount: 0, parkedDispatchCount: 0 } });
  });

  test('fails closed on hybrid dispatch errors without hiding terminal state', async () => {
    const before = await read();
    const query = vi.spyOn(router, 'agentDispatchActivity').mockImplementation(() => { throw new Error('private-query-detail'); });
    const assertUnknown = async () => {
      const projected = await read();
      expect(projected.dispatchActivity).toEqual({ source: 'router-ledger', activity: 'unknown',
        activeDispatchCount: null, queuedDispatchCount: null, parkedDispatchCount: null });
      expect(projected).toMatchObject({ runner: null, transport: 'tmux', tmux: 'hybrid:0.0', online: before.online });
      expect(JSON.stringify(projected.dispatchActivity)).not.toContain('private-query-detail');
    };
    await assertUnknown();
    query.mockRestore();
    const id = enqueue('unknown-hybrid');
    router.db.pragma('ignore_check_constraints = ON');
    router.db.prepare("UPDATE dispatches SET state = 'future-state' WHERE dispatch_id = ?").run(id);
    router.db.pragma('ignore_check_constraints = OFF');
    await assertUnknown();
  });

  test('retains hybrid dispatch observation after legacy pane loss', async () => {
    enqueue('pane-lost', 'hybrid', 'started');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const snapshot = await context.internals.buildLocalPaneMetadataSnapshotForTest(
      vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    );
    for (let i = 0; i < 3; i += 1) await context.internals.sweepLocalActivityDurationsForTest(snapshot);
    expect(await read()).toMatchObject({ runner: null, transport: 'tmux', tmux: null,
      online: false, offlineReason: 'tmux-missing:auto', dispatchActivity: { activity: 'running', activeDispatchCount: 1 } });
  });

  test('excludes unsupported identities from dispatch activity', async () => {
    for (const name of ['remote', 'octos', 'anonymous']) expect((await read(name)).dispatchActivity, name).toBeNull();
  });

  test('preserves a manually stopped hybrid terminal across dispatch activity', async () => {
    const assertStopped = async (activity, activeDispatchCount) => {
      expect(await read('stopped')).toMatchObject({ online: false, manualDown: true, runner: null,
        transport: 'tmux', offlineReason: 'manual-offline',
        dispatchActivity: { activity, activeDispatchCount, queuedDispatchCount: 0, parkedDispatchCount: 0 } });
    };
    await assertStopped('idle', 0);
    const id = enqueue('stopped-dispatch', 'stopped', 'started');
    await assertStopped('running', 1);
    router.db.prepare("UPDATE dispatches SET state = 'completed' WHERE dispatch_id = ?").run(id);
    await assertStopped('idle', 0);
  });
});
