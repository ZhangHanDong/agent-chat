import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';
import { defaultAgentchatHomeDir } from '../lib/agent-home-v1.js';
import { createFleetProtocol, fleetIdForSender, FLEET_PROBE_EVENT, FLEET_REQUEST_EVENT } from '../lib/fleet-protocol.js';
import { normalizeOutboundTransport } from '../lib/fleet-outbound-config.js';
import { parseFleetCredentialImport } from '../mockup/lib/fleet-credential-import.js';

// Obsolete names are intentional negative inputs, never compatibility aliases.
const obsolete = 'hafleet';
const root = resolve(import.meta.dirname, '..');
describe('Hagency product identity', () => {
  it('Hagency starts from its own command and home without old-name fallback', () => {
    const output = execFileSync(resolve(root, 'bin/hagency'), ['--help'], { encoding: 'utf8' });
    expect(output).toContain('Usage: hagency');
    expect(output.toLowerCase()).not.toContain(obsolete);
    expect(existsSync(resolve(root, `bin/${obsolete}`))).toBe(false);
    const env = { HOME: '/tmp/operator', [`${obsolete.toUpperCase()}_HOMEDIR`]: '/tmp/obsolete' };
    expect(defaultAgentchatHomeDir(env)).toBe(resolve(os.homedir(), '.hagency'));
    expect(defaultAgentchatHomeDir({ ...env, HAGENCY_HOMEDIR: '/tmp/current' })).toBe('/tmp/current');
    expect(defaultAgentchatHomeDir({ ...env, HAGENCY_RUNTIME_DIR: '/tmp/runtime' })).toBe('/tmp/runtime/homes');
  });

  it('Hagency imports Palpo fleet credentials without changing fleet identifiers', () => {
    const serverName = 'project.test';
    const config = prefix => {
      const fleetId = `${prefix}_${'a'.repeat(32)}`;
      return { v: 1, serverName, fleetId, registration: {
        id: fleetId, sender_localpart: `${fleetId}_representative`,
        as_token: 'isolated-appservice-token', hs_token: 'isolated-homeserver-token',
        url: 'https://project.test/edge',
        namespaces: { users: [{ exclusive: true, regex: `^@${fleetId}_[a-z0-9_]+:project\\.test$` }], rooms: [], aliases: [] },
      }, transport: { mode: 'outbound', url: `https://project.test/api/fleet/v2/${fleetId}`,
        token: 'isolated-machine-token', generation: 1 } };
    };
    const fresh = config('hf');
    const parsed = parseFleetCredentialImport(JSON.stringify(fresh), { serverName });
    expect(parsed.fleetId).toBe(fresh.fleetId);
    expect(normalizeOutboundTransport(parsed.credential.transport, parsed.fleetId)).toEqual(fresh.transport);
    expect(fleetIdForSender(parsed.credential.senderLocalpart)).toBe(fresh.fleetId);
    const invalid = config('unregistered');
    expect(() => parseFleetCredentialImport(JSON.stringify(invalid), { serverName })).toThrow();
    expect(() => normalizeOutboundTransport(invalid.transport, invalid.fleetId)).toThrow();
    expect(fleetIdForSender(invalid.registration.sender_localpart)).toBeNull();
  });

  it('Hagency uses one namespace across console routes and Matrix protocol', async () => {
    expect(FLEET_PROBE_EVENT).toBe('com.hagency.connection.probe.v1');
    expect(FLEET_REQUEST_EVENT).toBe('com.hagency.engagement.request.v1');
    expect(existsSync(resolve(root, 'mockup/app/api/hagency/[...path]/route.js'))).toBe(true);
    expect(existsSync(resolve(root, `mockup/app/api/${obsolete}/[...path]/route.js`))).toBe(false);
    const protocol = createFleetProtocol({});
    expect(await protocol.recordEvent({ event: { type: `com.${obsolete}.connection.probe.v1` } })).toBe(false);
    expect(await protocol.recordEvent({ event: { type: `com.${obsolete}.engagement.request.v1` } })).toBe(false);
  });
});
