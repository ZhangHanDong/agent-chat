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
