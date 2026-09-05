/*
 * F06 side provenance — the authenticated origin carried from each intake adapter to the one
 * Matrix ingress boundary (specs/task-side-provenance.spec.md).
 *
 * THE MODEL (operator ruling C): independent HAFleet instances may share one Palpo, each with
 * its own registration. "Registration" here is the NON-SECRET identity of the authoritative
 * credential record uniquely selected by hs_token within THIS instance — the sideId names its
 * one registration on that server locally; it is not a global fleet id and never a token value.
 *
 * THE ORDER AT INGRESS (fixed by the board's release note, 16-impl):
 *   1. registration still in the loaded registry (rechecked per event, never a closure snapshot)
 *   2. room relation proof (representative /whoami MXID membership=join, or the first-invite
 *      bootstrap)  → terminal room_side_mismatch | retryable room_relation_unavailable
 *   3. dedup claim
 *   4. typed path
 * A retryable verdict propagates out of the bridge so the receiver answers 500 without
 * completing the txn, the edge puller does not ack, and the sync collector holds its cursor.
 */

/** Closed set of intake modes (spec Must #1). */
export const INTAKE_MODES = ['push', 'edge', 'sync'];

export class SideProvenanceError extends Error {
  constructor(code, message, { retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'SideProvenanceError';
    this.code = code;
    this.retryable = Boolean(retryable);
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) this.retryAfterMs = retryAfterMs;
  }
}

/**
 * F06 (16-impl-r2): the ONE side-key normalizer. Router entries, the inbound snapshot, and
 * `actingSideFor` must all key a side identically or an authenticated id in one table will miss
 * in another. Lowercase + trim, ports untouched (they are part of the server name's identity).
 */
export function normalizeSideKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * F06 (16-impl-r2) B: the transport provenance must AGREE with the authenticated identity.
 * A receiver entry for side A carrying {sideId: B} or a forged registration would otherwise
 * borrow B's representative and credential past the gate. MISMATCH is terminal — the adapter
 * contract was violated in a way retrying cannot fix; a MISSING or malformed provenance is
 * retryable (internal wiring error, the batch may be redelivered once the wiring is fixed).
 */
export function assertTransportProvenanceConsistency({
  provenance,
  authenticatedSideId,
  snapshotEntry,
}) {
  if (!provenance || typeof provenance !== 'object') {
    throw new SideProvenanceError(
      'invalid_transport_provenance',
      'appservice event arrived without a provenance object',
      { retryable: true },
    );
  }
  if (!INTAKE_MODES.includes(provenance.mode)) {
    throw new SideProvenanceError(
      'provenance_mismatch',
      `provenance.mode "${provenance.mode}" is outside the closed set {${INTAKE_MODES.join(', ')}}`,
    );
  }
  const claimed = normalizeSideKey(provenance.sideId);
  const authenticated = normalizeSideKey(authenticatedSideId);
  if (!claimed || claimed !== authenticated) {
    throw new SideProvenanceError(
      'provenance_mismatch',
      `provenance.sideId "${provenance.sideId}" does not match the authenticated side "${authenticatedSideId}"`,
    );
  }
  if (snapshotEntry && String(snapshotEntry.registration ?? '') !== String(provenance.registration)) {
    throw new SideProvenanceError(
      'provenance_mismatch',
      `provenance.registration does not match the loaded registration for side ${authenticated}`,
    );
  }
  return true;
}

/**
 * Build the provenance object adapters attach OUTSIDE the event body.
 *
 * `registration` is the non-secret credential identity; `sideId` is the canonical local id;
 * `mode` is one of the closed set. Anything else — or a mode outside the set — is refused here,
 * at construction, because a malformed provenance reaching ingress would otherwise be a
 * guess masquerading as an authenticated fact.
 */
export function buildSideProvenance({ registration, sideId, mode }) {
  const reg = typeof registration === 'string' ? registration.trim() : '';
  const side = typeof sideId === 'string' ? sideId.trim().toLowerCase() : '';
  if (!reg) throw new SideProvenanceError('missing_provenance', 'provenance.registration is required');
  if (!side) throw new SideProvenanceError('missing_provenance', 'provenance.sideId is required');
  if (!INTAKE_MODES.includes(mode)) {
    throw new SideProvenanceError('missing_provenance', `provenance.mode must be one of ${INTAKE_MODES.join(', ')}`);
  }
  return { registration: reg, sideId: side, mode };
}

/**
 * The authoritative representative MXID for a side record, as recorded through /whoami
 * (setRepresentative refuses composed guesses — ADR-014 decision 5). Absent is UNAVAILABLE,
 * not empty: an unknown representative can neither prove nor disprove a room relation, so the
 * batch must stay retryable rather than be judged on a guess.
 */
export function representativeMxidFor(side) {
  const mxid = typeof side?.representative?.mxid === 'string' ? side.representative.mxid.trim() : '';
  if (!mxid) {
    throw new SideProvenanceError(
      'room_relation_unavailable',
      `side ${side?.serverName ?? '(unknown)'} has no /whoami-recorded representative mxid yet`,
      { retryable: true },
    );
  }
  return mxid;
}

/** Full-MXID shape check (localpart case-sensitive, server present). */
export function isFullMxid(value) {
  return typeof value === 'string' && /^@[^:\s@]+:[^\s@]+$/.test(value.trim());
}

/**
 * The first-invite bootstrap exception (spec registered-room): an authenticated m.room.member
 * event with membership=invite whose state_key is EXACTLY the representative's full MXID.
 * Matching server names, agent prefixes, or another registration's representative do not
 * qualify — the target must be this registration's own representative, byte for byte.
 */
