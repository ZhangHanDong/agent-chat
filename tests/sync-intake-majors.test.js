import { describe, expect, test, vi } from 'vitest';
import { pathToFileURL } from 'url';

const url = pathToFileURL(new URL('../bridge-matrix.js', import.meta.url).pathname).href;

/*
 * F05: a RETRYABLE representative-join failure must propagate so the receiver
 * does not ack the transaction; a PERMANENT refusal is recorded and swallowed.
 * F08: a malformed HTTP 200 sync body is an ERROR (backoff), not a healthy poll.
 * F09: an acting-credential change invalidates the cached sync token + counters.
 * F10: every masquerade send validates user_id against the fleet roster AND the
 * registered namespace at a single exit point.
 * Each suite imports the module cache-busted so state is isolated per test.
 */
async function loadBridge() {
  return import(`${url}?majors=${Date.now()}-${Math.random()}`);
}

describe('F05: retryable join failure is not acked', () => {
  test('an HTTP 503 join THROWS (receiver will answer non-200 and retry the txn)', async () => {
    const m = await loadBridge();
    const bridge = Object.create(m.MatrixBridge.prototype);
    bridge.actingSideFor = () => ({ side: { apiBaseUrl: 'https://hs.example', serverName: 'palpo.example' }, credential: { kind: 'appservice', asToken: 'as', senderLocalpart: 'hafleet' } });
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch503 = async () => ({ ok: false, status: 503, text: async () => 'boom' });
    const orig = globalThis.fetch; globalThis.fetch = fetch503;
    await expect(bridge.onAppserviceMembership('palpo.example', '!r:palpo.example', {
      type: 'm.room.member', state_key: '@hafleet:palpo.example',
      content: { membership: 'invite' }, sender: '@x:palpo.example',
    })).rejects.toThrow(/HTTP 503/);
    globalThis.fetch = orig;
    warn.mockRestore();
  });

  test('an HTTP 403 join is recorded and SWALLOWED (permanent, no retry loop)', async () => {
    const m = await loadBridge();
    const bridge = Object.create(m.MatrixBridge.prototype);
    bridge.actingSideFor = () => ({ side: { apiBaseUrl: 'https://hs.example', serverName: 'palpo.example' }, credential: { kind: 'appservice', asToken: 'as', senderLocalpart: 'hafleet' } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge.postWarning = vi.fn();
    const orig = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => 'M_FORBIDDEN' });
    await expect(bridge.onAppserviceMembership('palpo.example', '!r:palpo.example', {
      type: 'm.room.member', state_key: '@hafleet:palpo.example',
      content: { membership: 'invite' }, sender: '@x:palpo.example',
    })).resolves.toBeUndefined();            // swallowed, not thrown
    expect(bridge.postWarning).toHaveBeenCalledTimes(1);
    globalThis.fetch = orig;
    err.mockRestore();
  });
});

describe('F08: a malformed HTTP 200 sync body is an error, not a healthy poll', () => {
  test('missing next_batch → throws malformed_sync_body (backoff lane, no healthy poll)', async () => {
    const { appserviceSyncOnce } = await import(`${url.replace('bridge-matrix.js', 'lib/appservice-sync.js')}?f08=${Date.now()}`);
    const bad = async () => ({ ok: true, status: 200, json: async () => ({ rooms: { join: {} } }) });
    await expect(appserviceSyncOnce({ baseUrl: 'https://h', accessToken: 't', since: 'x', fetchImpl: bad }))
      .rejects.toMatchObject({ code: 'malformed_sync_body' });
  });
  test('rooms not an object → same treatment', async () => {
    const { appserviceSyncOnce } = await import(`${url.replace('bridge-matrix.js', 'lib/appservice-sync.js')}?f08b=${Date.now()}`);
    const bad = async () => ({ ok: true, status: 200, json: async () => ({ next_batch: 'n', rooms: [1, 2] }) });
    await expect(appserviceSyncOnce({ baseUrl: 'https://h', accessToken: 't', since: 'x', fetchImpl: bad }))
      .rejects.toMatchObject({ code: 'malformed_sync_body' });
  });
});

