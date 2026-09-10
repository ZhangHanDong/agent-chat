import { expect, test, vi } from 'vitest';
import { connectFleetCredentialImport, fleetImportSummary, parseFleetCredentialImport } from '../mockup/lib/fleet-credential-import.js';

test('registration JSON import validates fleet server namespace and token scope before save', () => {
  const fleetId = `hf_${'a'.repeat(32)}`;
  const registration = { id: fleetId, url: 'http://host.docker.internal:19094',
    as_token: 'fixture-as-token', hs_token: 'fixture-hs-token', sender_localpart: `${fleetId}_representative`,
    namespaces: { users: [{ exclusive: true, regex: `^@${fleetId}_[a-z0-9_]+:palpo\\.test$` }], rooms: [], aliases: [] } };
  const side = { serverName: 'palpo.test' };
  const envelope = { fleetId, serverName: side.serverName, credentialVersion: 1, registration };
  const parsed = parseFleetCredentialImport(JSON.stringify(envelope), side);
  expect(parsed).toMatchObject({ fleetId, serverName: side.serverName, agentPrefix: `${fleetId}_agent_`,
    credential: { kind: 'appservice', asToken: registration.as_token, hsToken: registration.hs_token,
      namespace: registration.namespaces.users[0].regex, senderLocalpart: registration.sender_localpart, url: registration.url } });
  expect(parseFleetCredentialImport(JSON.stringify(registration), side)).toEqual(parsed);
  expect(() => parseFleetCredentialImport(JSON.stringify(envelope), { serverName: 'other.test' })).toThrow('cr.importWrongServer');
  const mutate = patch => JSON.stringify({ ...envelope, registration: { ...registration, ...patch } });
  for (const bad of [mutate({ hs_token: '' }), mutate({ as_token: registration.hs_token }),
    mutate({ sender_localpart: 'another_fleet_representative' }), mutate({ url: 'javascript:alert(1)' }),
    mutate({ url: 'https://user:password@example.test' }), mutate({ namespaces: { ...registration.namespaces,
      users: [{ exclusive: true, regex: '.*' }] } }),
    mutate({ namespaces: { ...registration.namespaces, rooms: [{ regex: '.*' }] } }),
    JSON.stringify({ ...envelope, credentialVersion: 2 }), JSON.stringify({ ...envelope, fleetId: `hf_${'b'.repeat(32)}` }),
    'not json', ' '.repeat(65537)]) {
    expect(() => parseFleetCredentialImport(bad, side)).toThrow('cr.importInvalid');
  }
});

function wizardFixture() {
  const fleetId = `hf_${'c'.repeat(32)}`;
  return { fleetId, serverName: 'palpo.test', credentialVersion: 1, registration: {
    id: fleetId, sender_localpart: `${fleetId}_representative`, url: 'http://host.docker.internal:19094',
    as_token: 'wizard-private-as', hs_token: 'wizard-private-hs',
    namespaces: { users: [{ exclusive: true, regex: `^@${fleetId}_[a-z0-9_]+:palpo\\.test$` }], rooms: [], aliases: [] },
  } };
}

test('wizard import refuses foreign and invalid files before saving', async () => {
  const send = vi.fn();
  const text = JSON.stringify(wizardFixture());
  await expect(connectFleetCredentialImport(text, { serverName: 'foreign.test' }, { send })).rejects.toThrow('cr.importWrongServer');
  for (const invalid of ['{', JSON.stringify({ ...wizardFixture(), credentialVersion: 20 }), ' '.repeat(65537)]) {
    await expect(connectFleetCredentialImport(invalid, { serverName: 'palpo.test' }, { send })).rejects.toThrow('cr.importInvalid');
  }
  expect(send).not.toHaveBeenCalled();
});

test('wizard import saves existing credentials then verifies without generating a registration', async () => {
  const fixture = wizardFixture(), side = { id: 'palpo.test', serverName: 'palpo.test' };
  const text = JSON.stringify(fixture), order = [], summaries = [];
  const send = vi.fn(async (path, options) => {
    order.push(options.method);
    return path.endsWith('/verify') ? { ok: true, body: { side: { accessState: 'accepted' } } } : { ok: true };
  });
  const result = await connectFleetCredentialImport(text, side, {
    send, onSaved: summary => { order.push('forget-file'); summaries.push(summary); },
  });
  expect(order).toEqual(['PUT', 'forget-file', 'POST']);
  expect(send.mock.calls).toEqual([
    ['project-sides/palpo.test/credential', { method: 'PUT', body: { credential: parseFleetCredentialImport(text, side).credential } }],
    ['project-sides/palpo.test/verify', { method: 'POST' }],
  ]);
  expect(result).toMatchObject({ saved: true, verification: { body: { side: { accessState: 'accepted' } } } });
  expect(result.summary).toMatchObject({ representative: `@${fixture.fleetId}_representative:palpo.test`, url: fixture.registration.url });
  const rendered = JSON.stringify([fleetImportSummary(parseFleetCredentialImport(text, side)), summaries, result]);
  for (const secret of [fixture.registration.as_token, fixture.registration.hs_token, 'asToken', 'hsToken']) expect(rendered).not.toContain(secret);
});

test('wizard import preserves save and verification failures for retry', async () => {
  const text = JSON.stringify(wizardFixture()), side = { serverName: 'palpo.test' }, onSaved = vi.fn();
  const refused = vi.fn(async () => ({ ok: false, error: 'permission denied' }));
  expect(await connectFleetCredentialImport(text, side, { send: refused, onSaved }))
    .toEqual({ saved: false, error: 'permission denied' });
  expect(refused).toHaveBeenCalledTimes(1); expect(onSaved).not.toHaveBeenCalled();
  for (const verification of [{ ok: false, error: 'bridge unavailable' }, { ok: true, body: { side: { accessState: 'rejected' } } }]) {
    const send = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(verification);
    const result = await connectFleetCredentialImport(text, side, { send, onSaved });
    expect(result.saved).toBe(true); expect(result.verification).toEqual(verification);
    expect(send).toHaveBeenCalledTimes(2);
  }
  expect(onSaved).toHaveBeenCalledTimes(2);
});