export function isFirstInviteBootstrap(event, representativeMxid) {
  if (event?.type !== 'm.room.member') return false;
  if (event?.content?.membership !== 'invite') return false;
  if (!isFullMxid(representativeMxid)) return false;
  return String(event?.state_key ?? '').trim() === representativeMxid.trim();
}

/**
 * Validate an opaque room id shape. `!name:server` — anything else is a terminal
 * invalid_room_id, decided before any network read.
 */
export function isValidRoomId(roomId) {
  return typeof roomId === 'string' && /^![^:\s]+:\S+$/.test(roomId.trim());
}

/**
 * THE ROOM RELATION CHECK (L3 step 2). Everything the adapter authenticated is context; what
 * this answers is whether THIS registration's representative is joined to THIS exact room, or
 * is being invited to it for the first time.
 *
 * `memberLookup(roomId, mxid)` must return one of:
 *   { complete: true, membership: 'join' | <other> }   — a definitive member read
 *   { complete: false, reason }                          — evidence unavailable (retryable)
 * A throw is treated as unavailable too; only a COMPLETE read may prove or disprove.
 */
export async function assertRoomRelation({ event, roomId, representativeMxid, memberLookup }) {
  if (!isValidRoomId(roomId)) {
    throw new SideProvenanceError('invalid_room_id', `room id "${roomId}" is not a valid Matrix room id`);
  }
  if (isFirstInviteBootstrap(event, representativeMxid)) return { relation: 'bootstrap_invite' };
  let read;
  try {
    read = await memberLookup(roomId, representativeMxid);
  } catch (error) {
    throw new SideProvenanceError(
      'room_relation_unavailable',
      `could not read membership for ${representativeMxid} in ${roomId}: ${error?.message || error}`,
      { retryable: true },
    );
  }
  if (!read || read.complete !== true) {
    throw new SideProvenanceError(
      'room_relation_unavailable',
      `membership evidence for ${representativeMxid} in ${roomId} is incomplete: ${read?.reason || 'no result'}`,
      { retryable: true, retryAfterMs: read?.retryAfterMs },
    );
  }
  if (read.membership === 'join') return { relation: 'representative_joined' };
  throw new SideProvenanceError(
    'room_side_mismatch',
    `${representativeMxid} is not joined to ${roomId} (membership=${read.membership ?? 'none'})`,
  );
}

/**
 * The cross-mode dedup claim key (spec rejection-and-replay): `(registration, roomId, event_id)`.
 * Mode is diagnostic context, never logical identity — push and sync delivering the same event
 * once each must collapse to one claim.
 */
export function eventClaimKey({ registration, roomId, eventId }) {
  return `${registration}|${roomId}|${eventId}`;
}

/**
 * Canonical serialization for object key order (idless invite identity uses it).
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * The idless invite identity (16-r1): the COMPLETE tuple — registration, opaque roomId, full
 * inviter MXID, full target state_key, membership, and authorization-relevant stripped content.
 * Both MXIDs are kept whole (localpart case and server included); object key order in the
 * stripped content is canonicalized so a re-serialization does not mint a new claim.
 */
export function idlessInviteClaimKey({ registration, roomId, event }) {
  const sender = String(event?.sender ?? '').trim();
  const stateKey = String(event?.state_key ?? '').trim();
  const membership = typeof event?.content?.membership === 'string' ? event.content.membership : '';
  /*
   * 16-impl-r2 C: a stripped invite without the full identity fields can never be deduplicated
   * honestly — a claim keyed on a partial identity would fold DIFFERENT invitation facts. This is
   * terminal (invalid_event_identity), not a retryable gap.
   */
  if (!isFullMxid(sender) || !isFullMxid(stateKey) || !membership) {
    throw new SideProvenanceError(
      'invalid_event_identity',
      `idless invite in ${roomId} lacks the full identity (sender/state_key/membership) required to claim it`,
    );
  }
  const stripped = event?.unsigned?.invite_room_state ?? event?.invite_room_state ?? [];
  const authRelevant = (Array.isArray(stripped) ? stripped : [])
    .filter((st) => typeof st?.type === 'string')
    .map((st) => ({ type: st.type, state_key: String(st?.state_key ?? ''), content: st?.content ?? null }));
  /*
   * ONE canonical JSON object, not a delimiter join: JSON quoting escapes separators inside any
   * field, so a room id / MXID / content string containing '|' cannot collide with another tuple.
   * The COMPLETE event.content is included conservatively (spec: authorization-relevant content
   * changes must not fold), and canonicalJson already sorts object keys.
   */
  return canonicalJson({
    k: 'idless-invite',
    registration,
    room: roomId,
    sender,
    state_key: stateKey,
    membership,
    content: event?.content ?? null,
    stripped: authRelevant,
  });
}

/**
 * Pick the claim key for an event: event_id when present, else the idless invite identity.
 * An event with NEITHER an event_id nor the invite shape is a terminal invalid_event_identity —
 * it could never be deduplicated, so admitting it would break the exactly-once contract.
 */
export function claimKeyFor({ registration, roomId, event }) {
  const eventId = typeof event?.event_id === 'string' ? event.event_id.trim() : '';
  if (eventId) return eventClaimKey({ registration, roomId, eventId });
  if (event?.type === 'm.room.member' && event?.content?.membership === 'invite') {
    return idlessInviteClaimKey({ registration, roomId, event });
  }
  throw new SideProvenanceError(
    'invalid_event_identity',
    `event in ${roomId} has neither event_id nor the stripped-invite shape`,
  );
}
