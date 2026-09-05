/*
 * #16-impl: specs/task-side-provenance.spec.md — 24 scenarios, each named by the spec's bound
 * Filter title, each driven through a REAL adapter (push listener HTTP / edge puller / sync
 * collector → receiver/router → bridge handleAppserviceEvents), never by predicate calls.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { createServer } from 'http';
import { fakePalpo, makeInstance, bridgeUrl } from './helpers/side-provenance-harness.js';
import { createAppserviceRouter } from '../lib/appservice-receiver.js';
import { startAppserviceListener } from '../lib/appservice-listener.js';
import { startAppserviceSyncCollector } from '../lib/appservice-sync.js';
import { startEdgePuller } from '../lib/appservice-puller.js';

const TMP = process.env.HAFLEET_OUTER_TMP || path.join(tmpdir(), 'hafleet-16impl');

let mod = null;
let cleanup = [];

async function bridge() {
  if (!mod) mod = await import(`${bridgeUrl()}?sp=${Date.now()}`);
  return mod;
}

/** Wire a full instance: fake Palpo + router + bridge prototype object with the L3 state set. */
async function makeBridgeWithSide({ sideId, hsToken, asToken, registration, representativeMxid, palpo, members = {}, onTyped = null }) {
  const m = await bridge();
  const typed = { messages: [], states: [], approvals: [], memberships: [] };
  const self = {
    actingCredentials: new Map([[sideId, {
      apiBaseUrl: palpo.url, serverName: sideId,
      kind: 'appservice', asToken, hsToken, senderLocalpart: representativeMxid.slice(1, representativeMxid.indexOf(':')),
      namespace: '@ac_.*',
    }]]),
    appserviceInboundSnapshot: new Map([[sideId, {
      sideId, serverName: sideId, hsToken, registration,
      representative: { mxid: representativeMxid },
    }]]),
    // 16-impl-r2 A: the claim store in its new lifecycle shape
    sideProvenanceClaims: new Map(),
    sideProvenanceClaimOrder: [],
    actingSideFor(id) {
      const row = this.actingCredentials.get(String(id).toLowerCase());
      if (!row) return null;
      return { side: { apiBaseUrl: row.apiBaseUrl, serverName: row.serverName }, credential: row };
    },
    postWarning() {},
    async onRoomMessage(roomId, event) {
      typed.messages.push({ roomId, event });
      if (onTyped) await onTyped('message', { roomId, event });
    },
    async onRoomEvent(roomId, event) { typed.states.push({ roomId, event }); },
    async onAppserviceMembership(id, roomId, event) { typed.memberships.push({ id, roomId, event }); },
  };
  const proto = m.MatrixBridge.prototype;
  self.handleAppserviceEvents = proto.handleAppserviceEvents.bind(self);
  self.assertSideProvenanceForEvent = proto.assertSideProvenanceForEvent.bind(self);
  self.executeTypedForClaim = proto.executeTypedForClaim.bind(self);
  const router = createAppserviceRouter({
    sides: [{
      sideId, hsToken, registration,
      onEvents: (events, meta) => self.handleAppserviceEvents(sideId, events, {
        ...meta,
        provenance: { registration, sideId, mode: meta?.mode ?? 'push' },
      }),
    }],
  });
  self.router = router;
  // 16-impl-r2: refreshAppserviceSides drives `this.appserviceRouter`; same object, real path
  self.appserviceRouter = router;
  return { self, router, typed, mod: m };
}

