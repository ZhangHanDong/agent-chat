import { expect, test } from 'vitest';
import { createMatrixWorkStore, awaitMatrixWork } from '../lib/matrix-work-store.js';
import { executeMatrixWork } from '../lib/matrix-work-executor.js';
import { createEngagementStore } from '../lib/engagement-store.js';

test('permanently rejected approval notices settle as failures and are not retried', async () => {
  const store = createMatrixWorkStore({ load: () => [], persist: () => true });
  const row = store.enqueue({ action: 'engagement-approved', agent: 'worker', sideId: 'test', roomId: '!room:test', engagementId: 'engagement', content: { body: 'approved' } });
  const claim = store.claim();
  const outcome = await executeMatrixWork({ ...claim, side: { apiBaseUrl: 'https://matrix.test', serverName: 'test' },
    credential: { kind: 'registrationToken', representativeToken: 'fixture-token' } }, {
    fetchImpl: async () => Response.json({ errcode: 'M_FORBIDDEN' }, { status: 403 }),
  });
  expect(outcome).toMatchObject({ ok: false, permanent: true });
  expect(store.complete(row.id, claim.claimToken, outcome)).toMatchObject({ state: 'complete', outcome: { ok: false } });
  expect(store.claim()).toBeNull(); expect(store.unsettled('test')).toBe(false);
});

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

test('approval notification intent commits atomically with allocation', () => {
  let fail = true;
  let disk;
  const store = createEngagementStore({ load: () => ({ engagements: { en: {
    id: 'en', state: 'pending', requestedTokens: 1000, allocatedTokens: null,
  } } }), persist: value => { if (fail) return false; disk = JSON.stringify(value); return true; } });
  const approve = () => store.decide({ engagementId: 'en', approve: true, allocatedTokens: 1000,
    remainingTokens: 1000, notify: true });
  expect(approve).toThrow();
  expect(store.get('en')).toMatchObject({ state: 'pending', allocatedTokens: null });
  expect(store.get('en').approvalNotice).toBeUndefined();
  fail = false;
  expect(approve()).toMatchObject({ state: 'active', allocatedTokens: 1000, approvalNotice: { state: 'pending' } });
  const recovered = createEngagementStore({ load: () => JSON.parse(disk) });
  expect(recovered.get('en')).toMatchObject({ state: 'active', allocatedTokens: 1000, approvalNotice: { state: 'pending' } });
});

test('approval notices retain one transaction through failed delivery and lost acknowledgement', async () => {
  let clock = 1000;
  let disk = '[]';
  const open = () => createMatrixWorkStore({ now: () => clock, load: () => JSON.parse(disk),
    persist: rows => { disk = JSON.stringify(rows); } });
  let store = open();
  const command = { action: 'engagement-approved', agent: 'new', sideId: 'side.test',
    roomId: '!project:side.test', engagementId: 'en-first',
    content: { msgtype: 'm.notice', body: 'Approved coding for 1000 tokens. Agent: @ac_new:side.test' } };
  const row = store.enqueue(command);
  const config = { side: { apiBaseUrl: 'https://side.test', serverName: 'side.test' },
    credential: { kind: 'registrationToken', representativeToken: 'private-representative' } };
  const seen = [];
  const operations = { readCredential: () => { throw new Error('must send as representative'); },
    saveCredential: () => { throw new Error('must not register'); },
    fetchImpl: async (url, options) => {
      seen.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization });
      return new Response(JSON.stringify(seen.length === 1 ? { errcode: 'M_UNKNOWN' } : { event_id: '$approved' }),
        { status: seen.length === 1 ? 503 : 200 });
    } };
  const first = store.claim();
  store.complete(row.id, first.claimToken, await executeMatrixWork({ ...first, ...config }, operations));
  expect(store.get(row.id).state).toBe('pending');
  expect(store.claim()).toBeNull();
  clock += 30_001;
  const retry = store.claim();
  expect(await executeMatrixWork({ ...retry, ...config }, operations)).toMatchObject({ ok: true, eventId: '$approved' });
  store = open(); // Matrix accepted the send; the bridge acknowledgement was lost.
  clock += 90_001;
  const recovered = store.claim();
  const result = await executeMatrixWork({ ...recovered, ...config }, operations);
  store.complete(row.id, recovered.claimToken, { ...result, accessToken: 'must-not-persist' });
  expect(store.get(row.id)).toMatchObject({ state: 'complete', outcome: { ok: true, eventId: '$approved' } });
  expect(store.enqueue(command).id).toBe(row.id);
  expect(store.claim()).toBeNull();
  expect(seen).toHaveLength(3);
  expect(new Set(seen.map(s => s.url)).size).toBe(1);
  expect(seen.every(s => s.auth === 'Bearer private-representative')).toBe(true);
  expect(seen.every(s => JSON.stringify(s.body) === JSON.stringify(command.content))).toBe(true);
  expect(disk).not.toMatch(/private-representative|must-not-persist/);
});

test('approval notices use the appservice representative and reject a foreign room before HTTP', async () => {
  const calls = [];
  const job = { action: 'engagement-approved', agent: 'new', roomId: '!project:side.test', engagementId: 'en',
    content: { msgtype: 'm.notice', body: 'Approved' },
    side: { apiBaseUrl: 'https://side.test', serverName: 'side.test', representative: { mxid: '@desk:side.test' } },
    credential: { kind: 'appservice', asToken: 'private-as', senderLocalpart: 'desk' } };
  const operations = { readCredential: () => { throw new Error('wrong identity'); }, saveCredential: () => {},
    fetchImpl: async (url, options) => { calls.push({ url: new URL(url), options });
      return new Response(JSON.stringify({ event_id: '$notice' }), { status: 200 }); } };
  expect(await executeMatrixWork(job, operations)).toMatchObject({ ok: true, eventId: '$notice' });
  expect(calls[0].url.searchParams.get('user_id')).toBe('@desk:side.test');
  expect(calls[0].options.headers.Authorization).toBe('Bearer private-as');
  expect(await executeMatrixWork({ ...job, roomId: '!elsewhere:foreign.test' }, operations)).toMatchObject({ ok: false });
  expect(calls).toHaveLength(1);
});

test('an approval notice without a Matrix event receipt remains retryable', () => {
  const store = createMatrixWorkStore({ load: () => [], persist: () => true });
  const row = store.enqueue({ action: 'engagement-approved', agent: 'new', sideId: 'side.test', engagementId: 'en' });
  const claim = store.claim();
  expect(store.complete(row.id, claim.claimToken, { ok: true, eventId: { fake: true } })).toMatchObject({
    state: 'pending', lastError: 'delivery_unconfirmed',
  });
});
