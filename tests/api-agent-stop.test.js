import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { createBackendTestContext } from './helpers/backend-test-runtime.js';
import { runCodexDispatch } from '../router/dist/index.js';

const host = vi.hoisted(() => ({ sessions: new Set(), killed: [], keepAlive: false, failListing: false, listCalls: 0 }));
const launch = vi.hoisted(() => ({ child: null, count: 0 }));
const processExecuting = (pid) => {
  try {
    const state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
    return !!state && !state.startsWith('Z');
  } catch (error) { if (error.status === 1) return false; throw error; }
};
vi.mock('child_process', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  const original = await importOriginal();
  return {
    ...original,
    spawn: (command, args, options) => {
      if (args?.some((arg) => String(arg).endsWith('/runner-guardian.js'))) return original.spawn(command, args, options);
      launch.count += 1;
      launch.child = Object.assign(new EventEmitter(), { pid: 54321, unref() {} });
      return launch.child;
    },
  };
});
vi.mock('../lib/runtime/tmux.js', async (importOriginal) => ({
  ...await importOriginal(),
  createTmuxRuntime: () => ({
    name: 'tmux', capabilities: { sessions: true, capture: false, keys: false },
    isAvailable: async () => true,
    sessionExists: async (name) => host.sessions.has(name),
    listPanes: async () => {
      host.listCalls += 1;
      return {
        ok: !host.failListing, error: host.failListing ? 'probe failed' : null,
        panes: [...host.sessions].map((session) => ({ session, tty: 'test', pid: 123, path: '/fixture' })),
      };
    },
    killSession: async (name) => {
      host.killed.push(name);
      if (host.keepAlive) return false;
      return host.sessions.delete(name);
    },
    isEmptyServerError: () => false,
  }),
}));