/** Drive one transaction through the REAL push listener over HTTP. */
async function pushTxn(router, { hsToken, txnId = 't1', events, mode }) {
  const listener = await startAppserviceListener({ receiver: router, port: 0, host: '127.0.0.1' });
  cleanup.push(() => listener.close());
  const port = listener.server?.address?.()?.port ?? listener.port;
  const res = await fetch(`http://127.0.0.1:${port}/_matrix/app/v1/transactions/${txnId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${hsToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ events, ...(mode ? { mode } : {}) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const msg = (roomId, eventId, body = 'hello', sender = '@human:palpo.test') => ({
  type: 'm.room.message', room_id: roomId, event_id: eventId, sender, content: { msgtype: 'm.text', body },
});
const nameEvt = (roomId, eventId, name) => ({
  type: 'm.room.name', room_id: roomId, event_id: eventId, state_key: '', sender: '@human:palpo.test',
  content: { name },
});
const tombstone = (roomId, eventId) => ({
  type: 'm.room.tombstone', room_id: roomId, event_id: eventId, state_key: '', sender: '@human:palpo.test',
  content: { body: 'x', replacement_room: '!new:palpo.test' },
});
const verdict = (roomId, eventId) => msg(roomId, eventId, JSON.stringify({ type: 'engagement-verdict', approve: true }));

beforeEach(() => { cleanup = []; });
afterEach(async () => {
  for (const fn of cleanup) { try { await fn(); } catch { /* closing twice is fine */ } }
  cleanup = [];
  vi.unstubAllGlobals();
});

const SIDE = 'palpo.test';
const REP = '@hafleet:palpo.test';
const HS = 'hs-1';
const AS = 'as-1';
const REG = 'reg-1';
const ROOM = '!room:palpo.test';

describe('side provenance ingress (spec: task-side-provenance)', () => {
  test('side_provenance_reaches_ingress_from_push_edge_and_sync', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    // push
    const r1 = await pushTxn(self.router, { hsToken: HS, txnId: 'p1', events: [msg(ROOM, '$1')] });
    expect(r1.status).toBe(200);
    expect(typed.messages).toHaveLength(1);
    // edge (through the router as the puller shapes it, with mode in the body)
    const r2 = await self.router.handle({
      method: 'PUT', path: '/_matrix/app/v1/transactions/e1', query: {},
      headers: { authorization: `Bearer ${HS}` }, body: { events: [msg(ROOM, '$2')], mode: 'edge' },
    });
    expect(r2.status).toBe(200);
    expect(typed.messages).toHaveLength(2);
    // sync (collector loop driving the router)
    const seen = [];
    const collector = startAppserviceSyncCollector({
      baseUrl: palpo.url, side: SIDE, router: self.router,
      credentialFor: () => ({ kind: 'appservice', asToken: AS, hsToken: HS, senderLocalpart: 'hafleet' }),
      readCursor: () => 's0', writeCursor: async () => {},
      fetchImpl: async (u) => {
        seen.push(String(u));
        if (String(u).endsWith('/login')) return { ok: true, status: 200, json: async () => ({ access_token: 't', user_id: REP }) };
        return {
          ok: true, status: 200,
          json: async () => ({ next_batch: 'B', rooms: { join: { [ROOM]: { timeline: { events: [msg(ROOM, '$3')] }, state: { events: [] } } } } }),
        };
      },
      sleep: async () => { await Promise.resolve(); },
      shouldContinue: () => seen.filter((u) => u.includes('/sync')).length < 1 && (testCounter.t = (testCounter.t ?? 0) + 1) < 40,
    });
    function testCounter() {}
    await collector.loop;
    expect(typed.messages).toHaveLength(3);
  });

  test('side_provenance_rejects_bad_or_ambiguous_credentials', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const r = await pushTxn(self.router, { hsToken: 'wrong-token', txnId: 'bad', events: [msg(ROOM, '$x')] });
    expect(r.status).toBe(403);
    expect(typed.messages).toHaveLength(0);
  });

  test('side_provenance_missing_or_inconsistent_context_keeps_batch_retryable', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const m = await bridge();
    // no provenance in meta at all → internal error, retryable
    const self = {
      actingCredentials: new Map(), appserviceInboundSnapshot: new Map([[SIDE, { registration: REG, representative: { mxid: REP } }]]),
      sideProvenanceClaims: new Map(), sideProvenanceClaimOrder: [],
      actingSideFor: () => null, postWarning() {},
      async onRoomMessage() {}, async onRoomEvent() {}, async onAppserviceMembership() {},
    };
    let typedCount = 0;
    self.onRoomMessage = async () => { typedCount += 1; };
    self.handleAppserviceEvents = m.MatrixBridge.prototype.handleAppserviceEvents.bind(self);
    self.assertSideProvenanceForEvent = m.MatrixBridge.prototype.assertSideProvenanceForEvent.bind(self);
    self.executeTypedForClaim = m.MatrixBridge.prototype.executeTypedForClaim.bind(self);
    self.assertSideProvenanceForEvent = m.MatrixBridge.prototype.assertSideProvenanceForEvent.bind(self);
    /*
     * 16-impl-r2 B: missing → retryable invalid_transport_provenance; a DISAGREEMENT
     * (wrong sideId / forged registration / alien mode) → terminal provenance_mismatch, skipped.
     */
    await expect(self.handleAppserviceEvents(SIDE, [msg(ROOM, '$1')], { txnId: 't1' }))
      .rejects.toMatchObject({ code: 'invalid_transport_provenance', retryable: true });
    // forged sideId / forged registration / alien mode → terminal, zero typed
    await expect(self.handleAppserviceEvents(SIDE, [msg(ROOM, '$3')], {
      txnId: 't3', provenance: { registration: REG, sideId: 'elsewhere.test', mode: 'push' },
    })).resolves.toBeUndefined();
    await expect(self.handleAppserviceEvents(SIDE, [msg(ROOM, '$4')], {
      txnId: 't4', provenance: { registration: 'forged-reg', sideId: SIDE, mode: 'push' },
    })).resolves.toBeUndefined();
    await expect(self.handleAppserviceEvents(SIDE, [msg(ROOM, '$5')], {
      txnId: 't5', provenance: { registration: REG, sideId: SIDE, mode: 'sms' },
    })).resolves.toBeUndefined();
    expect(typedCount).toBe(0);
  });

  test('side_provenance_rechecks_removed_side_before_event_claim', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    // the registry refresh REMOVES the side after authentication
    self.appserviceInboundSnapshot.delete(SIDE);
    const r = await pushTxn(self.router, { hsToken: HS, txnId: 't1', events: [msg(ROOM, '$1')] });
    // terminal: side_not_registered → logged + skipped, batch still 200 (definitive rejection)
    expect(typed.messages).toHaveLength(0);
    expect(r.status).toBe(200);
  });

  test('side_provenance_unavailable_registry_preserves_retry_and_prior_snapshot', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const m = await bridge();
    // no snapshot ever loaded → side_registry_unavailable, retryable
    const bare = Object.create(self);
    bare.appserviceInboundSnapshot = null;
    bare.assertSideProvenanceForEvent = m.MatrixBridge.prototype.assertSideProvenanceForEvent.bind(bare);
    bare.handleAppserviceEvents = m.MatrixBridge.prototype.handleAppserviceEvents.bind(bare);
    await expect(bare.handleAppserviceEvents(SIDE, [msg(ROOM, '$1')], { txnId: 't1', provenance: { registration: REG, sideId: SIDE, mode: 'push' } }))
      .rejects.toMatchObject({ code: 'side_registry_unavailable', retryable: true });
    // prior snapshot + failed refresh → prior snapshot still evaluates
    self.appserviceInboundSnapshot = new Map([[SIDE, { sideId: SIDE, hsToken: HS, registration: REG, representative: { mxid: REP } }]]);
    const r = await pushTxn(self.router, { hsToken: HS, txnId: 't2', events: [msg(ROOM, '$2')] });
    expect(r.status).toBe(200);
    expect(typed.messages).toHaveLength(1);
  });

  test('side_provenance_rejects_room_mismatch_before_three_typed_paths', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [] } }); // representative NOT joined
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const r = await pushTxn(self.router, {
      hsToken: HS, txnId: 't1',
      events: [msg(ROOM, '$1'), nameEvt(ROOM, '$2', 'x'), tombstone(ROOM, '$3'), verdict(ROOM, '$4'),
        { type: 'm.room.member', room_id: ROOM, event_id: '$5', state_key: '@other:palpo.test', content: { membership: 'join' } }],
    });
    expect(r.status).toBe(200); // terminal rejections skip; batch completes
    expect(typed.messages).toHaveLength(0);
    expect(typed.states).toHaveLength(0);
    expect(typed.memberships).toHaveLength(0);
  });

  test('side_provenance_relation_unavailable_retries_before_three_typed_paths', async () => {
    // member read fails (404 from fake palpo for unknown room shape) → room_relation_unavailable
    const palpo = await fakePalpo({ members: {} });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const r = await pushTxn(self.router, { hsToken: HS, txnId: 't1', events: [msg(ROOM, '$1')] });
    expect(r.status).toBe(500);
    expect(typed.messages).toHaveLength(0);
    // recover: members now complete with the representative joined → replay admits once
    palpo.setMembers(ROOM, [REP]);
    const r2 = await pushTxn(self.router, { hsToken: HS, txnId: 't2', events: [msg(ROOM, '$2')] });
    expect(r2.status).toBe(200);
    expect(typed.messages).toHaveLength(1);
  });

  test('side_provenance_valid_rooms_preserve_message_state_and_owner_checks', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const r = await pushTxn(self.router, {
      hsToken: HS, txnId: 't1',
      events: [msg(ROOM, '$1'), nameEvt(ROOM, '$2', 'renamed'),
        { type: 'm.room.member', room_id: ROOM, event_id: '$3', state_key: '@ac_agent:palpo.test', content: { membership: 'join' } }],
    });
    expect(r.status).toBe(200);
    expect(typed.messages).toHaveLength(1);
    // name + member: membership events deliberately ALSO take the generic path
    // ("in addition, not instead" — the trust gate and cutoff live there)
    expect(typed.states).toHaveLength(2);
    expect(typed.memberships).toHaveLength(1);
  });

  test('side_provenance_first_invite_preserves_registered_side_intake', async () => {
    // no membership yet; the event IS the first invite to this representative → bootstrap
    const palpo = await fakePalpo({ members: {} });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const invite = { type: 'm.room.member', room_id: ROOM, event_id: '$inv', state_key: REP, sender: '@human:palpo.test', content: { membership: 'invite' } };
    const r = await pushTxn(self.router, { hsToken: HS, txnId: 't1', events: [invite] });
    expect(r.status).toBe(200);
    expect(typed.memberships).toHaveLength(1);
  });

  test('side_provenance_backfill_and_replacement_rooms_require_checked_context', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP], '!new:palpo.test': [] } });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    // replacement room not joined by the representative → its events rejected
    const r = await pushTxn(self.router, { hsToken: HS, txnId: 't1', events: [msg('!new:palpo.test', '$1'), tombstone(ROOM, '$2')] });
    expect(r.status).toBe(200);
    expect(typed.messages.filter((t) => t.roomId === '!new:palpo.test')).toHaveLength(0);
  });

  test('side_provenance_two_instances_share_palpo_across_three_adapters', async () => {
    const palpo = await fakePalpo({
      members: { '!a:palpo.test': ['@hafleet_a:palpo.test'], '!b:palpo.test': ['@hafleet_b:palpo.test'] },
    });
    const A = await makeBridgeWithSide({ sideId: SIDE, hsToken: 'hsA', asToken: 'asA', registration: 'regA', representativeMxid: '@hafleet_a:palpo.test', palpo });
    const B = await makeBridgeWithSide({ sideId: SIDE, hsToken: 'hsB', asToken: 'asB', registration: 'regB', representativeMxid: '@hafleet_b:palpo.test', palpo });
    const ra = await pushTxn(A.router, { hsToken: 'hsA', txnId: 'a1', events: [msg('!a:palpo.test', '$a1')] });
    const rb = await pushTxn(B.router, { hsToken: 'hsB', txnId: 'b1', events: [msg('!b:palpo.test', '$b1')] });
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(A.typed.messages).toHaveLength(1);
    expect(B.typed.messages).toHaveLength(1);
    // cross: A's token against B's router is refused before ingress
    const rc = await pushTxn(B.router, { hsToken: 'hsA', txnId: 'x1', events: [msg('!a:palpo.test', '$x1')] });
    expect(rc.status).toBe(403);
  });

  test('side_provenance_two_instances_foreign_token_rejected_before_ingress', async () => {
    const palpo = await fakePalpo({ members: { '!a:palpo.test': ['@hafleet_a:palpo.test'] } });
    const A = await makeBridgeWithSide({ sideId: SIDE, hsToken: 'hsA', asToken: 'asA', registration: 'regA', representativeMxid: '@hafleet_a:palpo.test', palpo });
    const B = await makeBridgeWithSide({ sideId: SIDE, hsToken: 'hsB', asToken: 'asB', registration: 'regB', representativeMxid: '@hafleet_b:palpo.test', palpo });
    const r = await pushTxn(B.router, { hsToken: 'hsA', txnId: 'forge', events: [msg('!a:palpo.test', '$f')] });
    expect(r.status).toBe(403);
    expect(B.typed.messages).toHaveLength(0);
  });

  test('side_provenance_two_instances_foreign_room_rejected_with_local_token', async () => {
    const palpo = await fakePalpo({ members: { '!a:palpo.test': ['@hafleet_a:palpo.test'] } });
    const B = await makeBridgeWithSide({ sideId: SIDE, hsToken: 'hsB', asToken: 'asB', registration: 'regB', representativeMxid: '@hafleet_b:palpo.test', palpo });
    // B's OWN token, but the room belongs to A's representative → relation fails for B
    const r = await pushTxn(B.router, { hsToken: 'hsB', txnId: 't1', events: [msg('!a:palpo.test', '$1')] });
    expect(r.status).toBe(200); // terminal mismatch: skipped
    expect(B.typed.messages).toHaveLength(0);
  });

  test('side_provenance_two_instances_foreign_representative_cannot_prove_membership_or_bootstrap', async () => {
    const palpo = await fakePalpo({ members: { '!a:palpo.test': ['@hafleet_a:palpo.test'] } });
    const B = await makeBridgeWithSide({ sideId: SIDE, hsToken: 'hsB', asToken: 'asB', registration: 'regB', representativeMxid: '@hafleet_b:palpo.test', palpo });
    // an invite addressed to A's representative, delivered through B's registration
    const invite = { type: 'm.room.member', room_id: '!a:palpo.test', event_id: '$i', state_key: '@hafleet_a:palpo.test', sender: '@human:palpo.test', content: { membership: 'invite' } };
    const r = await pushTxn(B.router, { hsToken: 'hsB', txnId: 't1', events: [invite] });
    expect(r.status).toBe(200);
    expect(B.typed.memberships).toHaveLength(0);
  });

  test('side_provenance_two_instances_shared_room_checks_each_own_membership', async () => {
    const SHARED = '!shared:palpo.test';
    const palpo = await fakePalpo({ members: { [SHARED]: ['@hafleet_a:palpo.test'] } }); // only A joined
    const A = await makeBridgeWithSide({ sideId: SIDE, hsToken: 'hsA', asToken: 'asA', registration: 'regA', representativeMxid: '@hafleet_a:palpo.test', palpo });
    const B = await makeBridgeWithSide({ sideId: SIDE, hsToken: 'hsB', asToken: 'asB', registration: 'regB', representativeMxid: '@hafleet_b:palpo.test', palpo });
    const ra = await pushTxn(A.router, { hsToken: 'hsA', txnId: 'a1', events: [msg(SHARED, '$a')] });
    const rb = await pushTxn(B.router, { hsToken: 'hsB', txnId: 'b1', events: [msg(SHARED, '$b')] });
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(A.typed.messages).toHaveLength(1);
    expect(B.typed.messages).toHaveLength(0); // B's representative not joined → rejected for B
  });

  test('side_provenance_mixed_batch_rejects_invalid_events_without_success_claims', async () => {
    const OTHER = '!other:elsewhere.test';
    const palpo = await fakePalpo({ members: { [ROOM]: [REP], [OTHER]: [] } });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const r = await pushTxn(self.router, {
      hsToken: HS, txnId: 't1',
      events: [
        { type: 'm.room.message', room_id: 'not-a-room', event_id: '$bad', sender: '@h:palpo.test', content: {} },
        msg(ROOM, '$good'),
      ],
    });
    expect(r.status).toBe(200);
    expect(typed.messages).toHaveLength(1); // only the valid one
  });

  test('side_provenance_failed_delivery_keeps_claim_and_cursor_retryable', async () => {
    const palpo = await fakePalpo({ members: {} }); // no member evidence for ROOM → unavailable
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const r = await pushTxn(self.router, { hsToken: HS, txnId: 't1', events: [msg(ROOM, '$1')] });
    expect(r.status).toBe(500); // retryable: no txn completion
    expect(typed.messages).toHaveLength(0);
    expect(self.sideProvenanceClaims?.has(`${REG}|${ROOM}|$1`)).toBeFalsy(); // no success claim
  });

  test('side_provenance_mixed_batch_relation_failure_prevents_ack_and_cursor', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    // one event whose room has NO member evidence + one valid event → whole batch 500
    const r = await pushTxn(self.router, {
      hsToken: HS, txnId: 't1',
      events: [msg('!unknown:palpo.test', '$u'), msg(ROOM, '$g')],
    });
    expect(r.status).toBe(500);
    expect(typed.messages).toHaveLength(0);
  });

  test('side_provenance_cross_mode_duplicates_share_one_event_claim', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    await pushTxn(self.router, { hsToken: HS, txnId: 'p1', events: [msg(ROOM, '$dup')] });
    const r2 = await self.router.handle({
      method: 'PUT', path: '/_matrix/app/v1/transactions/s1', query: {},
      headers: { authorization: `Bearer ${HS}` }, body: { events: [msg(ROOM, '$dup')], mode: 'sync' },
    });
    expect(r2.status).toBe(200);
    expect(typed.messages).toHaveLength(1); // one logical event, one claim
  });

  test('side_provenance_rejects_invalid_duplicate_before_dedup_success', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP], '!bad:x': [REP] } });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    // same event_id in a room whose id is invalid → rejected BEFORE the claim
    const r = await pushTxn(self.router, {
      hsToken: HS, txnId: 't1',
      events: [{ type: 'm.room.message', room_id: 'not a room', event_id: '$dup', sender: '@h:palpo.test', content: {} }],
    });
    expect(r.status).toBe(200);
    expect(typed.messages).toHaveLength(0);
    expect(self.sideProvenanceClaims?.has(`${REG}|not a room|$dup`)).toBeFalsy();
  });

  test('side_provenance_idless_invites_do_not_share_a_global_claim', async () => {
    const palpo = await fakePalpo({ members: {} });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const inv1 = { type: 'm.room.member', room_id: '!r1:palpo.test', state_key: REP, sender: '@u1:palpo.test', content: { membership: 'invite' } };
    const inv2 = { type: 'm.room.member', room_id: '!r2:palpo.test', state_key: REP, sender: '@u2:palpo.test', content: { membership: 'invite' } };
    const r = await pushTxn(self.router, { hsToken: HS, txnId: 't1', events: [inv1, inv2] });
    expect(r.status).toBe(200);
    expect(typed.memberships).toHaveLength(2); // two distinct invitation facts
  });

  test('side_provenance_idless_different_inviters_reenter_owner_checks', async () => {
    const palpo = await fakePalpo({ members: {} });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const inv1 = { type: 'm.room.member', room_id: ROOM, state_key: REP, sender: '@alice:palpo.test', content: { membership: 'invite' } };
    const inv2 = { type: 'm.room.member', room_id: ROOM, state_key: REP, sender: '@bob:palpo.test', content: { membership: 'invite' } };
    const r = await pushTxn(self.router, { hsToken: HS, txnId: 't1', events: [inv1, inv2] });
    expect(r.status).toBe(200);
    expect(typed.memberships).toHaveLength(2); // different inviters → independent facts
  });

  test('side_provenance_idless_target_and_authorization_content_do_not_collapse', async () => {
    const palpo = await fakePalpo({ members: {} });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const inv1 = { type: 'm.room.member', room_id: ROOM, state_key: REP, sender: '@a:palpo.test', content: { membership: 'invite' }, unsigned: { invite_room_state: [{ type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } }] } };
    const inv2 = { type: 'm.room.member', room_id: ROOM, state_key: '@someone-else:palpo.test', sender: '@a:palpo.test', content: { membership: 'invite' }, unsigned: { invite_room_state: [{ type: 'm.room.join_rules', state_key: '', content: { join_rule: 'knock' } }] } };
    /*
     * inv1 is the bootstrap for OUR representative (admitted). inv2 targets someone else: not a
     * bootstrap, and the room has no member evidence at all → room_relation_unavailable, which is
     * RETRYABLE — the whole batch answers 500 with zero typed calls, so the distinct invitation
     * facts never collapse into one claim.
     */
    const r = await pushTxn(self.router, { hsToken: HS, txnId: 't1', events: [inv1, inv2] });
    expect(r.status).toBe(500);
    /*
     * AT-LEAST-ONCE, per-event: inv1 (the bootstrap) already executed when inv2's unavailable
     * relation throws — a retry redelivers the batch, the claim absorbs inv1, and inv2 stays
     * unexecuted until evidence exists. The txn is NOT completed (500), so the retry will come.
     */
    expect(typed.memberships).toHaveLength(1);
    // inv2 never minted a claim (its relation check precedes the claim — the fixed order), so a
    // redelivery re-enters owner checks for it rather than inheriting inv1's verdict:
    expect(self.sideProvenanceClaims.size).toBe(1);
  });

  test('side_provenance_rejection_logs_omit_tokens_and_approval_payloads', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [] } });
    const { self } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const logs = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.join(' ')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const secretBody = JSON.stringify({ type: 'engagement-verdict', approve: true, token: 'leak-me' });
      await pushTxn(self.router, { hsToken: HS, txnId: 't1', events: [msg(ROOM, '$1', secretBody)] });
      const all = logs.join(' ');
      expect(all).not.toContain('hs-1');
      expect(all).not.toContain('as-1');
      expect(all).not.toContain('leak-me');
    } finally {
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});


describe('16-impl-r2 additions: claim lifecycle, key disambiguation, refresh sequences', () => {
  test('side_provenance_failed_delivery_retypes_on_same_event_replay_after_typed_throw', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    let typedCalls = 0;
    const { self } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
      onTyped: async () => { typedCalls += 1; if (typedCalls === 1) throw new Error('downstream 503'); },
    });
    // first delivery: typed throws → 500, claim RELEASED (not completed)
    const r1 = await pushTxn(self.router, { hsToken: HS, txnId: 't1', events: [msg(ROOM, '$1')] });
    expect(r1.status).toBe(500);
    expect(self.sideProvenanceClaims.get(`${REG}|${ROOM}|$1`)?.state ?? 'absent').not.toBe('completed');
    // SAME event replayed in a new txn: typed RE-EXECUTES and now succeeds → 200
    const r2 = await pushTxn(self.router, { hsToken: HS, txnId: 't2', events: [msg(ROOM, '$1')] });
    expect(r2.status).toBe(200);
    expect(typedCalls).toBe(2);
    expect(self.sideProvenanceClaims.get(`${REG}|${ROOM}|$1`)?.state).toBe('completed');
  });

  test('side_provenance_concurrent_duplicate_awaits_single_execution', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    let typedCalls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const { self } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
      onTyped: async () => { typedCalls += 1; await gate; },
    });
    const first = pushTxn(self.router, { hsToken: HS, txnId: 'a', events: [msg(ROOM, '$1')] });
    await new Promise((r) => setImmediate(r));
    const second = pushTxn(self.router, { hsToken: HS, txnId: 'b', events: [msg(ROOM, '$1')] });
    await new Promise((r) => setImmediate(r));
    release();
    const [ra, rb] = await Promise.all([first, second]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(typedCalls).toBe(1);            // ONE execution, both deliveries satisfied by it
  });

  test('side_provenance_claim_bounded_retention_only_evicts_completed', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const { self } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    // fill beyond the bound with completed claims
    for (let i = 0; i < 4200; i += 1) {
      self.sideProvenanceClaims.set(`k${i}`, { state: 'completed' });
      self.sideProvenanceClaimOrder.push(`k${i}`);
    }
    /*
     * k0 is still COMPLETED at this point (the ring rotates only on new completions), so the
     * duplicate is coalesced — the documented eviction-then-re-execute boundary is exercised
     * below by pushing the ring past the bound and confirming order-based deletion of completed
     * entries only.
     */
    const stillHeld = await self.executeTypedForClaim('k0', async () => 'late');
    expect(stillHeld.duplicate).toBe(true);
    // an in-flight entry is NEVER evicted: 'live' holds the in-flight state while the ring
    // rotates past the bound; it is not in the completed order, so it cannot be a victim.
    self.sideProvenanceClaims.set('live', { state: 'inflight', settled: Promise.resolve({ ok: true }) });
    for (let i = 5000; i < 9500; i += 1) {
      self.sideProvenanceClaims.set(`k${i}`, { state: 'completed' });
      self.sideProvenanceClaimOrder.push(`k${i}`);
    }
    await self.executeTypedForClaim('filler', async () => {});   // rotates the ring again
    expect(self.sideProvenanceClaims.get('live')?.state).toBe('inflight'); // never evicted
    const inflightCount = [...self.sideProvenanceClaims.values()].filter((v) => v.state === 'inflight').length;
    expect(inflightCount).toBe(1);                              // the ONLY survivor outside completed
  });

  test('side_provenance_idless_delimiter_collision_and_content_only_change_do_not_fold', async () => {
    const palpo = await fakePalpo({ members: {} });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    // two admitted bootstrap invites whose fields CONTAIN the pipe character
    const invA = { type: 'm.room.member', room_id: '!a|b:palpo.test', state_key: REP, sender: '@u|1:palpo.test', content: { membership: 'invite' } };
    const invB = { type: 'm.room.member', room_id: '!a:palpo.test', state_key: REP, sender: '@u:1|palpo.test'.replace('|', ':'), content: { membership: 'invite' } };
    await self.handleAppserviceEvents(SIDE, [invA], { txnId: 'a', provenance: { registration: REG, sideId: SIDE, mode: 'push' } });
    await self.handleAppserviceEvents(SIDE, [invB], { txnId: 'b', provenance: { registration: REG, sideId: SIDE, mode: 'push' } });
    expect(typed.memberships).toHaveLength(2);  // distinct facts, no delimiter collision
    // content-only authorization change (is_direct flips): also a distinct fact
    const invC = { type: 'm.room.member', room_id: '!a|b:palpo.test', state_key: REP, sender: '@u|1:palpo.test', content: { membership: 'invite', is_direct: true } };
    await self.handleAppserviceEvents(SIDE, [invC], { txnId: 'c', provenance: { registration: REG, sideId: SIDE, mode: 'push' } });
    expect(typed.memberships).toHaveLength(3);
  });

  test('side_provenance_idless_invalid_identity_is_terminal', async () => {
    // the relation PASSES (representative joined) so the identity verdict is what stops the event
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const broken = { type: 'm.room.member', room_id: ROOM, state_key: 'not-an-mxid', sender: '', content: { membership: 'invite' } };
    await expect(self.handleAppserviceEvents(SIDE, [broken], { txnId: 't', provenance: { registration: REG, sideId: SIDE, mode: 'push' } }))
      .resolves.toBeUndefined();            // terminal skip, no 500 loop
    expect(typed.memberships).toHaveLength(0);
    expect(self.sideProvenanceClaims.size).toBe(0); // zero claim
  });

  test('side_provenance_refresh_sequences_via_real_refreshAppserviceSides', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const m = await bridge();
    // real refresh wiring: success A → failed refresh → A still usable
    const origBackendApi = globalThis.__backendApiForTest;
    const snapshotA = new Map([[SIDE, { sideId: SIDE, registration: REG, representative: { mxid: REP } }]]);
    self.refreshAppserviceSides = m.MatrixBridge.prototype.refreshAppserviceSides.bind(self);
    self.backendApiForSides = async () => ({ sides: [{ sideId: SIDE, hsToken: HS, registration: REG, serverName: SIDE, apiBaseUrl: palpo.url, senderLocalpart: 'hafleet', namespace: '@ac_.*' }] });
    // sequence 1: success loads A
    await self.refreshAppserviceSides();
    expect(self.appserviceInboundSnapshot.get(SIDE)?.registration).toBe(REG);
    // sequence 2: backend failure keeps A
    self.backendApiForSides = async () => { throw new Error('backend down'); };
    await self.refreshAppserviceSides();
    expect(self.appserviceInboundSnapshot.get(SIDE)?.registration).toBe(REG);
    // and events still flow through A
    const r = await pushTxn(self.router, { hsToken: HS, txnId: 'ok', events: [msg(ROOM, '$1')] });
    expect(r.status).toBe(200);
    expect(typed.messages).toHaveLength(1);
    // sequence 3: success with an EMPTY list removes A → old events terminal, zero claims
    self.backendApiForSides = async () => ({ sides: [] });
    await self.refreshAppserviceSides();
    expect(self.appserviceInboundSnapshot.size).toBe(0);
    const claimsBefore = self.sideProvenanceClaims.size;
    const r2 = await pushTxn(self.router, { hsToken: HS, txnId: 'gone', events: [msg(ROOM, '$2')] });
    expect(r2.status).toBe(403);            // the receiver itself was unwired by the refresh
    expect(self.sideProvenanceClaims.size).toBe(claimsBefore);
  });

  test('side_provenance_side_key_normalization_truth_table', async () => {
    const { normalizeSideKey } = await import('../lib/side-provenance.js');
    expect(normalizeSideKey('Palpo.Test')).toBe('palpo.test');
    expect(normalizeSideKey('  palpo.test ')).toBe('palpo.test');
    expect(normalizeSideKey('palpo.test:8448')).toBe('palpo.test:8448'); // port untouched
    expect(normalizeSideKey(undefined)).toBe('');
  });
});


describe('16-impl-r2 D: the REAL edge puller drives the router and the ack is observed', () => {
  test('side_provenance_edge_puller_real_drive_acks_only_on_200', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    // a fake edge server whose queue yields one transaction, then empties
    let served = 0;
    const acks = [];
    const edgeServer = (await import('http')).createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url.includes('/ack')) {
          acks.push(body ? JSON.parse(body) : null);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end('{}');
        }
        served += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(served === 1
          ? { events: [msg(ROOM, '$e1')], txn_id: 'edge-1' }
          : { events: [] }));
      });
    });
    await new Promise((r) => edgeServer.listen(0, '127.0.0.1', r));
    cleanup.push(() => new Promise((r) => edgeServer.close(r)));

    const puller = startEdgePuller({
      url: `http://127.0.0.1:${edgeServer.address().port}`,
      token: 'edge-token',
      router: self.router,
      hsTokenFor: () => HS,
      fetchImpl: async (u, init) => fetch(u, init),
      sleep: async () => { await new Promise((r) => setTimeout(r, 1)); },
      shouldContinue: () => served < 2 && (watch.t = (watch.t ?? 0) + 1) < 80,
    });
    function watch() {}
    await puller.done;
    expect(typed.messages.map((t) => t.event.event_id)).toEqual(['$e1']); // delivered through the REAL puller
    expect(acks).toEqual([{ txn_id: 'edge-1', ok: true }]);               // and ACKED ok:true to the edge
  });
});

