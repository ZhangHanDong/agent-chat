import { normalizeOutboundTransport } from './fleet-outbound-config.js';

export function hasOtherAgentAllocation(engagement, engagements) {
  return engagements.some(row => row.id !== engagement.id && row.agent === engagement.agent
    && (row.state === 'active' || row.state === 'pending' && row.fulfillment));
}

/** No administrator credential crosses to HAFleet. */
export async function retirePalpoAgent({ engagement, mxid, transport, localStopped, fetchImpl = fetch }) {
  const context = engagement.requestContext;
  const link = normalizeOutboundTransport(transport, context.fleetId);
  const response = await fetchImpl(`${link.url}/retire-agent`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${link.token}`, 'X-HAFleet-Generation': String(link.generation), 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: context.requestId, agentMxid: mxid, endedAt: engagement.endedAt, localStopped: localStopped === true }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Palpo Agent retirement failed (${response.status}, ${String(result.code ?? 'upstream_error').slice(0, 80)})`);
  if (result.requestId !== context.requestId || result.fleetId !== context.fleetId || result.agent?.mxid !== mxid
    || result.agent?.state !== 'retired' || result.agent?.matrixIdentity !== 'deactivated'
    || result.agent?.appserviceAccess !== 'revoked' || !Array.isArray(result.agent?.joinedRooms) || result.agent.joinedRooms.length) {
    throw new Error('Palpo Agent retirement is not fully verified');
  }
  return { mxid, state: 'retired', joinedRooms: [], appserviceAccess: 'revoked' };
}
