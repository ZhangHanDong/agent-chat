import { expect, test, vi } from 'vitest';
import { hasOtherAgentAllocation, retirePalpoAgent } from '../lib/palpo-agent-retirement.js';

test('another live allocation prevents whole Agent retirement', () => {
  const e = { id: 'ended', agent: 'edison', state: 'ended' };
  expect(hasOtherAgentAllocation(e, [e, { id: 'active', agent: 'edison', state: 'active' }])).toBe(true);
  expect(hasOtherAgentAllocation(e, [e, { id: 'reserved', agent: 'edison', state: 'pending', fulfillment: {} }])).toBe(true);
  expect(hasOtherAgentAllocation(e, [e, { id: 'active', agent: 'other', state: 'active' }])).toBe(false);
});

test('retirement requires the exact identity and every remote verification result', async () => {
  const fleetId = `hf_${'a'.repeat(32)}`, mxid = `@${fleetId}_agent_edison:palpo.test`;
  const config = { engagement: { requestContext: { fleetId, requestId: 'request' }, endedAt: 1234 }, mxid, localStopped: true,
    transport: { mode: 'outbound', url: `https://palpo.test/api/fleet/v2/${fleetId}`, token: 'fixture-transport-token', generation: 1 } };
  const result = { fleetId, requestId: 'request', agent: { mxid, state: 'retired', matrixIdentity: 'deactivated', joinedRooms: [], appserviceAccess: 'revoked' } };
  for (const change of [{ mxid: '@someone:palpo.test' }, { joinedRooms: ['!still:palpo.test'] }, { matrixIdentity: 'active' }, { appserviceAccess: 'active' }]) {
    await expect(retirePalpoAgent({ ...config, fetchImpl: vi.fn(async () => Response.json({ ...result, agent: { ...result.agent, ...change } })) })).rejects.toThrow('not fully verified');
  }
  expect(await retirePalpoAgent({ ...config, fetchImpl: vi.fn(async () => Response.json(result)) })).toMatchObject({ mxid, state: 'retired' });
});