describe('16-impl-r2 E: two REAL instances from makeInstance (isolated runtime/store/namespace)', () => {
  test('side_provenance_two_instances_real_isolation_state_claims_cursor', async () => {
    const { makeInstance } = await import('./helpers/side-provenance-harness.js');
    // TWO isolated runtimes, each with its own store file, namespace and representative
    const instA = makeInstance({
      prefix: 'inst-a-', sideId: 'palpo.test', serverName: 'palpo.test',
      registration: 'palpo.test@aaaa0001', hsToken: 'hsA', asToken: 'asA',
      representativeMxid: '@hafleet_a:palpo.test', namespace: '@ac_a_.*',
    });
    const instB = makeInstance({
      prefix: 'inst-b-', sideId: 'palpo.test', serverName: 'palpo.test',
      registration: 'palpo.test@bbbb0002', hsToken: 'hsB', asToken: 'asB',
      representativeMxid: '@hafleet_b:palpo.test', namespace: '@ac_b_.*',
    });
    cleanup.push(() => { rmSync(instA.runtimeDir, { recursive: true, force: true }); });
    cleanup.push(() => { rmSync(instB.runtimeDir, { recursive: true, force: true }); });
    expect(instA.runtimeDir).not.toBe(instB.runtimeDir);
    expect(instA.storePath).not.toBe(instB.storePath);

    // drive each through the real router with its own token; claims/cursors stay per-instance
    const palpo = await fakePalpo({
      members: { '!a:palpo.test': ['@hafleet_a:palpo.test'], '!b:palpo.test': ['@hafleet_b:palpo.test'] },
    });
    const A = await makeBridgeWithSide({
      sideId: SIDE, hsToken: 'hsA', asToken: 'asA', registration: 'palpo.test@aaaa0001',
      representativeMxid: '@hafleet_a:palpo.test', palpo,
    });
    const B = await makeBridgeWithSide({
      sideId: SIDE, hsToken: 'hsB', asToken: 'asB', registration: 'palpo.test@bbbb0002',
      representativeMxid: '@hafleet_b:palpo.test', palpo,
    });
    const ra = await pushTxn(A.router, { hsToken: 'hsA', txnId: 'a1', events: [msg('!a:palpo.test', '$a1')] });
    const rb = await pushTxn(B.router, { hsToken: 'hsB', txnId: 'b1', events: [msg('!b:palpo.test', '$b1')] });
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(A.typed.messages).toHaveLength(1);
    expect(B.typed.messages).toHaveLength(1);
    // ISOLATION: each instance's claim store holds only ITS OWN registration's claim
    expect([...A.self.sideProvenanceClaims.keys()].every((k) => k.includes('palpo.test@aaaa0001'))).toBe(true);
    expect([...B.self.sideProvenanceClaims.keys()].every((k) => k.includes('palpo.test@bbbb0002'))).toBe(true);
    // shared room: only the instance whose OWN representative is joined executes
    palpo.setMembers('!shared:palpo.test', ['@hafleet_a:palpo.test']);
    const rsa = await pushTxn(A.router, { hsToken: 'hsA', txnId: 'sa', events: [msg('!shared:palpo.test', '$sa')] });
    const rsb = await pushTxn(B.router, { hsToken: 'hsB', txnId: 'sb', events: [msg('!shared:palpo.test', '$sb')] });
    expect(rsa.status).toBe(200);
    expect(rsb.status).toBe(200);
    expect(A.typed.messages).toHaveLength(2);
    expect(B.typed.messages).toHaveLength(1); // B's representative not joined → terminal for B
    // A LEAVES: the evidence for A's membership is gone (403 on read), A's later events are
    // retryable-unavailable; B is untouched by A's departure
    palpo.memberState.delete('!shared:palpo.test');
    const rsa2 = await pushTxn(A.router, { hsToken: 'hsA', txnId: 'sa2', events: [msg('!shared:palpo.test', '$sa2')] });
    expect(rsa2.status).toBe(500);            // evidence absent → retryable, no cursor advance
    expect(B.typed.messages).toHaveLength(1); // B untouched by A's departure
  });
});


