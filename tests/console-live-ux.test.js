import { afterEach, describe, expect, it, vi } from 'vitest';
import { allocationValue, approvalVerdict, capabilityCount, onboardingHealthStatus, projectSideConnectionState, registrationCallback, verificationState } from '../mockup/lib/console-workflow.js';
import { readFileSync } from 'node:fs';
import { mapAgent, mapCapability, send } from '../mockup/lib/api.js';
import { runtimeStatusText } from '../mockup/lib/mock-data.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe('live console workflow', () => {
  it('project-side status requires current credentials and preserves inactive and failed states', () => {
    const connected = { active: true, hasCredential: true, accessState: 'accepted', projects: [] };
    expect(projectSideConnectionState(connected)).toBe('accepted');
    expect(projectSideConnectionState({ ...connected, active: false })).toBe('inactive');
    expect(projectSideConnectionState({ ...connected, hasCredential: false })).toBe('missing');
    for (const accessState of ['unverified', 'rejected', 'blocked', 'unreachable']) {
      expect(projectSideConnectionState({ ...connected, accessState })).toBe(accessState);
    }
    for (const accessState of [undefined, null, 'ready']) {
      expect(projectSideConnectionState({ ...connected, accessState })).toBe('unknown');
    }
    // Staging replacement credentials does not invalidate the accepted current identity.
    expect(projectSideConnectionState({ ...connected, awaitingInstall: true })).toBe('accepted');
  });
  it('onboarding waits for actual health and preserves observed launch failures', () => {
    expect(onboardingHealthStatus({ online: true, healthy: false, state: 'starting' }).state).toBe('waiting');
    expect(onboardingHealthStatus({ online: true, healthy: false, state: 'degraded' }).state).toBe('waiting');
    expect(onboardingHealthStatus({ healthy: true, state: 'online', serverOnline: false }).state).toBe('waiting');
    expect(onboardingHealthStatus({ healthy: true, state: 'online', serverOnline: true }).state).toBe('ready');
    expect(onboardingHealthStatus({ online: false, offlineReason: 'launch-failed:exit-1' }))
      .toEqual({ state: 'failed', reason: 'launch-failed:exit-1' });
    expect(onboardingHealthStatus(null).state).toBe('waiting');
  });
  it('console resumes an edge registration with the homeserver-facing callback', () => {
    const edge = { inboundVia: 'edge', edgeUrl: 'http://127.0.0.1:18095', edgeRegistrationUrl: 'http://edge:8095' };
    expect(registrationCallback(edge, { applicable: false })).toBe('http://edge:8095');
    expect(registrationCallback(edge, { recommended: 'http://wrong-local-probe:8095' })).toBe('http://edge:8095');
    expect(registrationCallback({ inboundVia: 'edge', edgeUrl: edge.edgeUrl })).toBe('');
    expect(registrationCallback({ inboundVia: 'listener' }, { recommended: 'http://host:8095' })).toBe('http://host:8095');
  });

  it('console verification renders the authoritative side access state', () => {
    expect(verificationState({ ok: true, side: { accessState: 'accepted' } })).toBe('accepted');
    expect(verificationState({ side: { accessState: 'rejected' }, accessState: 'accepted' })).toBe('rejected');
    expect(verificationState({ accessState: 'blocked' })).toBe('blocked');
    expect(verificationState({ ok: true })).toBeNull();
  });

  it('console allocation distinguishes unset, closed and positive capacity', () => {
    expect(allocationValue('')).toBeNull();
    expect(allocationValue('  ')).toBeNull();
    expect(allocationValue('0')).toBe(0);
    expect(allocationValue('200000')).toBe(200000);
    for (const bad of ['-1', '1.5', 'Infinity', '9007199254740992', 'abc']) {
      expect(() => allocationValue(bad)).toThrow('en.invalidAllocation');
    }
  });

  it('console first approval requires a complete explicit private owner binding', () => {
    const base = { tokens: '30000', projectRoomId: '!project:example.test' };
    expect(approvalVerdict(base)).toEqual({ approve: true, allocatedTokens: 30000 });
    expect(approvalVerdict({ ...base, ownerMxid: ' @borrower:example.test ', ownerDmRoomId: '!private:example.test' }))
      .toEqual({ approve: true, allocatedTokens: 30000, owner: { ownerMxid: '@borrower:example.test', ownerDmRoomId: '!private:example.test' } });
    expect(() => approvalVerdict({ ...base, ownerMxid: '@borrower:example.test' })).toThrow('en.invalidOwner');
    expect(() => approvalVerdict({ ...base, ownerDmRoomId: '!private:example.test' })).toThrow('en.invalidOwner');
    expect(() => approvalVerdict({ ...base, ownerMxid: 'Borrower', ownerDmRoomId: '!private:example.test' })).toThrow('en.invalidOwner');
    expect(() => approvalVerdict({ ...base, ownerMxid: '@borrower:example.test', ownerDmRoomId: base.projectRoomId })).toThrow('en.ownerRoomIsProject');
    expect(() => approvalVerdict({ ...base, tokens: '' })).toThrow('en.invalidApprovalAmount');
    expect(() => approvalVerdict({ ...base, tokens: '0' })).toThrow('en.invalidApprovalAmount');
  });

  it('console capabilities include unused qualifying presets without inventing agents', () => {
    const payload = {
      roles: [{ role: 'coding', able: [], unable: [], families: ['gpt'], crossFamilyOk: true }],
      resources: { coding: {
        qualified: [{ presetId: 'p1', name: 'Coding capacity', model: 'gpt-5.6-sol', reasoning: 'high', tier: 'strong', family: 'gpt', overTier: 0 }],
        unqualified: [{ presetId: 'unsupported', name: 'Future runner', reason: 'framework-not-provisionable' }],
      } },
    };
    const [row] = mapCapability(payload, new Map());
    expect(row.able).toEqual([]);
    expect(row.resources[0].presetId).toBe('p1');
    expect(row.resources[0].model).toBe('gpt-5.6-sol');
    expect(row.unavailableResources).toEqual([{ presetId: 'unsupported', name: 'Future runner', reason: 'framework-not-provisionable' }]);
    expect(capabilityCount(row)).toBe(1);
    expect(row.crossFamilyOk).toBe(true);
    const [blocked] = mapCapability({ ...payload, roles: [{ ...payload.roles[0], crossFamilyOk: false }] }, new Map());
    expect(blocked.crossFamilyOk).toBe(false);
    const [assigned] = mapCapability({ ...payload, roles: [{ ...payload.roles[0], able: [{ agent: 'coder', family: 'gpt', tier: 'strong' }] }] }, new Map([['coder', { name: 'coder', presetId: 'p1' }]]));
    expect(assigned.resources).toEqual([]);
    expect(capabilityCount(assigned)).toBe(1);
  });

  it('console runtime state preserves active ephemeral work and unknown duration', () => {
    const live = mapAgent({ name: 'coder', activeNow: true, transport: 'thread-session', state: 'running', activeDurationSec: 65 });
    expect(runtimeStatusText(live)).toBe('ACTIVE 1m5s');
    expect(live.transport).toBe('thread-session');
    expect(runtimeStatusText(mapAgent({ name: 'coder', activeNow: false }))).toBe('IDLE');
    expect(runtimeStatusText(mapAgent({ state: 'waiting_approval', blocked: true }))).toBe('WAITING APPROVAL');
    expect(runtimeStatusText(mapAgent({ state: 'starting' }))).toBe('STARTING');
    expect(runtimeStatusText(mapAgent({ state: 'stopping' }))).toBe('STOPPING');
    expect(runtimeStatusText(mapAgent({ state: 'blocked' }))).toBe('BLOCKED');
    expect(runtimeStatusText(mapAgent({ state: 'offline' }))).toBe('OFFLINE');
  });

  it('console blocks empty first-owner approval while preserving existing binding reuse', () => {
    const base = { tokens: '100000', projectRoomId: '!new:example.test', requireOwner: true };
    expect(() => approvalVerdict(base)).toThrow('en.ownerRequired');
    expect(() => approvalVerdict({ ...base, ownerMxid: ' ', ownerDmRoomId: ' ' })).toThrow('en.ownerRequired');
    expect(approvalVerdict({ ...base, requireOwner: false }))
      .toEqual({ approve: true, allocatedTokens: 100000 });
    expect(approvalVerdict({ ...base, ownerMxid: '@owner:example.test', ownerDmRoomId: '!private:example.test' }))
      .toEqual({ approve: true, allocatedTokens: 100000,
        owner: { ownerMxid: '@owner:example.test', ownerDmRoomId: '!private:example.test' } });
  });

  it('console writes retain the owner-unavailable error code for form recovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      ok: false, code: 'owner_unavailable', error: 'project owner is unavailable; engagement remains pending',
    }, { status: 409 })));
    const result = await send('engagements/pending/verdict', { body: { approve: true, allocatedTokens: 100000 } });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'owner_unavailable' });
  });

  it('console allocation and stop proxy routes preserve authorization and refuse adjacent credential routes', async () => {
    vi.stubEnv('HAFLEET_CONSOLE_TOKEN', 'console-test');
    vi.stubEnv('HAFLEET_API_TOKEN', 'operator-test');
    const upstream = vi.fn(async () => Response.json({ ok: true, stopped: true }));
    vi.stubGlobal('fetch', upstream);
    const routes = await import('../mockup/app/api/hafleet/[...path]/route.js');
    const call = (method, path, { authorized = true, site = 'same-origin', body = '{}' } = {}) => routes[method](
      new Request(`http://127.0.0.1:3100/api/hafleet/${path.join('/')}`, {
        method,
        headers: { ...(authorized ? { authorization: 'Bearer console-test' } : {}), 'sec-fetch-site': site, 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body }),
      }),
      { params: Promise.resolve({ path }) },
    );
    expect((await call('PUT', ['project-sides', 'example.test', 'allocation'], { body: '{"allocated_tokens":200000}' })).status).toBe(200);
    expect(upstream.mock.calls[0][1].headers.Authorization).toBe('Bearer operator-test');
    expect(upstream.mock.calls[0][1].body).toBe('{"allocated_tokens":200000}');
    expect((await call('POST', ['agents', 'coder', 'stop'])).status).toBe(200);
    expect((await call('GET', ['engagements', 'request-2', 'candidates'])).status).toBe(200);
    expect((await call('PUT', ['framework-presets', 'medium', 'catalog'])).status).toBe(200);
    const count = upstream.mock.calls.length;
    expect((await call('POST', ['framework-presets', 'medium', 'agents'], { body: '{"name":"fast-two","role":"coding"}' })).status).toBe(403);
    expect((await call('PUT', ['framework-presets', 'medium', 'agents', 'rad-1'])).status).toBe(403);
    expect((await call('DELETE', ['framework-presets', 'medium', 'agents', 'rad-1'])).status).toBe(403);
    expect((await call('POST', ['framework-presets', 'medium', 'agents'], { site: 'cross-site' })).status).toBe(403);
    expect((await call('GET', ['engagements', 'request-2', 'candidates'], { authorized: false })).status).toBe(403);
    expect((await call('PUT', ['framework-presets', 'medium', 'agents', 'rad-1', 'credentials'])).status).toBe(403);
    expect((await call('POST', ['agents', 'coder', 'stop'], { authorized: false })).status).toBe(403);
    expect((await call('PUT', ['project-sides', 'example.test', 'allocation'], { site: 'cross-site' })).status).toBe(403);
    expect((await call('GET', ['project-sides', 'inbound-credentials'])).status).toBe(403);
    expect((await call('POST', ['project-sides', 'example.test', 'registration'])).status).toBe(403);
    expect((await call('POST', ['agents', 'coder', 'stop', 'extra'])).status).toBe(403);
    expect((await call('PUT', ['project-sides', 'example.test', 'allocation', '..', 'credential'])).status).toBe(400);
    expect(upstream.mock.calls.length).toBe(count);
  });
});
