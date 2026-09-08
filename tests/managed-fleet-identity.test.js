import { expect, test } from 'vitest';
import { projectSideAgentMxid, projectSideAgentPrefix } from '../lib/matrix-agent-identity.js';
import { parseFleetCredentialImport } from '../mockup/lib/fleet-credential-import.js';

test('imported fleet identity overrides only its own side while legacy naming stays unchanged', () => {
  const fleetId = `hf_${'a'.repeat(32)}`;
  const side = { id: 'palpo.test', serverName: 'palpo.test' };
  const registration = { id: fleetId, url: 'http://callback.test:18195', as_token: 'as-fixture', hs_token: 'hs-fixture',
    sender_localpart: `${fleetId}_representative`, namespaces: {
      users: [{ exclusive: true, regex: `^@${fleetId}_[a-z0-9_]+:palpo\\.test$` }], aliases: [], rooms: [],
    } };
  const imported = parseFleetCredentialImport(JSON.stringify({ fleetId, serverName: side.serverName,
    credentialVersion: 1, registration }), side);
  const acting = { side, credential: imported.credential };
  expect(projectSideAgentPrefix(acting, 'ac_')).toBe(`${fleetId}_agent_`);
  expect(projectSideAgentMxid('coding', acting, 'ac_')).toBe(`@${fleetId}_agent_coding:palpo.test`);
  expect(projectSideAgentPrefix({ side, credential: { kind: 'registrationToken' } }, 'ac_')).toBe('ac_');
  expect(projectSideAgentPrefix({ side, credential: { kind: 'appservice', senderLocalpart: 'hafleet', namespace: '@ac_.*' } }, 'ac_')).toBe('ac_');
  expect(projectSideAgentPrefix({ side, credential: { kind: 'registrationToken' } }, 'custom_')).toBe('custom_');
  expect(() => projectSideAgentPrefix({ side, credential: { ...acting.credential, namespace: '.*' } })).toThrow('managed_fleet_identity_scope_invalid');
  expect(() => projectSideAgentPrefix({ side: { serverName: 'foreign.test' }, credential: acting.credential })).toThrow('managed_fleet_identity_scope_invalid');
  expect(projectSideAgentPrefix({}, 'ac_')).toBe('ac_');
});