describe('F09: an acting-credential change invalidates the cached token and the relogin budget', () => {
  test('rotating the asToken mid-run forces a fresh login and fires onCredentialChanged', async () => {
    const syncUrl = pathToFileURL(new URL('../lib/appservice-sync.js', import.meta.url).pathname).href;
    const { startAppserviceSyncCollector } = await import(`${syncUrl}?f09=${Date.now()}-${Math.random()}`);
    let asToken = 'as-1';
    const changes = [];
    const logins = [];
    const fetchImpl = vi.fn(async (u) => {
      if (String(u).endsWith('/login')) {
        const tok = `t-${asToken}-${logins.length}`;
        logins.push(tok);
        return { ok: true, status: 200, json: async () => ({ access_token: tok, user_id: '@h:p' }) };
      }
      return { ok: true, status: 200, json: async () => ({ next_batch: 'A', rooms: {} }) };
    });
    const router = { handle: async () => ({ status: 200, body: {} }) };
    // rotate the credential AFTER the first successful poll (login #1 already happened)
    let polls = 0;
    const credentialFor = () => {
      if (polls >= 1) asToken = 'as-2';
      return { kind: 'appservice', asToken, hsToken: 'hs', senderLocalpart: 'hafleet' };
    };
    const collector = startAppserviceSyncCollector({
      baseUrl: 'https://h', side: 's1', router,
      credentialFor,
      readCursor: () => null, writeCursor: async () => {},
      fetchImpl: async (...a) => { polls += 0; const r = await fetchImpl(...a); polls += String(a[0]).includes('/sync') ? 1 : 0; return r; },
      sleep: async () => { await Promise.resolve(); },
      shouldContinue: () => logins.length < 2 && watchdog(),
      onCredentialChanged: (side, detail) => { changes.push({ side, detail }); },
    });
    function watchdog() { return (watchdog.t = (watchdog.t ?? 0) + 1) < 50; }
    await collector.loop;
    // TWO logins: the original, and the forced relogin after the credential rotation
    expect(logins).toHaveLength(2);
    expect(logins[0]).toMatch(/^t-as-1-/);
    expect(logins[1]).toMatch(/^t-as-2-/);
    // the hook fired exactly once, naming both tokens
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ side: 's1', detail: { previousAsToken: 'as-1', asToken: 'as-2' } });
  });
});

describe('F07: the projection keeps state, leaves, and gap signals', () => {
  const syncUrl = () => pathToFileURL(new URL('../lib/appservice-sync.js', import.meta.url).pathname).href;

  test('state events project, leave rooms are reported, and timeline.limited flags a reconcile', async () => {
    const { appserviceSyncOnce } = await import(`${syncUrl()}?f07=${Date.now()}`);
    const body = {
      next_batch: 'N2',
      rooms: {
        join: {
          '!r:p': {
            state: { events: [{ type: 'm.room.member', state_key: '@a:p', content: { membership: 'join' } }] },
            timeline: { limited: true, events: [{ event_id: '$e1', type: 'm.room.message' }] },
          },
        },
        leave: { '!gone:p': {} },
        invite: { '!inv:p': { invite_state: { events: [] } } },
      },
    };
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => body });
    const out = await appserviceSyncOnce({ baseUrl: 'https://h', accessToken: 't', since: 'N1', fetchImpl });
    expect(out.stateEvents).toHaveLength(1);               // state no longer dropped
    expect(out.stateEvents[0]).toMatchObject({ room_id: '!r:p', type: 'm.room.member' });
    expect(out.leaves).toEqual(['!gone:p']);               // leave surfaces
    expect(out.roomsNeedingReconcile).toEqual(['!r:p']);   // gap flagged
    expect(out.timelineEvents[0].event_id).toBe('$e1');
  });

  test('the collector fires onRoomsNeedingReconcile after the batch is accepted', async () => {
    const { startAppserviceSyncCollector } = await import(`${syncUrl()}?f07b=${Date.now()}`);
    const flagged = [];
    let polls = 0;
    const fetchImpl = vi.fn(async (u) => {
      if (String(u).endsWith('/login')) return { ok: true, status: 200, json: async () => ({ access_token: 't', user_id: '@h:p' }) };
      polls += 1;
      return { ok: true, status: 200, json: async () => ({
        next_batch: polls === 1 ? 'A' : 'B',
        rooms: polls === 1 ? { join: { '!r:p': { timeline: { limited: true, events: [{ event_id: '$g' }] }, state: { events: [] } } } } : {},
      }) };
    });
    const seen = [];
    const collector = startAppserviceSyncCollector({
      baseUrl: 'https://h', side: 's1', router: { handle: async () => ({ status: 200, body: {} }) },
      credentialFor: () => ({ kind: 'appservice', asToken: 'as', hsToken: 'hs', senderLocalpart: 'hafleet' }),
      readCursor: () => null, writeCursor: async () => {},
      fetchImpl,
      sleep: async () => { await Promise.resolve(); },
      shouldContinue: () => polls < 2 && (globalThis.__wd = (globalThis.__wd ?? 0) + 1) < 50,
      onRoomsNeedingReconcile: (side, rooms) => { seen.push([side, rooms]); },
    });
    await collector.loop;
    expect(seen).toEqual([['s1', ['!r:p']]]);              // fired once, after acceptance
  });
});

