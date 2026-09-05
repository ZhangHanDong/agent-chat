/*
 * F06 (16-impl-r4 ④): the ONE production projection from a project-side store record to the
 * inbound-credential shape the bridge consumes. The backend endpoint and the process-isolated
 * test children both call THIS function, so what a test proves about the payload is what
 * production serves — no hand-written ideal payload anywhere.
 */
import { createHash } from 'crypto';
import { normalizeSideKey } from './side-provenance.js';

/**
 * Derive the STABLE NON-SECRET registration identity: rotating the hs_token rotates the
 * identity (an in-flight receiver holding the old identity then fails the consistency check
 * terminally), while a restart with the same token derives the same id. Never the token, nor
 * any longer fragment of it.
 */
export function derivedRegistrationId(sideId, hsToken) {
  return `${normalizeSideKey(sideId)}@${createHash('sha256').update(String(hsToken)).digest('hex').slice(0, 8)}`;
}

/**
 * Project one store side + its credential into the inbound shape. `side` is a PUBLIC side
 * (what ProjectSideStore.publicSide returns — it carries `representative`), `credential` the
 * record read through `credentialFor`.
 *
 * A side whose representative was never recorded projects `representative: null` — the bridge
 * classifies that as a TERMINAL side_incomplete_registration (a configuration gap retrying
 * cannot fix), never an endless relation-unavailable 500 loop.
 */
export function inboundCredentialsProjection(side, credential) {
  if (!side || !credential?.hsToken) return null;
  return {
    sideId: normalizeSideKey(side.id ?? side.serverName),
    serverName: side.serverName,
    apiBaseUrl: side.apiBaseUrl,
    senderLocalpart: credential.senderLocalpart,
    namespace: credential.namespace,
    hsToken: credential.hsToken,
    registration: derivedRegistrationId(side.id ?? side.serverName, credential.hsToken),
    representative: side.representative?.mxid
      ? { mxid: String(side.representative.mxid) }
      : null,
  };
}
