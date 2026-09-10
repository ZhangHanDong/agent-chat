import { mintAgentIdentity, sendToRoomOnSide } from './matrix-representative.js';

// The bridge supplies its canonical credential accessors. External HTTP is the
// only injectable boundary; registration, identity validation and persistence run here.
export async function executeMatrixWork(job, { readCredential, saveCredential, fetchImpl = fetch }) {
  const { side, credential, agent, action } = job;
  const http = (url, options) => fetchImpl(url, { ...options, signal: AbortSignal.timeout(15_000) });
  if (action === 'engagement-approved') {
    const result = await sendToRoomOnSide({ side, credential, roomId: job.roomId, content: job.content,
      txnSeed: `engagement-approved:${job.engagementId}`, fetchImpl: http });
    return { ok: result.sent, eventId: result.eventId, code: result.sent ? null : 'approval_notice_delivery_failed', permanent: result.state === 'rejected' };
  }
  if (action === 'representative-logout') {
    if (!credential?.representativeToken) return { ok: false, code: 'agent_credential_unavailable' };
    const response = await http(`${side.apiBaseUrl.replace(/\/+$/, '')}/_matrix/client/v3/logout`, {
      method: 'POST', headers: { Authorization: `Bearer ${credential.representativeToken}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    const revoked = response.ok || response.status === 401 && (await response.json().catch(() => ({}))).errcode === 'M_UNKNOWN_TOKEN';
    return { ok: revoked, code: revoked ? null : `matrix_http_${response.status}` };
  }
  let stored = readCredential(agent);
  if (action === 'logout' && !stored) return { ok: true, mxid: job.mxid };
  if (stored && (stored.homeserver !== side.apiBaseUrl.replace(/\/+$/, '')
    || stored.serverName !== side.serverName)) return { ok: false, code: 'credential_side_mismatch' };
  if (action === 'identity') {
    if (typeof job.localpart !== 'string' || !/^[a-z0-9._=-]+$/.test(job.localpart)) return { ok: false, code: 'invalid_localpart' };
    if (!stored) {
      const minted = await mintAgentIdentity({ side, credential, localpart: job.localpart, fetchImpl: http });
      if (!minted.minted || !minted.accessToken) return { ok: false, code: minted.errcode || 'registration_failed' };
      stored = { homeserver: side.apiBaseUrl.replace(/\/+$/, ''), serverName: side.serverName,
        mxid: minted.mxid, accessToken: minted.accessToken };
      // Persist BEFORE acknowledging. A restarted bridge reuses this credential
      // when the acknowledgement was lost, without registering another account.
      saveCredential(agent, stored);
    }
    if (stored.mxid !== `@${job.localpart.toLowerCase()}:${side.serverName}`) return { ok: false, code: 'identity_mismatch' };
    return { ok: true, mxid: stored.mxid };
  }
  if (!stored?.accessToken || stored.mxid !== job.mxid) return { ok: false, code: 'agent_credential_unavailable' };
  if (!['join', 'leave', 'logout'].includes(action)) return { ok: false, code: 'unknown_action' };
  const suffix = action === 'logout' ? '/logout' : action === 'join' ? `/join/${encodeURIComponent(job.roomId)}`
    : `/rooms/${encodeURIComponent(job.roomId)}/leave`;
  const response = await http(`${stored.homeserver}/_matrix/client/v3${suffix}`, {
    method: 'POST', headers: { Authorization: `Bearer ${stored.accessToken}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  const alreadyRevoked = action === 'logout' && response.status === 401
    && (await response.json().catch(() => ({}))).errcode === 'M_UNKNOWN_TOKEN';
  const ok = response.ok || alreadyRevoked;
  if (ok && action === 'logout') saveCredential(agent, null);
  return { ok, mxid: stored.mxid, code: ok ? null : `matrix_http_${response.status}` };
}