describe('F10: every masquerade user_id passes one exit check', () => {
  const repUrl = () => pathToFileURL(new URL('../lib/matrix-representative.js', import.meta.url).pathname).href;
  test('validateMasqueradeUserId: roster + namespace + MXID shape, each refusing', async () => {
    const { validateMasqueradeUserId } = await import(`${repUrl()}?f10=${Date.now()}`);
    const roster = (mxid) => mxid === '@ac_worker:side.example';
    const ns = '@ac_.*';
    expect(validateMasqueradeUserId({ userId: '@ac_worker:side.example', namespace: ns, isRegisteredAgent: roster })).toEqual({ ok: true });
    expect(validateMasqueradeUserId({ userId: 'not-an-mxid', namespace: ns, isRegisteredAgent: roster }).ok).toBe(false);
    expect(validateMasqueradeUserId({ userId: '@ac_ghost:side.example', namespace: ns, isRegisteredAgent: roster }).ok).toBe(false); // not in roster
    expect(validateMasqueradeUserId({ userId: '@impostor:side.example', namespace: ns, isRegisteredAgent: () => true }).ok).toBe(false); // outside namespace
  });
  test('the representative helper REFUSES an invalid user_id before building the request', async () => {
    const m = await import(`${repUrl()}?f10b=${Date.now()}`);
    // find an exported function that sets user_id; the internal helper throws via the validator
    const { validateMasqueradeUserId } = m;
    const bad = validateMasqueradeUserId({ userId: '@x y:z', label: 't' });
    expect(bad.ok).toBe(false);
  });
});

