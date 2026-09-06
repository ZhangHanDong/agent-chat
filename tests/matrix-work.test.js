import { expect, test } from 'vitest';
import { createMatrixWorkStore, awaitMatrixWork } from '../lib/matrix-work-store.js';
import { executeMatrixWork } from '../lib/matrix-work-executor.js';

test('a lost registration acknowledgement reuses the durable credential after bridge restart', async () => {
  let clock = 1000;
  let disk = '[]';
  let credentialDisk = '{}';
  const open = () => createMatrixWorkStore({ now: () => clock, load: () => JSON.parse(disk), persist: (rows) => { disk = JSON.stringify(rows); } });
  const accessors = () => ({
    readCredential: (name) => JSON.parse(credentialDisk)[name],
    saveCredential: (name, value) => { credentialDisk = JSON.stringify({ ...JSON.parse(credentialDisk), [name]: value }); },
  });
  const config = { side: { apiBaseUrl: 'https://side.test', serverName: 'side.test' },
    credential: { kind: 'registrationToken', registrationToken: 'fixture-registration' } };
  let registrations = 0;
  const fetchImpl = async () => {
    registrations++;
    return new Response(JSON.stringify({ user_id: '@ac_new:side.test', access_token: 'fixture-private' }), { status: 200 });
  };
  let store = open();
  const row = store.enqueue({ action: 'identity', agent: 'new', sideId: 'side.test', localpart: 'ac_new' });
  const first = store.claim();
  expect(await executeMatrixWork({ ...first, ...config }, { ...accessors(), fetchImpl })).toMatchObject({ ok: true });
  // Model a lost completion POST followed by both processes restarting.
  store = open();
  expect(store.claim()).toBeNull();
  clock += 90_001;
  const retry = store.claim();
  const outcome = await executeMatrixWork({ ...retry, ...config }, { ...accessors(), fetchImpl });
  store.complete(row.id, retry.claimToken, { ...outcome, accessToken: 'must-not-persist' });
  expect(registrations).toBe(1);
  expect(await awaitMatrixWork(store, row.id)).toMatchObject({ ok: true, mxid: '@ac_new:side.test' });
  expect(() => store.complete(row.id, first.claimToken, outcome)).toThrow('stale');
  expect(disk).not.toMatch(/fixture-private|fixture-registration|must-not-persist/);
});

test('Matrix work refuses a credential from another homeserver before sending it', async () => {
  let calls = 0;
  const result = await executeMatrixWork({ action: 'join', agent: 'a', roomId: '!r:side.test', mxid: '@ac_a:side.test',
    side: { apiBaseUrl: 'https://side.test', serverName: 'side.test' } }, {
    readCredential: () => ({ homeserver: 'https://foreign.test', serverName: 'foreign.test', accessToken: 'private' }),
    saveCredential: () => { throw new Error('must not write'); }, fetchImpl: async () => { calls++; },
  });
  expect(result).toEqual({ ok: false, code: 'credential_side_mismatch' });
  expect(calls).toBe(0);
});

test('failed Matrix work persistence rolls back claims and never hides pending work', async () => {
  let fail = false;
  const store = createMatrixWorkStore({ load: () => [], persist: () => !fail });
  const row = store.enqueue({ action: 'leave', agent: 'a', sideId: 'side.test', roomId: '!r:side.test' });
  fail = true;
  expect(() => store.claim()).toThrow('persistence');
  expect(store.get(row.id).state).toBe('pending');
  expect(store.unsettled('side.test')).toBe(true);
  fail = false;
  const claim = store.claim();
  fail = true;
  expect(() => store.complete(row.id, claim.claimToken, { ok: true })).toThrow('persistence');
  expect(store.get(row.id).state).toBe('running');
});

test('a Matrix work timeout preserves the original command for retry', async () => {
  const store = createMatrixWorkStore({ load: () => [], persist: () => true });
  const command = { action: 'join', agent: 'a', sideId: 'side.test', roomId: '!r:side.test' };
  const row = store.enqueue(command);
  await expect(awaitMatrixWork(store, row.id, { timeoutMs: 1 })).rejects.toThrow('pending');
  expect(store.enqueue(command).id).toBe(row.id);
  expect(store.unsettled('side.test')).toBe(true);
});

test('a mismatched minted identity retains its credential for recovery without registering again', async () => {
  let stored;
  let registrations = 0;
  const job = { action: 'identity', agent: 'new', localpart: 'ac_new', sideId: 'side.test',
    side: { apiBaseUrl: 'https://side.test', serverName: 'side.test' },
    credential: { kind: 'registrationToken', registrationToken: 'fixture' } };
  const operations = { readCredential: () => stored, saveCredential: (_name, record) => { stored = record; },
    fetchImpl: async () => {
      registrations++;
      return new Response(JSON.stringify({ user_id: '@Unexpected:side.test', access_token: 'recovery-token' }), { status: 200 });
    } };
  expect(await executeMatrixWork(job, operations)).toEqual({ ok: false, code: 'identity_mismatch' });
  expect(stored.accessToken).toBe('recovery-token');
  expect(await executeMatrixWork(job, operations)).toEqual({ ok: false, code: 'identity_mismatch' });
  expect(registrations).toBe(1);
});
