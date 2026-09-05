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