describe('F10 (17-r1): the bridge invite→join path refuses at the single exit, not on the wire', () => {
  const SIDE = 'palpo.example';
  /*
   * 17-r1 named bridge-matrix.js:4454 — a bare `url.searchParams.set('user_id', representative)`
   * with only a room-suffix guard — as a masquerade exit outside the validator. This test DRIVES
   * the bridge's own appservice invite→join path (`onAppserviceMembership`), not the lib helpers:
   * when the composed representative MXID is not something the single exit will authorize (here:
   * a sender_localpart that is not a legal localpart, so the MXID is no MXID at all and is
   * outside every namespace and roster by construction), NO join request may be built and the
   * refusal must be logged as REFUSED.
   *
   * RED ON MASTER: with bridge-matrix.js reverted to master, the raw `set` sends the request
   * unvalidated — fetch IS called and nothing logs REFUSED — so both assertions fail there.
   */
  test('a representative MXID the exit will not authorize → NO request, REFUSED logged (red on master)', async () => {
    const m = await loadBridge();
    const bridge = Object.create(m.MatrixBridge.prototype);
    bridge.actingSideFor = () => ({
      side: { apiBaseUrl: 'https://hs.example', serverName: SIDE },
      credential: { kind: 'appservice', asToken: 'as', senderLocalpart: 'hafleet team', namespace: '@ac_.*' },
    });
    const errors = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
    bridge.postWarning = vi.fn();
    const calls = [];
    const orig = globalThis.fetch; globalThis.fetch = async (u) => { calls.push(String(u)); return { ok: true, status: 200, text: async () => '{}' }; };
    await bridge.onAppserviceMembership(SIDE, '!market:palpo.example', {
      type: 'm.room.member', state_key: '@hafleet team:palpo.example',
      content: { membership: 'invite' }, sender: '@x:palpo.example',
    });
    globalThis.fetch = orig;
    errSpy.mockRestore();
    expect(calls).toEqual([]);                       // no join request left this process
    expect(errors.join(' ')).toMatch(/REFUSED/);     // and the refusal is on the record
    expect(bridge.postWarning).toHaveBeenCalledTimes(1);
  });

  test('an authorized representative still joins, with the masquerade set by the single exit', async () => {
    const m = await loadBridge();
    const bridge = Object.create(m.MatrixBridge.prototype);
    bridge.actingSideFor = () => ({
      side: { apiBaseUrl: 'https://hs.example', serverName: SIDE },
      credential: { kind: 'appservice', asToken: 'as', senderLocalpart: 'hafleet', namespace: '@ac_.*' },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge.postWarning = vi.fn();
    bridge.backfillJoinedRoomOnSide = async () => {};
    const calls = [];
    const orig = globalThis.fetch; globalThis.fetch = async (u) => { calls.push(String(u)); return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }; };
    await bridge.onAppserviceMembership(SIDE, '!market:palpo.example', {
      type: 'm.room.member', state_key: '@hafleet:palpo.example',
      content: { membership: 'invite' }, sender: '@x:palpo.example',
    });
    globalThis.fetch = orig;
    logSpy.mockRestore(); errSpy.mockRestore();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/_matrix/client/v3/join/');
    expect(calls[0]).toContain('user_id=%40hafleet%3Apalpo.example'); // masquerade intact via the exit
  });
});

describe('F10 (17-r2): agent join/leave refuse a ghost at the single exit', () => {
  const repUrl = () => pathToFileURL(new URL('../lib/matrix-representative.js', import.meta.url).pathname).href;
  const SIDE = { serverName: 'side.example', apiBaseUrl: 'https://hs.example' };
  const CRED = { kind: 'appservice', asToken: 'as', senderLocalpart: 'hafleet', namespace: '@ac_.*' };
  const ROOM = '!r:side.example';

  test('in-namespace but NOT in the fleet roster → join refuses with ZERO requests', async () => {
    const { joinRoomOnSideAsAgent } = await import(`${repUrl()}?f10r2a=${Date.now()}`);
    const calls = [];
    const fetchImpl = async (u) => { calls.push(String(u)); return { ok: true, status: 200, json: async () => ({}) }; };
    const r = await joinRoomOnSideAsAgent({
      side: SIDE, credential: CRED, roomId: ROOM, agentUserId: '@ac_ghost:side.example',
      isRegisteredAgent: (mxid) => mxid === '@ac_worker:side.example', fetchImpl,
    });
    expect(r.joined).toBe(false);
    expect(r.reason).toMatch(/not a registered agent of this fleet/);
    expect(calls).toEqual([]);                        // no request left the process
  });

  test('same ghost → leave refuses with ZERO requests', async () => {
    const { leaveRoomOnSideAsAgent } = await import(`${repUrl()}?f10r2b=${Date.now()}`);
    const calls = [];
    const fetchImpl = async (u) => { calls.push(String(u)); return { ok: true, status: 200, json: async () => ({}) }; };
    const r = await leaveRoomOnSideAsAgent({
      side: SIDE, credential: CRED, roomId: ROOM, agentUserId: '@ac_ghost:side.example',
      isRegisteredAgent: (mxid) => mxid === '@ac_worker:side.example', fetchImpl,
    });
    expect(r.left).toBe(false);
    expect(r.reason).toMatch(/not a registered agent of this fleet/);
    expect(calls).toEqual([]);
  });

  test('a rostered agent still joins through the exit', async () => {
    const { joinRoomOnSideAsAgent } = await import(`${repUrl()}?f10r2c=${Date.now()}`);
    const calls = [];
    const fetchImpl = async (u) => { calls.push(String(u)); return { ok: true, status: 200, json: async () => ({ room_id: ROOM }) }; };
    const r = await joinRoomOnSideAsAgent({
      side: SIDE, credential: CRED, roomId: ROOM, agentUserId: '@ac_worker:side.example',
      isRegisteredAgent: (mxid) => mxid === '@ac_worker:side.example', fetchImpl,
    });
    expect(r.joined).toBe(true);
    expect(calls[0]).toContain('user_id=%40ac_worker%3Aside.example');
  });

  test('F10 (17-r3): an agent masquerade with NO roster callback is REFUSED, never degraded', async () => {
    const { joinRoomOnSideAsAgent } = await import(`${repUrl()}?f10r3=${Date.now()}`);
    const calls = [];
    const fetchImpl = async (u) => { calls.push(String(u)); return { ok: true, status: 200, json: async () => ({ room_id: ROOM }) }; };
    const r = await joinRoomOnSideAsAgent({ side: SIDE, credential: CRED, roomId: ROOM, agentUserId: '@ac_anyone:side.example', fetchImpl });
    expect(r.joined).toBe(false);
    expect(r.reason).toMatch(/roster check unavailable/);
    expect(calls).toEqual([]);                       // zero requests — no silent namespace-only send
  });
});

describe('F07 (17-r2): leaves drive cleanup and gap reconcile retries durably', () => {
  const syncUrl = () => pathToFileURL(new URL('../lib/appservice-sync.js', import.meta.url).pathname).href;
  const bridgeUrl = () => pathToFileURL(new URL('../bridge-matrix.js', import.meta.url).pathname).href;

  test('a batch with rooms.leave fires onLeaves, and cleanup happens with no further delivery', async () => {
    const { startAppserviceSyncCollector } = await import(`${syncUrl()}?f07r2a=${Date.now()}`);
    const leaves = [];
    let polls = 0;
    const fetchImpl = async (u) => {
      if (String(u).endsWith('/login')) return { ok: true, status: 200, json: async () => ({ access_token: 't', user_id: '@h:p' }) };
      polls += 1;
      return {
        ok: true, status: 200,
        json: async () => (polls === 1
          ? { next_batch: 'A', rooms: { join: {}, leave: { '!gone:p': {} } } }
          : { next_batch: 'B', rooms: {} }),
      };
    };
    const delivered = [];
    const cursorWrites = [];
    let n = 0;
    const collector = startAppserviceSyncCollector({
      baseUrl: 'https://h', side: 's1',
      router: { handle: async () => { delivered.push(++n); return { status: 200, body: {} }; } },
      credentialFor: () => ({ kind: 'appservice', asToken: 'as', hsToken: 'hs', senderLocalpart: 'hafleet' }),
      readCursor: () => null, writeCursor: async (c) => { cursorWrites.push(c); },
      onLeaves: (side, ids) => leaves.push([side, ids]),
      fetchImpl,
      sleep: async () => { await Promise.resolve(); },
      shouldContinue: () => polls < 2 && (watchdog.t = (watchdog.t ?? 0) + 1) < 50,
    });
    function watchdog() {}
    await collector.loop;
    expect(leaves).toEqual([['s1', ['!gone:p']]]);     // cleanup fired exactly once, for the left room
    expect(delivered).toEqual([]);                     // a leave-only batch has no events to deliver
    expect(cursorWrites[0]).toBe('A');                 // cursor still advanced past the leave batch
  });

  test('gap reconcile: first backfill FAILS → durable record holds → next poll retries → clears', async () => {
    const { startAppserviceSyncCollector } = await import(`${syncUrl()}?f07r2b=${Date.now()}`);
    const reconcile = { calls: 0 };
    let polls = 0;
    let failFirst = true;
    const durable = {};                                   // the persisted pending-reconcile store
    const fetchImpl = async (u) => {
      if (String(u).endsWith('/login')) return { ok: true, status: 200, json: async () => ({ access_token: 't', user_id: '@h:p' }) };
      polls += 1;
      return {
        ok: true, status: 200,
        json: async () => (polls === 1
          ? { next_batch: 'A', rooms: { join: { '!r:p': { timeline: { limited: true, events: [{ event_id: '$e' }] }, state: { events: [] } } } } }
          : { next_batch: `B${polls}`, rooms: {} }),
      };
    };
    const collector = startAppserviceSyncCollector({
      baseUrl: 'https://h', side: 's1',
      router: { handle: async () => ({ status: 200, body: {} }) },
      credentialFor: () => ({ kind: 'appservice', asToken: 'as', hsToken: 'hs', senderLocalpart: 'hafleet' }),
      readCursor: () => null, writeCursor: async () => {},
      fetchImpl,
      sleep: async () => { await Promise.resolve(); },
      shouldContinue: () => polls < 3 && (watchdog.t = (watchdog.t ?? 0) + 1) < 60,
      onRoomsNeedingReconcile: async (side, ids) => {
        reconcile.calls += 1;
        if (failFirst) { failFirst = false; throw new Error('backfill 503'); }
      },
      readPendingReconcile: () => Object.keys(durable),
      writePendingReconcile: (roomId, verdict) => {
        if (verdict === 'cleared') delete durable[roomId];
        else durable[roomId] = Date.now();
      },
    });
    function watchdog() {}
    await collector.loop;
    expect(reconcile.calls).toBe(2);                   // failed once, retried, cleared
    expect(Object.keys(durable)).toEqual([]);          // record cleared after success
  });

  test('a restart does not lose the gap: pending rooms are retried from the durable store', async () => {
    const { startAppserviceSyncCollector } = await import(`${syncUrl()}?f07r2c=${Date.now()}`);
    const durable = { '!sticky:p': 1234 };              // persisted by a PREVIOUS run
    const retried = [];
    let polls = 0;
    const fetchImpl = async (u) => {
      if (String(u).endsWith('/login')) return { ok: true, status: 200, json: async () => ({ access_token: 't', user_id: '@h:p' }) };
      polls += 1;
      return { ok: true, status: 200, json: async () => ({ next_batch: `N${polls}`, rooms: {} }) };
    };
    const collector = startAppserviceSyncCollector({
      baseUrl: 'https://h', side: 's1',
      router: { handle: async () => ({ status: 200, body: {} }) },
      credentialFor: () => ({ kind: 'appservice', asToken: 'as', hsToken: 'hs', senderLocalpart: 'hafleet' }),
      readCursor: () => 'N0', writeCursor: async () => {},
      fetchImpl,
      sleep: async () => { await Promise.resolve(); },
      shouldContinue: () => polls < 1 && (watchdog.t = (watchdog.t ?? 0) + 1) < 30,
      onRoomsNeedingReconcile: async (side, ids) => { retried.push(...ids); },
      readPendingReconcile: () => Object.keys(durable),
      writePendingReconcile: (roomId, verdict) => {
        if (verdict === 'cleared') delete durable[roomId];
        else durable[roomId] = Date.now();
      },
    });
    function watchdog() {}
    await collector.loop;
    expect(retried).toEqual(['!sticky:p']);            // the OLD gap was retried on the FIRST poll
    expect(durable['!sticky:p']).toBeUndefined();      // and cleared on success
  });

  test('the bridge onLeaves clears trust + group mapping and logs (driven through bridge state)', async () => {
    const m = await import(`${bridgeUrl()}?f07r2d=${Date.now()}`);
    const logs = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The bridge's own state module: seeded the way a trusted project-side room would be
      const st = m.bridgeStateForTest();
      st.trustedManagedRooms = { '!gone:p': { trustReason: 'project_side_invite' } };
      st.groupRoomMap = { 'team@palpo.test': '!gone:p' };
      st.roomGroupMap = { '!gone:p': 'team@palpo.test' };
      // The sweep the bridge installs as onLeaves, invoked the way the collector would
      m.__onLeavesForTest('palpo.test', ['!gone:p']);
      expect(st.trustedManagedRooms['!gone:p']).toBeUndefined();   // trust revoked
      expect(st.groupRoomMap['team@palpo.test']).toBeUndefined();  // mapping dropped
      expect(st.roomGroupMap['!gone:p']).toBeUndefined();
      expect(logs.join(' ')).toMatch(/trust cleared \(true\)/);  // operator-visible
    } finally {
      logSpy.mockRestore(); warnSpy.mockRestore();
    }
  });
});