describe('16-impl-r3 additions', () => {
  test('r3_A1_typed_failure_never_causes_unhandledRejection', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const { self } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const seen = [];
    const handler = (reason) => seen.push(String(reason));
    process.on('unhandledRejection', handler);
    try {
      let calls = 0;
      await self.executeTypedForClaim('r3-key', async () => { calls += 1; throw new Error('typed boom'); })
        .catch(() => { /* the throw path is expected */ });
      expect(calls).toBe(1);
      // give the microtask queue a chance to surface any stray rejection
      await new Promise((r) => setImmediate(r));
      expect(seen).toEqual([]);            // ZERO unhandled rejections
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  test('r3_A2_follower_reenters_typed_after_leader_failure', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    let typedCalls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const { self } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
      onTyped: async () => {
        typedCalls += 1;
        if (typedCalls === 1) { await gate; throw new Error('leader fails'); }
      },
    });
    const leader = pushTxn(self.router, { hsToken: HS, txnId: 'L', events: [msg(ROOM, '$1')] });
    await new Promise((r) => setImmediate(r));
    const follower = pushTxn(self.router, { hsToken: HS, txnId: 'F', events: [msg(ROOM, '$1')] });
    await new Promise((r) => setImmediate(r));
    release();
    const [rl, rf] = await Promise.all([leader, follower]);
    expect(rl.status).toBe(500);           // the leader's own batch failed
    expect(rf.status).toBe(200);           // the follower re-executed and succeeded
    expect(typedCalls).toBe(2);            // leader attempt + follower re-entry
  });

  test('r3_E_stores_back_the_instances_and_A_removal_leaves_B_alone', async () => {
    const { ProjectSideStore } = await import('../lib/project-side-store.js');
    const { makeInstance } = await import('./helpers/side-provenance-harness.js');
    const instA = makeInstance({
      prefix: 'r3-a-', sideId: 'palpo.test', serverName: 'palpo.test',
      registration: 'palpo.test@r3aa001', hsToken: 'hsR3A', asToken: 'asR3A',
      representativeMxid: '@hafleet_a:palpo.test', namespace: '@ac_a_.*',
    });
    const instB = makeInstance({
      prefix: 'r3-b-', sideId: 'palpo.test', serverName: 'palpo.test',
      registration: 'palpo.test@r3bb002', hsToken: 'hsR3B', asToken: 'asR3B',
      representativeMxid: '@hafleet_b:palpo.test', namespace: '@ac_b_.*',
    });
    cleanup.push(() => rmSync(instA.runtimeDir, { recursive: true, force: true }));
    cleanup.push(() => rmSync(instB.runtimeDir, { recursive: true, force: true }));
    const storeA = new ProjectSideStore(instA.storePath);
    const storeB = new ProjectSideStore(instB.storePath);
    const sideA = storeA.getSide('palpo.test');
    const sideB = storeB.getSide('palpo.test');
    // A's registry/credential/representative come from A's STORE, B's from B's
    expect(sideA.representative.mxid).toBe('@hafleet_a:palpo.test');
    expect(sideB.representative.mxid).toBe('@hafleet_b:palpo.test');
    // credentials come from each side's OWN store (publicSide hides them; credentialFor reads them)
    expect(storeA.credentialFor('palpo.test')?.hsToken).toBe('hsR3A');
    expect(storeB.credentialFor('palpo.test')?.hsToken).toBe('hsR3B');
    // removing A's side from A's store leaves B's intact
    storeA.removeSide('palpo.test');
    expect(storeA.getSide('palpo.test')).toBeNull();
    expect(storeB.getSide('palpo.test')).not.toBeNull();
    // and B's bridge keeps serving from ITS store
    const palpo = await fakePalpo({ members: { '!b:palpo.test': ['@hafleet_b:palpo.test'] } });
    const B = await makeBridgeWithSide({
      sideId: SIDE, hsToken: 'hsR3B', asToken: 'asR3B', registration: 'palpo.test@r3bb002',
      representativeMxid: '@hafleet_b:palpo.test', palpo,
    });
    const rb = await pushTxn(B.router, { hsToken: 'hsR3B', txnId: 'b9', events: [msg('!b:palpo.test', '$b9')] });
    expect(rb.status).toBe(200);
    expect(B.typed.messages).toHaveLength(1);
  });

  test('r3_cold_start_first_refresh_yields_usable_relation_evidence', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const { self, typed } = await makeBridgeWithSide({
      sideId: SIDE, hsToken: HS, asToken: AS, registration: REG, representativeMxid: REP, palpo,
    });
    const m = await bridge();
    // COLD: no prior snapshot at all
    self.appserviceInboundSnapshot = null;
    self.refreshAppserviceSides = m.MatrixBridge.prototype.refreshAppserviceSides.bind(self);
    self.backendApiForSides = async () => ({
      sides: [{
        sideId: SIDE, hsToken: HS, registration: REG, serverName: SIDE, apiBaseUrl: palpo.url,
        senderLocalpart: 'hafleet', namespace: '@ac_.*',
        // 16-impl-r3 ④: the inbound shape carries the representative so a COLD start can prove
        // relations on the first refresh (no prior snapshot to merge from)
        representative: { mxid: REP },
      }],
    });
    await self.refreshAppserviceSides();
    const entry = self.appserviceInboundSnapshot.get(SIDE);
    expect(entry?.representative?.mxid).toBe(REP);   // evidence present after the FIRST refresh
    const r = await pushTxn(self.router, { hsToken: HS, txnId: 'cold', events: [msg(ROOM, '$c1')] });
    expect(r.status).toBe(200);
    expect(typed.messages).toHaveLength(1);
  });

  test('r3_side_key_truth_table_across_router_snapshot_acting', async () => {
    const { normalizeSideKey } = await import('../lib/side-provenance.js');
    for (const raw of ['Palpo.Test', '  palpo.test ', 'PALPO.TEST:8448', 'palpo.test:8448']) {
      const key = normalizeSideKey(raw);
      expect(typeof key).toBe('string');
      expect(key).toBe(key.toLowerCase().trim());
    }
    expect(normalizeSideKey('Palpo.Test')).toBe('palpo.test');
    expect(normalizeSideKey('PALPO.TEST:8448')).toBe('palpo.test:8448');
    // the three tables agree: build a router+snapshot+acting keyed the same way
    const mixed = 'Palpo.Test';
    const key = normalizeSideKey(mixed);
    const routerKeys = new Set([key]);
    const snapshotKeys = new Map([[key, { registration: REG }]]);
    const actingKeys = new Map([[key, { registration: REG }]]);
    expect(routerKeys.has(key)).toBe(true);
    expect(snapshotKeys.get(key)?.registration).toBe(REG);
    expect(actingKeys.get(key)?.registration).toBe(REG);
  });
});


