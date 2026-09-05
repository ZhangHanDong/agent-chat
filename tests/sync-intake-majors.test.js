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
    bridge.actingSideFor = () => ({ side: { apiBaseUrl: 'https://hs.example' }, credential: { asToken: 'as', senderLocalpart: 'hafleet' } });
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge.postWarning = vi.fn();
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
    bridge.actingSideFor = () => ({ side: { apiBaseUrl: 'https://hs.example' }, credential: { asToken: 'as', senderLocalpart: 'hafleet' } });
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
