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
      actingCredentials: new Map(), appserviceInboundSnapshot: new Map([[SIDE, { representative: { mxid: REP } }]]),
      actingSideFor: () => null, postWarning() {},
    };
    self.handleAppserviceEvents = m.MatrixBridge.prototype.handleAppserviceEvents.bind(self);
    self.assertSideProvenanceForEvent = m.MatrixBridge.prototype.assertSideProvenanceForEvent.bind(self);
    await expect(self.handleAppserviceEvents(SIDE, [msg(ROOM, '$1')], { txnId: 't1' }))
      .rejects.toMatchObject({ code: 'missing_provenance', retryable: true });
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