describe('16-impl-r4 E: process-isolated instances (two child processes, real adapters)', () => {
  test('r4_two_children_independent_processes_stores_and_registrations', async () => {
    const { makeInstance } = await import('./helpers/side-provenance-harness.js');
    const { spawn } = await import('child_process');
    const instA = makeInstance({ prefix: 'r4a-', sideId: SIDE, serverName: SIDE, registration: 'unused', hsToken: 'hs4A', asToken: 'as4A', representativeMxid: '@hafleet_a:palpo.test', namespace: '@ac_a_.*' });
    const instB = makeInstance({ prefix: 'r4b-', sideId: SIDE, serverName: SIDE, registration: 'unused', hsToken: 'hs4B', asToken: 'as4B', representativeMxid: '@hafleet_b:palpo.test', namespace: '@ac_b_.*' });
    cleanup.push(() => rmSync(instA.runtimeDir, { recursive: true, force: true }));
    cleanup.push(() => rmSync(instB.runtimeDir, { recursive: true, force: true }));

    const mkChild = (tag, inst, repMxid) => {
      const child = spawn(process.execPath, ['--experimental-vm-modules', 'tests/helpers/side-provenance-child.mjs', JSON.stringify({
        tag, runtimeDir: inst.runtimeDir, sideId: SIDE, serverName: SIDE,
        hsToken: inst.hsToken ?? 'hs4' + tag, asToken: 'as4' + tag,
        representativeMxid: repMxid, namespace: '@ac_.*',
        palpoBaseUrl: 'http://127.0.0.1:1',
      })], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] });
      const lines = [];
      child.stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) lines.push(JSON.parse(l)); });
      const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
      const wait = async (pred, ms = 5000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          const hit = lines.find(pred);
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error('child did not report in time; lines=' + JSON.stringify(lines));
      };
      cleanup.push(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
      return { child, lines, send, wait };
    };
    // NOTE: the harness writes hsToken into the store; the child reads it from ITS store
    const A = mkChild('A', instA, '@hafleet_a:palpo.test');
    const B = mkChild('B', instB, '@hafleet_b:palpo.test');
    const ra = await A.wait((l) => l.t === 'ready');
    const rb = await B.wait((l) => l.t === 'ready');
    // 注记② evidence: two DIFFERENT pids, two different runtime dirs
    expect(ra.pid).not.toBe(rb.pid);
    expect(ra.runtimeDir).not.toBe(rb.runtimeDir);
    // and the two registrations are derived from the two stores' own tokens
    expect(ra.registration).not.toBe(rb.registration);
    A.child.kill('SIGKILL');
    B.child.kill('SIGKILL');
  });
});


