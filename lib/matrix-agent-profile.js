/** Initialize only machine-generated profile names; a user's custom profile wins. */
export async function reconcileAgentDisplayName({ baseUrl, token, mxid, asUserId = null, agentName, displayName, fetchImpl = fetch }) {
  if (!displayName || typeof displayName !== 'string' || !mxid?.startsWith('@')) return { changed: false };
  const desired = displayName.trim().slice(0, 128);
  if (!desired) return { changed: false };
  const url = new URL(`/_matrix/client/v3/profile/${encodeURIComponent(mxid)}/displayname`, baseUrl);
  if (asUserId) url.searchParams.set('user_id', asUserId);
  const request = async (method, body) => {
    const response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Matrix display name ${method} failed (HTTP ${response.status})`);
    return response.json();
  };
  const current = (await request('GET')).displayname;
  const localpart = mxid.slice(1, mxid.indexOf(':'));
  if (current === desired) return { changed: false, displayName: current };
  if (current && ![mxid, localpart, agentName, `🤖 ${agentName}`].includes(current)) return { changed: false, custom: true, displayName: current };
  await request('PUT', { displayname: desired });
  if ((await request('GET')).displayname !== desired) throw new Error('Matrix display name readback mismatch');
  return { changed: true, displayName: desired };
}