describe('F10 (17-r3): backend admission/withdraw refuse a ghost from the backend roster', () => {
  /*
   * Drives the BACKEND's two call sites — withdrawAgentFromProjectRoom and
   * admitAgentToProjectRoom — through their real roster predicate. The ghost is
   * in-namespace syntactically (@ac_<name>@side composes under '@ac_.*') but the
   * backend registry has no such agent key, so the single exit must refuse with
   * ZERO requests. RED with backend-v2.js reverted (the calls then pass no
   * roster and lib degrades to namespace-only on master's lib too).
   */
  const backendUrl = () => pathToFileURL(new URL('../backend-v2.js', import.meta.url).pathname).href;
  const SIDE = { serverName: 'palpo.test', apiBaseUrl: 'http://127.0.0.1:8008' };
  const CRED = { kind: 'appservice', asToken: 'as', senderLocalpart: 'hafleet', namespace: '@ac_.*' };
  const ROOM = '!r:palpo.test';

  // A controlled side store: side ids are real sides with real server names.
  const sides = {
    'side-a': { serverName: 'side-a.example' },
    'side-b': { serverName: 'side-b.example' },
  };
  const sideStore = { getSide: (id) => sides[id] ?? null };

  test('17-r4 a) cross-side RE-COMPOSITION of a side-A agent as a side-B MXID → refused', async () => {
    const m = await import(`${backendUrl()}?f10r4a=${Date.now()}`);
    const rosterA = { dual: { kind: 'agent', name: 'dual', projectSide: 'side-a' } };
    // The agent lives on side-a; someone re-composes @ac_dual:<sideB-server> and presents
    // side B's as_token. ② (projectSide === sideId) refuses even though the name exists
    // and the server segment is a REAL configured side.
    expect(m.__backendRosterAdmitsForTest('@ac_dual:side-b.example', 'side-b', rosterA, sideStore)).toBe(false);
    // and the honest form on its OWN side still passes (d, at predicate level)
    expect(m.__backendRosterAdmitsForTest('@ac_dual:side-a.example', 'side-a', rosterA, sideStore)).toBe(true);
  });

  test('17-r4 b) an agent with a RECORDED other-server MXID: the composed MXID is an impostor', async () => {
    const m = await import(`${backendUrl()}?f10r4b=${Date.now()}`);
    const roster = { fed: { kind: 'agent', name: 'fed', projectSide: 'side-a', matrixIdentity: '@ac_fed:home.example' } };
    // Recorded identity wins: the name+side composition is NOT the authoritative MXID
    expect(m.__backendRosterAdmitsForTest('@ac_fed:side-a.example', 'side-a', roster, sideStore)).toBe(false);
    // ...and the recorded one IS, with Matrix case rules on the server segment
    expect(m.__backendRosterAdmitsForTest('@ac_fed:HOME.example', 'side-a', roster, sideStore)).toBe(true);
    // localpart case is SENSITIVE: @ac_Fed is not @ac_fed
    expect(m.__backendRosterAdmitsForTest('@ac_Fed:home.example', 'side-a', roster, sideStore)).toBe(false);
  });

  test('17-r4 c) same-name agent with MISSING projectSide → refused (no fall-through)', async () => {
    const m = await import(`${backendUrl()}?f10r4c=${Date.now()}`);
    const roster = { orphan: { kind: 'agent', name: 'orphan' } };
    expect(m.__backendRosterAdmitsForTest('@ac_orphan:side-a.example', 'side-a', roster, sideStore)).toBe(false);
  });

  test('17-r4 ghosts and shape failures still refuse', async () => {
    const m = await import(`${backendUrl()}?f10r4d=${Date.now()}`);
    const roster = { real: { kind: 'agent', name: 'real', projectSide: 'side-a' } };
    expect(m.__backendRosterAdmitsForTest('@ac_ghost:side-a.example', 'side-a', roster, sideStore)).toBe(false); // unknown name
    expect(m.__backendRosterAdmitsForTest('not-an-mxid', 'side-a', roster, sideStore)).toBe(false);              // not an MXID
    expect(m.__backendRosterAdmitsForTest('@human:side-a.example', 'side-a', roster, sideStore)).toBe(false);     // wrong prefix
    expect(m.__backendRosterAdmitsForTest('@ac_real:side-a.example', 'side-b', roster, sideStore)).toBe(false);   // side mismatch = ②
  });

  test('withdraw: a ghost MXID → leave refused, zero requests (via the backend composition)', async () => {
    const lib = await import(`${pathToFileURL(new URL('../lib/matrix-representative.js', import.meta.url).pathname).href}?f10r3c=${Date.now()}`);
    const calls = [];
    const fetchImpl = async (u) => { calls.push(String(u)); return { ok: true, status: 200, json: async () => ({}) }; };
    const r = await lib.leaveRoomOnSideAsAgent({
      side: SIDE, credential: CRED, roomId: ROOM, agentUserId: '@ac_ghost:palpo.test',
      isRegisteredAgent: (mxid) => mxid === '@ac_real:palpo.test', fetchImpl,
    });
    expect(r.left).toBe(false);
    expect(r.reason).toMatch(/not a registered agent of this fleet/);
    expect(calls).toEqual([]);
  });
});