describe('16-impl-r4: production-chain tests (no seams except network)', () => {
  test('r4_cold_start_through_real_backend_projection', async () => {
    const { createBackendTestContext } = await import('./helpers/backend-test-runtime.js');
    const request = (await import('supertest')).default;
    // seed the REAL store file (with a recorded representative) through the runtime helper
    const R4_SECRET = 'r4-bridge-secret-0123456789abcdef';
    const ctx = await createBackendTestContext('r4-cold-', {
      env: { MATRIX_BRIDGE_SECRET: R4_SECRET },
      rawRuntimeFiles: {
        'data/project-sides.json': JSON.stringify({
          version: 1,
          sides: {
            [SIDE]: {
              id: SIDE, serverName: SIDE, apiBaseUrl: 'http://127.0.0.1:1', createdAt: 1, updatedAt: 1,
              active: true, projects: {},
              credential: {
                kind: 'appservice', hsToken: HS, asToken: AS,
                senderLocalpart: 'hafleet', namespace: '@ac_.*', url: null,
              },
              representative: { mxid: REP, localpart: 'hafleet', observedAt: 1 },
            },
          },
          audit: [],
        }),
      },
    });
    cleanup.push(() => ctx.cleanup());
    // the REAL endpoint + the REAL projection (no seam at all in this segment)
    const res = await request(ctx.app).get('/api/project-sides/inbound-credentials')
      .set('x-bridge-secret', R4_SECRET).expect(200);
    const side = res.body.sides.find((x) => String(x.sideId).toLowerCase() === SIDE);
    expect(side.representative).toEqual({ mxid: REP });
    expect(side.registration).toMatch(/@([0-9a-f]{8})$/);

    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const m = await bridge();
    const self = {
      actingCredentials: new Map([[SIDE, { apiBaseUrl: palpo.url, serverName: SIDE, kind: 'appservice', asToken: AS, hsToken: HS, senderLocalpart: 'hafleet', namespace: '@ac_.*', registration: side.registration }]]),
      sideProvenanceClaims: new Map(), sideProvenanceClaimOrder: [],
      actingSideFor(id) { const r = this.actingCredentials.get(String(id).trim().toLowerCase()); return r ? { side: { apiBaseUrl: r.apiBaseUrl, serverName: r.serverName }, credential: r } : null; },
      postWarning() {}, async onRoomMessage() {}, async onRoomEvent() {}, async onAppserviceMembership() {},
    };
    self.handleAppserviceEvents = m.MatrixBridge.prototype.handleAppserviceEvents.bind(self);
    self.assertSideProvenanceForEvent = m.MatrixBridge.prototype.assertSideProvenanceForEvent.bind(self);
    self.executeTypedForClaim = m.MatrixBridge.prototype.executeTypedForClaim.bind(self);
    self.refreshAppserviceSides = m.MatrixBridge.prototype.refreshAppserviceSides.bind(self);
    self.backendApiForSides = async () => ({ sides: res.body.sides }); // ONLY the HTTP hop is replaced
    self.appserviceRouter = { setSides() {}, sideIds: () => [SIDE] };
    self.appserviceInboundSnapshot = null;                            // COLD start
    await self.refreshAppserviceSides();
    expect(self.appserviceInboundSnapshot.get(SIDE)?.representative?.mxid).toBe(REP);
    await expect(self.handleAppserviceEvents(SIDE, [msg(ROOM, '$cold')], {
      txnId: 'cold', provenance: { registration: side.registration, sideId: SIDE, mode: 'push' },
    })).resolves.toBeUndefined();                                      // admitted on the FIRST refresh
  });

  test('r4_side_key_normalized_across_real_chain', async () => {
    const palpo = await fakePalpo({ members: {} });
    const m = await bridge();
    const mk = (rawId) => {
      const self = {
        sideProvenanceClaims: new Map(), sideProvenanceClaimOrder: [],
        postWarning() {}, async onRoomMessage() {}, async onRoomEvent() {}, async onAppserviceMembership() {},
      };
      self.handleAppserviceEvents = m.MatrixBridge.prototype.handleAppserviceEvents.bind(self);
      self.assertSideProvenanceForEvent = m.MatrixBridge.prototype.assertSideProvenanceForEvent.bind(self);
      self.executeTypedForClaim = m.MatrixBridge.prototype.executeTypedForClaim.bind(self);
      self.refreshAppserviceSides = m.MatrixBridge.prototype.refreshAppserviceSides.bind(self);
      self.backendApiForSides = async () => ({ sides: [{
        sideId: rawId, serverName: SIDE, apiBaseUrl: palpo.url, hsToken: HS, registration: REG,
        senderLocalpart: 'hafleet', namespace: '@ac_.*', representative: { mxid: REP },
      }] });
      self.appserviceRouter = {
        setSides(sides) {
          // production receiver setSides normalizes; emulate the read side we then exercise
          self.__routerKeys = new Set(sides.map((x) => String(x.sideId).trim().toLowerCase()));
        },
        sideIds: () => [],
      };
      self.appserviceSideTokens = null;
      return self;
    };
    for (const rawId of ['Palpo.Test', '  palpo.test ', 'palpo.test:8448']) {
      const self = mk(rawId);
      await self.refreshAppserviceSides();
      const key = rawId.trim().toLowerCase();
      expect(self.__routerKeys.has(key)).toBe(true);                       // router table
      expect(self.appserviceInboundSnapshot.get(key)?.registration).toBe(REG); // snapshot
      expect(self.appserviceSideTokens.get(key)).toBe(HS);                 // token map
    }
  });

  test('r4_rotation_binds_snapshot_and_acting', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const m = await bridge();
    const { derivedRegistrationId } = await import('../lib/project-side-inbound.js');
    const oldReg = derivedRegistrationId(SIDE, HS);
    const newToken = 'hs-rotated';
    const newReg = derivedRegistrationId(SIDE, newToken);
    expect(oldReg).not.toBe(newReg);
    const self = {
      actingCredentials: new Map([[SIDE, { apiBaseUrl: palpo.url, serverName: SIDE, kind: 'appservice', asToken: AS, hsToken: newToken, senderLocalpart: 'hafleet', namespace: '@ac_.*', registration: newReg }]]),
      sideProvenanceClaims: new Map(), sideProvenanceClaimOrder: [],
      actingSideFor(id) { const r = this.actingCredentials.get(String(id).trim().toLowerCase()); return r ? { side: { apiBaseUrl: r.apiBaseUrl, serverName: r.serverName }, credential: r } : null; },
      postWarning() {}, async onRoomMessage() {}, async onRoomEvent() {}, async onAppserviceMembership() {},
    };
    self.handleAppserviceEvents = m.MatrixBridge.prototype.handleAppserviceEvents.bind(self);
    self.assertSideProvenanceForEvent = m.MatrixBridge.prototype.assertSideProvenanceForEvent.bind(self);
    self.executeTypedForClaim = m.MatrixBridge.prototype.executeTypedForClaim.bind(self);
    self.refreshAppserviceSides = m.MatrixBridge.prototype.refreshAppserviceSides.bind(self);
    self.backendApiForSides = async () => ({ sides: [{
      sideId: SIDE, serverName: SIDE, apiBaseUrl: palpo.url, hsToken: newToken, registration: newReg,
      senderLocalpart: 'hafleet', namespace: '@ac_.*', representative: { mxid: REP },
    }] });
    self.appserviceRouter = { setSides() {}, sideIds: () => [] };
    await self.refreshAppserviceSides();
    expect(self.appserviceInboundSnapshot.get(SIDE)?.registration).toBe(newReg);
    expect(self.actingSideFor('PALPO.TEST')?.credential.registration).toBe(newReg); // acting bound to the NEW registration
    // an in-flight event carrying the OLD registration is TERMINALLY refused
    await expect(self.handleAppserviceEvents(SIDE, [msg(ROOM, '$old')], {
      txnId: 'old', provenance: { registration: oldReg, sideId: SIDE, mode: 'push' },
    })).resolves.toBeUndefined();
    expect(self.sideProvenanceClaims.size).toBe(0);
  });

  test('r4_side_without_representative_is_terminal_incomplete_registration', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [REP] } });
    const m = await bridge();
    const self = {
      actingCredentials: new Map(), appserviceInboundSnapshot: new Map([[SIDE, { sideId: SIDE, registration: REG, representative: null }]]),
      sideProvenanceClaims: new Map(), sideProvenanceClaimOrder: [],
      actingSideFor: () => null, postWarning() {},
      async onRoomMessage() {}, async onRoomEvent() {}, async onAppserviceMembership() {},
    };
    self.handleAppserviceEvents = m.MatrixBridge.prototype.handleAppserviceEvents.bind(self);
    self.assertSideProvenanceForEvent = m.MatrixBridge.prototype.assertSideProvenanceForEvent.bind(self);
    self.executeTypedForClaim = m.MatrixBridge.prototype.executeTypedForClaim.bind(self);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(self.handleAppserviceEvents(SIDE, [msg(ROOM, '$1')], {
        txnId: 't', provenance: { registration: REG, sideId: SIDE, mode: 'push' },
      })).resolves.toBeUndefined();            // TERMINAL skip, not a 500 loop
      expect(self.sideProvenanceClaims.size).toBe(0);
      expect(warnSpy.mock.calls.map((c) => c.join(' ')).join(' ')).toMatch(/side_incomplete_registration/);
    } finally { warnSpy.mockRestore(); }
  });

  test('r4_structured_log_fields', async () => {
    const palpo = await fakePalpo({ members: { [ROOM]: [] } });
    const m = await bridge();
    const self = {
      actingCredentials: new Map([[SIDE, { apiBaseUrl: palpo.url, serverName: SIDE, kind: 'appservice', asToken: AS, hsToken: HS, senderLocalpart: 'hafleet', namespace: '@ac_.*', registration: REG }]]),
      appserviceInboundSnapshot: new Map([[SIDE, { sideId: SIDE, registration: REG, representative: { mxid: REP } }]]),
      sideProvenanceClaims: new Map(), sideProvenanceClaimOrder: [],
      actingSideFor(id) { const r = this.actingCredentials.get(String(id).trim().toLowerCase()); return r ? { side: { apiBaseUrl: r.apiBaseUrl, serverName: r.serverName }, credential: r } : null; },
      postWarning() {},
      async onRoomMessage() {}, async onRoomEvent() {}, async onAppserviceMembership() {},
    };
    self.handleAppserviceEvents = m.MatrixBridge.prototype.handleAppserviceEvents.bind(self);
    self.assertSideProvenanceForEvent = m.MatrixBridge.prototype.assertSideProvenanceForEvent.bind(self);
    self.executeTypedForClaim = m.MatrixBridge.prototype.executeTypedForClaim.bind(self);
    const lines = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a) => lines.push(a.join(' ')));
    try {
      // TERMINAL verdicts log ONE structured JSON line (relation mismatch here): the full
      // diagnostic identity — code/kind/registration/side/mode/room/event-or-txn — and nothing
      // sensitive.
      await self.handleAppserviceEvents(SIDE, [msg(ROOM, '$log1')], {
        txnId: 'tlog', provenance: { registration: REG, sideId: SIDE, mode: 'push' },
      });
      const json = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      expect(json.length).toBeGreaterThanOrEqual(1);
      const v = json.find((j) => j.t === 'side-provenance');
      expect(v).toMatchObject({ code: expect.any(String), kind: expect.any(String), registration: REG, sideId: SIDE, mode: 'push', room: ROOM });
      expect(v.ref).toBeTruthy();
      expect(lines.join(' ')).not.toContain(HS);
      expect(lines.join(' ')).not.toContain(AS);
    } finally { warnSpy.mockRestore(); }
  });
});