describe('operator local stop and ephemeral runtime projection', () => {
  let context;
  beforeEach(async () => {
    host.sessions.clear(); host.killed.length = 0; host.keepAlive = false; host.failListing = false; host.listCalls = 0;
    launch.count = 0; launch.child = null;
    context = await createBackendTestContext('agent-stop-', {
      env: {
        API_TOKEN: 'operator-test-token', HAFLEET_THREAD_SESSIONS: '1',
        HAFLEET_ROUTER_TASK_CUTOVER: '1', HAFLEET_SESSION_ALLOWLIST: 'worker,other',
        HAFLEET_AGENT_TOKEN_MODE: 'hard', HAFLEET_HOMEDIR: '',
      },
      agentTokens: { worker: 'worker-test-token' },
      agents: {
        worker: { name: 'worker', agentId: 'agent_worker', kind: 'agent', type: 'codex', server: 'local', tmux: 'worker:0.0', online: true },
        other: { name: 'other', agentId: 'agent_other', kind: 'agent', type: 'codex', server: 'local', online: false },
        remote: { name: 'remote', kind: 'agent', type: 'codex', server: 'elsewhere', online: true },
        acp: { name: 'acp', kind: 'agent', type: 'codex-acp', transport: 'acp', server: 'local', acpPid: 12345 },
      },
    });
    context.internals.stopRouterPumpForTest();
  });
  afterEach(async () => { await context?.cleanup(); });
  const auth = () => ({ Authorization: 'Bearer operator-test-token' });
  const stop = (name = 'worker') => request(context.app).post(`/api/agents/${name}/stop`).set(auth());
  const agent = () => request(context.app).get('/api/agents/worker').set(auth());

  function queue(name = 'worker', mayWrite = true) {
    const router = context.internals.routerStoreForTest;
    const ingested = router.ingestMessage({
      messageId: `input-${name}`, roomId: `!${name}:test`, matrixEventId: `$${name}-input`,
      senderName: 'owner', recipientAgentId: `agent_${name}`, recipientAgentName: name,
      normalizedBody: 'test managed task',
    });
    if (mayWrite) {
      const granted = router.setSessionOverrides({
        agentId: `agent_${name}`, agentName: name, roomId: `!${name}:test`,
        mode: 'auto', requestedBy: '@owner:test',
      });
      expect(granted.ok !== false, JSON.stringify(granted)).toBe(true);
    }
    router.registerWorkspace({ resourceId: `workspace-${name}`, safeLabel: name, backendPath: process.cwd() });
    const dispatch = router.enqueueDispatch({
      sessionId: ingested.session.sessionId, framework: 'codex', localServerId: 'local',
      workspaceResourceId: `workspace-${name}`, mayWrite, payload: {},
    });
    expect(dispatch.ok, JSON.stringify(dispatch)).toBe(true);
    return dispatch;
  }
  function claim() {
    const router = context.internals.routerStoreForTest;
    const result = router.claimDispatch({ runnerId: 'fixture-runner', leaseMs: 60000, capabilityTtlMs: 60000, maxLiveRunners: 8 });
    expect(result.ok).toBe(true);
    expect(router.takePayload(result).ok).toBe(true);
    return result;
  }

  async function provisionThreadAgent() {
    const name = 'mx_project_coding_fresh';
    const response = await request(context.app).post(`/api/agents/${name}/provision`)
      .set(auth()).send({ framework: 'codex' }).expect(201);
    expect(response.body.agent).toMatchObject({ name, agentId: `agent_${name}`, type: 'codex', tmux: null, manualDown: false });
    for (const key of ['homeDir', 'stateDir', 'workdir']) expect(response.body.agent[key]).toContain(context.runtimeDir);
    expect(context.internals.sessionPolicyForTest.allows(name)).toBe(false);
    // A same-name terminal belongs to another runtime unless this agent records
    // that target. A thread Stop must not discover or kill it by name.
    host.sessions.add(name);
    host.failListing = true;
    return name;
  }

  test('stop requires the local operator and refuses remote or unowned ACP processes', async () => {
    await request(context.app).post('/api/agents/worker/stop').expect(401);
    context.internals.setLocalRequestOverrideForTest(() => false);
    expect((await stop()).status).toBe(403);
    context.internals.setLocalRequestOverrideForTest(() => true);
    expect((await stop('remote')).body).toMatchObject({ stopped: false, code: 'remote_stop_unsupported' });
    expect((await stop('acp')).body).toMatchObject({ stopped: false, code: 'acp_stop_unconfirmed' });
    expect(host.killed).toEqual([]);
  });

  test('stop confirms managed session disappearance and retains the agent record', async () => {
    host.sessions.add('worker'); host.sessions.add('unrelated');
    const response = await stop().expect(200);
    expect(response.body).toMatchObject({ stopped: true, sessionKilled: true });
    expect(host.sessions).toEqual(new Set(['unrelated']));
    expect((await agent()).body).toMatchObject({ name: 'worker', online: false, manualDown: true, tmux: null });
  });

  test('a failed stop or unavailable listing never reports a stopped process', async () => {
    host.sessions.add('worker'); host.keepAlive = true;
    expect((await stop().expect(503)).body.stopped).toBe(false);
    expect(host.sessions.has('worker')).toBe(true);
    host.keepAlive = false; host.failListing = true;
    expect((await stop().expect(503)).body.stopped).toBe(false);
  });

  test('a stop without a durable admission fence leaves the process untouched', async () => {
    host.sessions.add('worker');
    context.internals.setJsonSaveFailureForTest('agents.json', true);
    expect((await stop().expect(503)).body.stopped).toBe(false);
    expect(host.killed).toEqual([]);
    expect((await agent()).body.manualDown).toBe(false);
  });

  test('an agent record cannot redirect stop to a different local session', async () => {
    host.sessions.add('other');
    await request(context.app).patch('/api/agents/worker').set(auth()).send({ tmux: 'other:0.0' }).expect(200);
    expect((await stop().expect(403)).body).toMatchObject({ stopped: false, code: 'unmanaged_session' });
    expect(host.killed).toEqual([]);
  });

  test('provisioned thread agents stop through owned guardians without a tmux target', async () => {
    const name = await provisionThreadAgent();
    const dispatch = queue(name); claim();
    const runners = context.internals.liveThreadSessionRunnersForTest;
    const controller = new AbortController();
    let finish;
    const running = new Promise((resolve) => { finish = resolve; }).finally(() => runners.delete(dispatch.dispatchId));
    const runner = { controller, running, cleanupConfirmed: false, agentName: name, agentId: `agent_${name}` };
    runners.set(dispatch.dispatchId, runner);
    const listsBeforeStop = host.listCalls;
    let finished = false;
    const response = stop(name).then((result) => { finished = true; return result; });
    try {
      await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
      expect(finished).toBe(false);
      await request(context.app).post(`/api/agents/${name}/start`).set(auth()).expect(409);
      runner.cleanupConfirmed = true;
    } finally {
      finish();
    }
    expect(await response).toMatchObject({ status: 200, body: { stopped: true, sessionKilled: false, cancelledDispatches: [dispatch.dispatchId] } });
    expect((await request(context.app).get(`/api/agents/${name}`).set(auth())).body)
      .toMatchObject({ state: 'stopped', manualDown: true, tmux: null, stopUnconfirmedDispatches: [] });
    expect(context.internals.routerStoreForTest.inspectWorkspace(`workspace-${name}`).dirty).toBe(true);
    expect(host.listCalls).toBe(listsBeforeStop);
    expect(host.killed).toEqual([]);
    expect(host.sessions.has(name)).toBe(true);
  });

  test('idle provisioned thread agent stop does not require a managed tmux session', async () => {
    const name = await provisionThreadAgent();
    const listsBeforeStop = host.listCalls;
    expect((await stop(name).expect(200)).body).toMatchObject({ stopped: true, sessionKilled: false, cancelledDispatches: [],
      agent: { state: 'stopped', manualDown: true, tmux: null } });
    expect(host.listCalls).toBe(listsBeforeStop);
    expect(host.killed).toEqual([]);
    expect(host.sessions.has(name)).toBe(true);
  });

  test('thread guardian ownership does not bypass a recorded tmux target policy', async () => {
    const name = await provisionThreadAgent();
    const dispatch = queue(name); claim();
    const controller = new AbortController();
    context.internals.liveThreadSessionRunnersForTest.set(dispatch.dispatchId, {
      controller, running: Promise.resolve(), cleanupConfirmed: false, agentName: name, agentId: `agent_${name}`,
    });
    for (const tmux of ['worker:0.0', `${name}:0.0`]) {
      await request(context.app).patch(`/api/agents/${name}`).set(auth()).send({ tmux }).expect(200);
      expect((await stop(name).expect(403)).body).toMatchObject({ stopped: false, code: 'unmanaged_session' });
      expect(controller.signal.aborted).toBe(false);
      expect(context.internals.routerStoreForTest.listAgentDispatches(`agent_${name}`)[0].state).toBe('started');
    }
    expect(host.killed).toEqual([]);
  });

  test('provisioned thread Stop waits for real guardian cleanup before confirming termination', async () => {
    const name = await provisionThreadAgent();
    const dispatch = queue(name);
    const router = context.internals.routerStoreForTest;
    const runners = context.internals.liveThreadSessionRunnersForTest;
    const capability = router.claimDispatch({ runnerId: 'real-guardian-fixture', leaseMs: 60000, capabilityTtlMs: 60000, maxLiveRunners: 8 });
    expect(capability.ok).toBe(true);
    const shutdownLog = path.join(context.runtimeDir, 'shutdown.log');
    const releaseFile = path.join(context.runtimeDir, 'release-shutdown');
    const toolTree = path.join(context.runtimeDir, 'detached-tool');
    const runner = { controller: new AbortController(), cleanupConfirmed: false, agentName: name, agentId: `agent_${name}` };
    runner.running = runCodexDispatch({ router, claim: capability, cwd: process.cwd(),
      executable: path.resolve('tests/fixtures/fake-codex-app-server.mjs'),
      env: { FAKE_CODEX_SHUTDOWN_LOG: shutdownLog, FAKE_CODEX_SHUTDOWN_RELEASE: releaseFile,
        FAKE_CODEX_TOOL_TREE: toolTree },
      signal: runner.controller.signal, approvalTimeoutMs: 60000, maxParkedRunners: 4,
      requestOwnerApproval: () => new Promise(() => {}),
      onCleanup: (confirmed) => { runner.cleanupConfirmed = confirmed; },
    }).catch(() => {}).finally(() => runners.delete(dispatch.dispatchId));
    runners.set(dispatch.dispatchId, runner);
    try {
      await vi.waitFor(() => expect(router.listAgentDispatches(`agent_${name}`)[0]?.state).toBe('parked'));
      const { toolPid, intermediatePid } = JSON.parse(readFileSync(`${toolTree}.json`, 'utf8'));
      expect(() => process.kill(toolPid, 0)).not.toThrow();
      let finished = false;
      const response = stop(name).then((result) => { finished = true; return result; });
      await vi.waitFor(() => expect(existsSync(shutdownLog)).toBe(true));
      const pid = Number(readFileSync(shutdownLog, 'utf8').split('\n')[0]);
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(finished).toBe(false);
      expect(runner.cleanupConfirmed).toBe(false);
      writeFileSync(releaseFile, 'finish');
      expect(await response).toMatchObject({ status: 200, body: { stopped: true, sessionKilled: false } });
      expect(runner.cleanupConfirmed).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
      // An orphaned zombie is already unable to execute; hosts differ in how
      // promptly PID 1 reaps it. Confirmation must still precede the response.
      expect(processExecuting(toolPid)).toBe(false);
      expect(processExecuting(intermediatePid)).toBe(false);
      expect(existsSync(`${toolTree}.term`)).toBe(true);
      const finalToolWrite = readFileSync(`${toolTree}.writing`, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readFileSync(`${toolTree}.writing`, 'utf8')).toBe(finalToolWrite);
      expect(existsSync(`${toolTree}.finished`)).toBe(false);
      expect(readFileSync(shutdownLog, 'utf8')).toContain('last write');
      expect(router.inspectWorkspace(`workspace-${name}`).dirty).toBe(true);
      expect(host.killed).toEqual([]);
      expect(host.sessions.has(name)).toBe(true);
    } finally {
      writeFileSync(releaseFile, 'finish');
      runner.controller.abort();
      await runner.running;
      if (existsSync(`${toolTree}.json`)) {
        for (const pid of Object.values(JSON.parse(readFileSync(`${toolTree}.json`, 'utf8')))) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ }
        }
      }
    }
  });

  test.each(['unowned', 'settled-without-proof'])('provisioned thread agent stop preserves the termination fence (%s)', async (kind) => {
    const name = await provisionThreadAgent();
    const dispatch = queue(name); claim();
    const runners = context.internals.liveThreadSessionRunnersForTest;
    let controller;
    if (kind === 'settled-without-proof') {
      controller = new AbortController();
      runners.set(dispatch.dispatchId, { controller, running: Promise.resolve(), cleanupConfirmed: false,
        agentName: name, agentId: `agent_${name}` });
    }
    expect((await stop(name).expect(503)).body).toMatchObject({ stopped: false, code: 'stop_unconfirmed' });
    if (controller) expect(controller.signal.aborted).toBe(true);
    expect((await stop(name).expect(503)).body.stopped).toBe(false);
    await request(context.app).post(`/api/agents/${name}/start`).set(auth()).expect(409);
    expect(context.internals.routerStoreForTest.inspectWorkspace(`workspace-${name}`).dirty).toBe(true);
    expect(host.killed).toEqual([]);
  });

  test('queued work is cancelled only for the stopped agent', async () => {
    const own = queue(); const other = queue('other');
    expect((await stop().expect(200)).body.cancelledDispatches).toEqual([own.dispatchId]);
    const snapshot = context.internals.routerStoreForTest.snapshot();
    expect(snapshot.dispatches.find((row) => row.dispatchId === own.dispatchId).state).toBe('cancelled_before_start');
    expect(snapshot.dispatches.find((row) => row.dispatchId === other.dispatchId).state).toBe('queued');
  });

  test('started runner stop awaits owned cleanup and preserves uncertain workspace outcome', async () => {
    const dispatch = queue(); claim();
    const runners = context.internals.liveThreadSessionRunnersForTest;
    const controller = new AbortController();
    let finish;
    const running = new Promise((resolve) => { finish = resolve; }).finally(() => runners.delete(dispatch.dispatchId));
    const runner = { controller, running, cleanupConfirmed: false };
    runners.set(dispatch.dispatchId, runner);
    let responseFinished = false;
    const response = stop().then((result) => { responseFinished = true; return result; });
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
    expect(responseFinished).toBe(false);
    await request(context.app).post('/api/agents/worker/start').set(auth()).expect(409);
    await request(context.app).post('/api/agents').set('X-Agent-Token', 'worker-test-token')
      .send({ name: 'worker', tmux: 'worker:0.0', online: true }).expect(409);
    await request(context.app).patch('/api/agents/worker').set('X-Agent-Token', 'worker-test-token')
      .send({ online: true, manualDown: false }).expect(409);
    expect((await agent()).body.manualDown).toBe(true);
    expect(launch.count).toBe(0);
    runner.cleanupConfirmed = true;
    finish();
    expect((await response).body.stopped).toBe(true);
    const snapshot = context.internals.routerStoreForTest.snapshot();
    expect(snapshot.dispatches[0]).toMatchObject({ state: 'outcome_unknown', terminalReason: 'operator_stopped_agent' });
    expect(snapshot.resources[0].dirty).toBe(true);
  });

  test('unowned claimed process cannot become stopped merely by retrying after cancellation', async () => {
    queue(); claim();
    expect((await stop().expect(503)).body.stopped).toBe(false);
    await request(context.app).post('/api/agents/worker/start').set(auth()).expect(409);
    expect((await stop().expect(503)).body.stopped).toBe(false);
    expect(context.internals.routerStoreForTest.snapshot().dispatches[0].state).toBe('outcome_unknown');
  });

  test('a settled owned runner without cleanup proof remains fenced across stop retries', async () => {
    const dispatch = queue(); claim();
    const runners = context.internals.liveThreadSessionRunnersForTest;
    const controller = new AbortController();
    let finish;
    const running = new Promise((resolve) => { finish = resolve; }).finally(() => runners.delete(dispatch.dispatchId));
    runners.set(dispatch.dispatchId, { controller, running, cleanupConfirmed: false });
    const response = stop().then((result) => result);
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
    finish();
    expect(await response).toMatchObject({ status: 503, body: { stopped: false, code: 'stop_unconfirmed' } });
    expect((await stop().expect(503)).body.stopped).toBe(false);
    await request(context.app).post('/api/agents/worker/start').set(auth()).expect(409);
    expect(context.internals.routerStoreForTest.inspectWorkspace('workspace-worker').dirty).toBe(true);
  });

  test('stop awaits owned cleanup after another cancellation already settled the dispatch', async () => {
    const dispatch = queue(); claim();
    const router = context.internals.routerStoreForTest;
    const runners = context.internals.liveThreadSessionRunnersForTest;
    const controller = new AbortController();
    let finish;
    const running = new Promise((resolve) => { finish = resolve; }).finally(() => runners.delete(dispatch.dispatchId));
    const runner = { controller, running, cleanupConfirmed: false, agentName: 'worker', agentId: 'agent_worker' };
    runners.set(dispatch.dispatchId, runner);
    expect(router.markOutcomeUnknown(dispatch.dispatchId, 'earlier_operator_cancellation').ok).toBe(true);
    expect(router.listAgentDispatches('agent_worker')).toEqual([]);
    let finished = false;
    const response = stop().then((result) => { finished = true; return result; });
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
    expect(finished).toBe(false);
    runner.cleanupConfirmed = true;
    finish();
    expect(await response).toMatchObject({ status: 200, body: { stopped: true } });
    expect(router.inspectWorkspace('workspace-worker').dirty).toBe(true);
  });

  test('authenticated workspace outcome resolution does not prove unowned runner termination', async () => {
    const dispatch = queue(); claim();
    const router = context.internals.routerStoreForTest;
    expect((await stop().expect(503)).body.stopped).toBe(false);
    await request(context.app).post('/api/agents/worker/start').set(auth()).expect(409);
    const inspected = await request(context.app)
      .post(`/api/router/dispatches/${dispatch.dispatchId}/outcome-inspection`).set(auth()).expect(201);
    const resolved = await request(context.app)
      .post(`/api/router/dispatches/${dispatch.dispatchId}/resolve-outcome`).set(auth()).send({
        inspection_id: inspected.body.inspection.inspectionId,
        inspection_token: inspected.body.inspection.inspectionToken,
        request_id: 'stop-workspace-resolution',
        action: 'continue',
        operator_note: 'Workspace changes were inspected; process termination has not been established.',
        recovery_instruction: 'Continue from the inspected workspace after the host confirms process cleanup.',
      }).expect(201);
    expect(resolved.body.resolution).toMatchObject({ dispatchId: dispatch.dispatchId, action: 'continue' });
    expect(router.inspectWorkspace('workspace-worker').dirty).toBe(false);
    expect(router.snapshot().dispatches.find((row) => row.dispatchId === dispatch.dispatchId))
      .toMatchObject({ state: 'outcome_unknown', resolutionAction: 'continue' });
    expect((await stop().expect(503)).body).toMatchObject({ stopped: false, code: 'stop_unconfirmed' });
    await request(context.app).post('/api/agents/worker/start').set(auth()).expect(409);
    await request(context.app).patch('/api/agents/worker').set(auth())
      .send({ online: true, manualDown: false }).expect(409);
    expect((await agent()).body.manualDown).toBe(true);
    expect(launch.count).toBe(0);
  });

  test('stop cannot race a detached launcher before its session is created', async () => {
    await request(context.app).post('/api/agents/other/start').set(auth()).expect(200);
    expect((await stop('other').expect(409)).body.stopped).toBe(false);
    host.sessions.add('other');
    launch.child.emit('exit', 0, null);
    expect((await stop('other').expect(200)).body).toMatchObject({ stopped: true, sessionKilled: true });
  });

  test('runtime projection follows queued started and parked dispatches rather than tmux telemetry', async () => {
    // This is the disposable-runner projection. Hybrid agents retain their
    // terminal telemetry and expose dispatchActivity independently.
    const threadAgent = () => request(context.app).get('/api/agents/other').set(auth());
    queue('other');
    expect((await threadAgent()).body).toMatchObject({ transport: 'thread-session', state: 'queued', activeNow: false, online: false, activeDurationSec: null });
    const capability = claim();
    expect((await threadAgent()).body).toMatchObject({ transport: 'thread-session', state: 'running', activeNow: true, online: true, healthy: true });
    const parked = context.internals.routerStoreForTest.parkForApproval({
      ...capability, approvalId: 'fixture-approval', operationDigest: 'a'.repeat(64),
      ttlMs: 60000, maxParkedRunners: 4,
    });
    expect(parked.ok).toBe(true);
    expect((await threadAgent()).body).toMatchObject({ state: 'waiting_approval', activeNow: false, online: true, blocked: true, activeDurationSec: null, idleDurationSec: null });
  });
});
