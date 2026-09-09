
/**
 * The third way in: a plain outbound /sync loop, with no socket and no edge process.
 *
 * WHY THIS EXISTS. The listener needs HAFleet to be reachable FROM the homeserver; the edge link
 * needs a second process running beside the homeserver. A fleet on a laptop behind NAT has neither.
 * But an application service can log in with its master token (`m.login.application_service`,
 * token = as_token, identifier = sender_localpart) and get an ordinary access token, then poll
 * /sync like any client — same direction as the customer's own phone. Palpo 0.4.0 supports the
 * flow; the login form was measured, not assumed.
 *
 * HALF-CONFIGURED IS REFUSED, not treated as off — same rule as the edge link. A side with no
 * homeserver URL is a secret with nowhere to go; a URL with no side is a poll for tokens we do
 * not hold. Default OFF: nothing is set, nothing runs, nothing is logged.
 */
export function resolveAppserviceSyncConfig(env = process.env) {
  let side = String(env.HAFLEET_APPSERVICE_SYNC_SIDE ?? '').trim();
  const baseUrl = String(env.HAFLEET_APPSERVICE_SYNC_URL ?? '').trim().replace(/\/+$/, '');
  if (!side && !baseUrl) {
    return { enabled: false, reason: 'HAFLEET_APPSERVICE_SYNC_SIDE is not set, so sync intake is not expected' };
  }
  if (side) {
    /*
     * SIDE NAMES ARE NORMALIZED, not merely trimmed. The project-side store lowercases server
     * names (they end up inside MXIDs and `Palpo.Test` is a typo, not a decision), and the
     * intake mutex is only sound if it compares the SAME spelling the store would: without
     * this, `Side-A` via sync plus `side-a` via edge sails past a per-side mutex and delivers
     * every event twice. URL-shaped and trailing-slash values are refused outright — a side
     * id is an identifier, not an address.
     */
    if (/\/\s*$/.test(side) || /^https?:\/\//i.test(side)) {
      return { enabled: false, reason: `HAFLEET_APPSERVICE_SYNC_SIDE must be a side id, not a URL or slash-suffixed value, got ${side}` };
    }
    side = side.toLowerCase();
  }
  if (!side) return { enabled: false, reason: 'HAFLEET_APPSERVICE_SYNC_URL is set but HAFLEET_APPSERVICE_SYNC_SIDE names no project side' };
  if (!baseUrl) return { enabled: false, reason: 'HAFLEET_APPSERVICE_SYNC_SIDE is set but HAFLEET_APPSERVICE_SYNC_URL names no homeserver' };
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { enabled: false, reason: `HAFLEET_APPSERVICE_SYNC_URL must be an absolute http(s) URL, got ${baseUrl}` };
  }
  return { enabled: true, side, baseUrl };
}

const LOGIN_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
// A refused transaction holds its cursor and retries forever: transient homeserver throttling
// must recover without an operator restart. Its independent exponential lane tops out near five
// minutes; Retry-After raises (and is capped like) the locally calculated delay when supplied.
const MAX_BATCH_BACKOFF_MS = 300_000;

/**
 * Login as the application service itself: m.login.application_service with the as_token and the
 * sender_localpart as identifier. The homeserver answers an ordinary access token. That token is
 * a PROCESS-LOCAL cache in the collector (see spec: never persisted, matching the in-memory-only
 * acting-credential design); a 401 later means it expired or the registration was re-issued, and
 * the caller decides whether one re-login is worth attempting before backing off.
 */
export async function appserviceLogin({ baseUrl, asToken, senderLocalpart, fetchImpl = fetch }) {
  /*
   * THE AS_TOKEN RIDES THE AUTHORIZATION HEADER, not (only) the body. The spec —
   * and palpo's handler, which calls require_access_token() before it looks at
   * anything else — authenticates m.login.application_service by the request's
   * access token. The first live smoke run answered 401 M_MISSING_TOKEN to a
   * body-only login that every fake-homeserver test had happily accepted; the
   * fake now refuses a login without this header so the suite stays honest.
   */
  const res = await fetchImpl(`${baseUrl}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${asToken}` },
    body: JSON.stringify({
      type: 'm.login.application_service',
      identifier: { type: 'm.id.user', user: senderLocalpart },
      token: asToken,
    }),
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`appservice login answered HTTP ${res.status}${body?.errcode ? ` ${body.errcode}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return { accessToken: body?.access_token ?? null, userId: body?.user_id ?? null };
}

/**
 * One /sync poll. `since` is the persisted next_batch cursor; the FIRST poll passes null and
 * reads next_batch WITHOUT delivering its join timeline (an initial sync replays history, and
 * replaying history is the duplicate storm the cursor exists to prevent) — but INVITES are
 * delivered even on the first poll: an invite sitting in the strainer while the fleet was down
 * must not wait for a second poll to be seen, or every restart silently delays the knock
 * handshake by up to one long-poll.
 *
 * The request carries an explicit filter: timeline limited to room events, presence offline,
 * no account_data and no to-device traffic. Membership/invite sections are NOT filtered — they
 * are the payload this intake exists to collect.
 */
export async function appserviceSyncOnce({ baseUrl, accessToken, since, timeoutMs = SYNC_TIMEOUT_MS, signal = null, fetchImpl = fetch }) {
  const url = new URL(`${baseUrl}/_matrix/client/v3/sync`);
  url.searchParams.set('timeout', '30000');
  url.searchParams.set('set_presence', 'offline');
  /*
   * The filter cuts account_data and to_device entirely and (above) forces presence
   * offline — the noise sources. The room timeline is deliberately UNRESTRICTED: a
   * first version sent `types: ["m.room.*"]`, and the live smoke against a real palpo
   * received exactly zero events forever — palpo's filter matches types literally
   * (its own doc comment promises '*' wildcards; the implementation does not deliver
   * them), so the "allowlist" silently swallowed every message and the long-poll
   * just timed out. Type-level routing already happens in the receiver, so wider
   * timeline delivery costs bandwidth only, never correctness.
   */
  const filter = { account_data: { types: [] }, to_device: { types: [] } };
  url.searchParams.set('filter', JSON.stringify(filter));
  if (since) url.searchParams.set('since', since);
  const res = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) {
    const err = new Error('sync answered 401');
    err.status = 401;
    throw err;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`sync answered HTTP ${res.status}`);
  /*
   * F08: an HTTP 200 with a MALFORMED body is an error, not a healthy poll.
   * `next_batch` absent (or not a string) means the body is not a sync
   * response — a proxy's HTML error page, a truncated read — and treating it
   * as success both recorded a bogus healthy poll and (worse) advanced nothing
   * while resetting backoff, spinning at full poll speed against a broken
   * endpoint. rooms not being an object (when present) is the same class.
   */
  if (typeof body?.next_batch !== 'string' || !body.next_batch) {
    const err = new Error('sync answered HTTP 200 with no next_batch — not a sync response');
    err.code = 'malformed_sync_body';
    throw err;
  }
  if (body.rooms !== undefined && (typeof body.rooms !== 'object' || body.rooms === null || Array.isArray(body.rooms))) {
    const err = new Error('sync answered HTTP 200 with a non-object rooms section');
    err.code = 'malformed_sync_body';
    throw err;
  }
  const timelineEvents = [];
  const inviteEvents = [];
  const stateEvents = [];
  const roomsNeedingReconcile = [];
  const reconcileTokens = {};
  const joins = body?.rooms?.join ?? {};
  for (const [roomId, room] of Object.entries(joins)) {
    const timeline = Array.isArray(room?.timeline?.events) ? room.timeline.events : [];
    for (const ev of timeline) timelineEvents.push({ ...ev, room_id: roomId });
    /*
     * F07: the sync projection dropped three signals the room's history
     * depends on. STATE events (m.room.member joins/leaves/power levels in the
     * state section) were never projected; a LEAVE (rooms.leave) vanished
     * entirely; and timeline.limited=true — the homeserver saying "there is a
     * gap you have not seen" — was ignored, so events in the gap were lost
     * without trace. All three now surface: state events ride the same batch,
     * leaves are reported per-room, and a limited timeline flags the room as
     * needing a reconcile (the caller re-pulls that room's history).
     */
    const state = Array.isArray(room?.state?.events) ? room.state.events : [];
    for (const ev of state) stateEvents.push({ ...ev, room_id: roomId });
    if (room?.timeline?.limited === true) {
      roomsNeedingReconcile.push(roomId);
      reconcileTokens[roomId] = room.timeline.prev_batch ?? null;
    }
  }
  const leaves = [];
  const leftRooms = body?.rooms?.leave ?? {};
  for (const roomId of Object.keys(leftRooms)) leaves.push(roomId);
  const invites = body?.rooms?.invite ?? {};
  for (const [roomId, room] of Object.entries(invites)) {
    const state = Array.isArray(room?.invite_state?.events) ? room.invite_state.events : [];
    for (const ev of state) inviteEvents.push({ ...ev, room_id: roomId });
  }
  return { nextBatch: body?.next_batch ?? null, timelineEvents, inviteEvents, stateEvents, leaves, roomsNeedingReconcile, reconcileTokens, initial: !since };
}

/**
 * The sync collect loop. Feeds the SAME router as listener/edge, shaped as a homeserver
 * transaction (txn key = the sync cursor, so a redelivery of the same cursor dedups), with the
 * side's hs_token as the router credential — no privileged short-cut past authentication.
 *
 * `readCursor`/`writeCursor` persist next_batch (state store); `credentialFor` yields
 * { asToken, hsToken, senderLocalpart } for the side. Backoff is exponential and resets on any
 * successful poll. A 401 triggers exactly ONE re-login attempt before backing off, so a rotated
 * registration is not hammered.
 */
export function startAppserviceSyncCollector({
  baseUrl,
  side,
  router,
  credentialFor,
  readCursor = () => null,
  writeCursor = async () => {},
  onLogin = () => {},
  /*
   * F09: fired when credentialFor() yields a DIFFERENT asToken than the one
   * this collector logged in with. The caller wires it to invalidate the
   * cached access token and the 401-relogin budget: a rotated registration
   * means the old token is dead no matter what generation it is.
   */
  onCredentialChanged = null,
  /*
   * F07: fired after a batch containing gap-flagged rooms (timeline.limited)
   * is accepted. The caller re-pulls those rooms' history; here we only
   * surface the signal — deciding HOW to backfill is the caller's policy.
   */
  onRoomsNeedingReconcile = null,
  /*
   * F07 (17-r2): rooms the sync moved OUT of `rooms.join` — the bridge drops
   * trust/mapping state for them. Awaited inside the poll's try so a cleanup
   * failure is logged without holding the cursor (the room is gone either way).
   */
  onLeaves = null,
  /*
   * F07 (17-r2) gap retry, option (b): persist reconcile rooms BEFORE the
   * cursor advances, retry at the TOP of every later poll until each succeeds.
   * Signature: () => string[] — the caller's durable store (bridge reads
   * `state.appserviceSyncReconcile[side]`); returns rooms still pending.
   */
  readPendingReconcile = null,
  writePendingReconcile = null,
  fetchImpl = fetch,
  logger = console,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  shouldContinue = () => true,
}) {
  const stats = { polls: 0, events: 0, processed: 0, failed: 0, logins: 0, lastError: null, lastErrorAt: null };
  let stopped = false;
  let accessToken = null;
  let credentialAsToken = null;   // F09: the asToken the current access token was minted from
  let backoffMs = 1_000;
  let batchBackoffMs = 1_000;
  /*
   * 401 LOOP BREAKER. A fresh token that is rejected by /sync means the problem is NOT the token
   * (a rotated registration would fail at login) — it is the homeserver or our account state.
   * Continuing to clear-and-relogin on that would hammer the login endpoint of a server that
   * just said no, so a 401 against a token WE minted this loop-session goes straight to backoff.
   */
  let loginGeneration = 0;

  const stop = () => { stopped = true; };
  const loop = (async () => {
    while (!stopped && shouldContinue()) {
      try {
        const credential = credentialFor();
        if (!credential?.asToken) throw new Error(`no appservice credential loaded for side ${side}`);
        /*
         * F09: a NEW asToken invalidates everything minted from the old one —
         * the cached access token AND the relogin budget. Without this, a
         * credential rotated while the 401 budget was exhausted kept a dead
         * token cached forever.
         */
        if (credentialAsToken && credential.asToken !== credentialAsToken) {
          accessToken = null;
          loginGeneration = 0;
          onCredentialChanged?.(side, { previousAsToken: credentialAsToken, asToken: credential.asToken });
        }
        credentialAsToken = credential.asToken;
        if (!accessToken) {
          const login = await appserviceLogin({ baseUrl, asToken: credential.asToken, senderLocalpart: credential.senderLocalpart, fetchImpl });
          accessToken = login.accessToken;
          loginGeneration += 1;
          stats.logins += 1;
          onLogin(login);
        }
        const since = readCursor();
        /*
         * F07 (17-r2) gap retry, option (b): pending reconcile rooms are retried
         * at the TOP of every poll, BEFORE this poll's own work — a room that
         * failed last round does not wait for the next gap to be seen again.
         * Success removes it from the durable store; failure keeps it (the
         * poll still proceeds — a sticky gap must not stop intake, it must be
         * retried until it clears, and the operator has the warn log).
         */
        if (readPendingReconcile) {
          for (const roomId of readPendingReconcile()) {
            try {
              await onRoomsNeedingReconcile?.(side, [roomId]);
              writePendingReconcile?.(roomId, 'cleared');
            } catch (retryError) {
              logger.warn?.(`[appservice-sync] pending reconcile retry for ${roomId} failed: ${retryError?.message || retryError}`);
            }
          }
        }
        const result = await appserviceSyncOnce({ baseUrl, accessToken, since, fetchImpl });
        // A room id alone cannot reconstruct the missed interval after cursor advancement.
        // Initial history remains governed by the separate invite-to-join policy.
        const reconcileBounds = result.initial
          ? { kind: 'join', from: null, to: result.nextBatch }
          : { kind: 'gap', from: since, to: result.nextBatch };
        stats.polls += 1;
        backoffMs = 1_000;
        /*
         * SUCCESS NORMALIZES THE 401 BREAKER'S BASELINE (5-r6 wording fix): this sync poll
         * answered, so the token WORKS. loginGeneration is set to 1 — "the healthy stretch's
         * FIRST (and current) valid token" — NOT "reset to 0": 0 is only ever the
         * never-logged-in state. A future 401 against this token may claim one fast
         * re-login; the guard in the catch compares === 1. This is the ONLY place the
         * generation is normalized; the truth table is written at the guard.
         */
        loginGeneration = accessToken ? 1 : 0;
        /*
         * INVITES FIRST, on EVERY poll including the first. An invite left pending while the
         * bridge was down is waiting to be seen; join-timeline skipping protects against replay,
         * and there is nothing to replay in an invite — the state section exists only in the
         * present. Shaped identically to a join event (room_id injected) so the router treats
         * them alike. NOTE ON IDEMPOTENCE: invite-section events carry NO event_id, so the
         * router's event-id dedup does not apply to them — a redelivered invite (restart
         * redelivery is routine here, since invites are delivered on every poll until the
         * homeserver advances the room out of the invite section) is made harmless by the
         * Matrix JOIN being idempotent plus the bridge's trust-state reconciliation, not by
         * dedup.
         */
        const deliverable = [...result.inviteEvents];
        let skipTimeline = result.initial;
        if (!result.initial) {
          deliverable.push(...result.timelineEvents);
          // F07: state events ride the SAME batch (membership/power changes are history)
          deliverable.push(...result.stateEvents);
        }
        /*
         * F07 (17-r2): leaves are a SIDE EFFECT of the batch, not payload — the
         * homeserver has already moved the room out of `rooms.join`, so there is
         * no event to deliver and no cursor semantics to protect. The hook runs
         * awaited INSIDE the try: a leave-cleanup failure is logged by the
         * bridge but must not hold the cursor (the room is gone either way, and
         * the next poll reports it again only if the homeserver disagrees).
         */
        if (result.leaves?.length) {
          try { await onLeaves?.(side, [...result.leaves]); } catch (leaveError) {
            logger.warn?.(`[appservice-sync] leave cleanup for side ${side} failed: ${leaveError?.message || leaveError}`);
          }
        }
        /*
         * SUCCESS-CURSOR-ADVANCE RESET (5-r6, R6 first-class). Refusals are consecutive for
         * ONE batch — they must not accumulate across a successful cursor advance. Every branch
         * below that advances the cursor on success calls resetBatchRetry(), so a NEW batch
         * always starts from attempts 0 and the base delay. The helper also clears
         * lastFailedBatch/lastError: a healthy advance means the previous failure is
         * resolved, and leaving it would have an operator diagnosing a stale break.
         */
        const resetBatchRetry = () => {
          stats.batchAttempts = 0;
          stats.lastFailedBatch = null;
          stats.lastError = null;
          stats.lastErrorAt = null;
          batchBackoffMs = 1_000;
        };
        if (deliverable.length) {
          /*
           * Txn id derived from the CURSOR, not a counter: a restart re-reads the same cursor and
           * the router's dedup window absorbs the redelivery, which is the property that makes
           * at-least-once delivery safe here. Dedup inside the receiver is by event_id.
           *
           * THE CURSOR MOVES ONLY AFTER A 200. Write it before handle() and a crash between the
           * two drops the batch entirely (cursor says consumed, events never processed); write
           * it after and a crash in the window replays the batch on restart, which the event-id
           * dedup absorbs. At-least-once, never at-most-once — the same side the rest of the
           * intake lands on.
           */
          const txnId = `sync-${result.nextBatch ?? `pre-${since ?? 'start'}`}`;
          const handled = await router.handle({
            method: 'PUT',
            path: `/_matrix/app/v1/transactions/${encodeURIComponent(txnId)}`,
            query: {},
            headers: { authorization: `Bearer ${credential.hsToken ?? ''}` },
            /*
             * F06: intake mode 'sync' — these events were PULLED by this collector under the
             * as_token it logged in with, so their authenticated registration is the one that
             * as_token belongs to; the mode distinguishes them from pushed/edge deliveries.
             */
            body: { events: deliverable },
            transport: { mode: 'sync', sideId: side },
          });
          stats.events += deliverable.length;
          if (handled?.status === 200) {
            stats.processed += 1;
            resetBatchRetry(); // a successful advance resets the retry count for the NEXT batch
            /*
             * F07 (17-r2) gap retry, option (b): DURABLY RECORD the gap rooms
             * BEFORE the cursor advances. A crash after writeCursor and before
             * the backfill would otherwise lose the gap forever — the cursor is
             * past the `timeline.limited` response and the homeserver will
             * never resend it. Recorded first, retried at the top of every
             * later poll until each clears; this branch's own attempt is
             * best-effort (the durable record is the guarantee, not this try).
             */
            if (result.roomsNeedingReconcile?.length) {
              for (const roomId of result.roomsNeedingReconcile) writePendingReconcile?.(roomId, 'pending', reconcileBounds);
            }
            if (result.nextBatch) await writeCursor(result.nextBatch);
            if (result.roomsNeedingReconcile?.length) {
              for (const roomId of result.roomsNeedingReconcile) {
                try {
                  await onRoomsNeedingReconcile?.(side, [roomId]);
                  writePendingReconcile?.(roomId, 'cleared');
                } catch { /* the durable record above is the guarantee; next poll retries */ }
              }
            }
          } else {
            /*
             * NOT 200 → the cursor does NOT advance and this batch is retried after backoff.
             * Advancing on failure would be silent data loss: the homeserver considers the
             * batch delivered (we consumed the sync response) and will never resend it.
             */
            stats.failed += 1;
            stats.lastError = `router answered ${handled?.status}`;
            stats.lastErrorAt = Date.now();
            stats.lastFailedBatch = result.nextBatch ?? null;
            const attempts = (stats.batchAttempts = (stats.batchAttempts ?? 0) + 1);
            const retryableBatch = new Error(stats.lastError);
            retryableBatch.code = 'retryable_batch';
            retryableBatch.attempts = attempts;
            retryableBatch.heldCursor = since ?? null;
            retryableBatch.failedNextBatch = result.nextBatch ?? null;
            if (Number.isFinite(handled?.retryAfterMs) && handled.retryAfterMs >= 0) {
              retryableBatch.retryAfterMs = handled.retryAfterMs;
            }
            throw retryableBatch;
          }
        } else if (result.nextBatch && !skipTimeline) {
          // Nothing deliverable: safe to advance the cursor — there is nothing to replay.
          if (result.roomsNeedingReconcile?.length) {
            for (const roomId of result.roomsNeedingReconcile) writePendingReconcile?.(roomId, 'pending', reconcileBounds);
          }
          await writeCursor(result.nextBatch);
          resetBatchRetry(); // an empty-batch advance is a successful advance (5-r6)
          // F07 (17-r2): an empty batch can still carry gap flags — reconcile regardless
          if (result.roomsNeedingReconcile?.length) {
            for (const roomId of result.roomsNeedingReconcile) {
              try {
                await onRoomsNeedingReconcile?.(side, [roomId]);
                writePendingReconcile?.(roomId, 'cleared');
              } catch { /* durable record retries next poll */ }
            }
          }
        } else if (result.nextBatch && skipTimeline) {
          /*
           * FIRST POLL: the initial join timeline is deliberately swallowed but the cursor must
           * still move past it, or every restart replays the whole history window. Invites (if
           * any) were delivered above; only after that delivery succeeded is the cursor safe.
           */
          if (result.roomsNeedingReconcile?.length) {
            for (const roomId of result.roomsNeedingReconcile) writePendingReconcile?.(roomId, 'pending', reconcileBounds);
          }
          await writeCursor(result.nextBatch);
          resetBatchRetry(); // the first-poll advance is a successful advance too (5-r6)
          // F07 (17-r2): even a swallowed initial timeline can flag gaps — reconcile anyway
          if (result.roomsNeedingReconcile?.length) {
            for (const roomId of result.roomsNeedingReconcile) {
              try {
                await onRoomsNeedingReconcile?.(side, [roomId]);
                writePendingReconcile?.(roomId, 'cleared');
              } catch { /* durable record retries next poll */ }
            }
          }
        }
      } catch (error) {
        stats.lastError = String(error?.message || error);
        stats.lastErrorAt = Date.now();
        if (error?.status === 401) {
          /*
           * ONE fast re-login per HEALTHY STRETCH (5-r5). The truth table, written out because
           * a reset nobody traced is how the breaker got dismantled:
           *
           *   loginGeneration is incremented on every successful login and decremented by
           *   NOTHING. It is NORMALIZED TO 1 ONLY by a successful sync poll (see the reset at
           *   the top of the loop, after `backoffMs = 1_000`): success means the token WORKED,
           *   so we are healthy again and a future 401 may claim its one fast re-login.
           *
           *   On a 401: the fast re-login (clear token, no sleep, continue) is allowed ONLY
           *   when loginGeneration === 1 — i.e. the token being rejected is the FIRST minted
           *   since the last success. Any higher value means we already burned the fast
           *   re-login for this stretch, so we fall through to the exponential backoff. The
           *   exhaustion branch below is therefore reachable by construction: any 401 arriving
           *   with loginGeneration >= 2 lands there, and the test named in the spec drives it
           *   with login-always-succeeds + sync-always-401.
           *
           *   The bug this replaces reset loginGeneration to 0 in the fast path, making the
           *   guard永真: generation went 1 → 0 → login → 1 → 0 … and the backoff branch was
           *   unreachable — a sleepless hammer of login+sync against the homeserver.
           */
          if (accessToken && loginGeneration === 1) {
            accessToken = null;
            logger.warn?.(`[appservice-sync] token rejected for side ${side}; logging in once more`);
            continue;
          }
          if (accessToken) {
            logger.error?.(`[appservice-sync] a fresh login token was rejected by sync for side ${side} — backing off, not re-logging in`);
          } else {
            logger.error?.(`[appservice-sync] re-login rejected for side ${side} — check the registration's as_token`);
          }
        } else {
          logger.warn?.(`[appservice-sync] poll failed for side ${side}: ${stats.lastError}`);
        }
        const isRetryableBatch = error?.code === 'retryable_batch';
        const retryAfterMs = Number(error?.retryAfterMs);
        const waitMs = isRetryableBatch
          ? Math.min(
            Number.isFinite(retryAfterMs) && retryAfterMs >= 0
              ? Math.max(retryAfterMs, batchBackoffMs)
              : batchBackoffMs,
            MAX_BATCH_BACKOFF_MS,
          )
          : backoffMs;
        if (isRetryableBatch) {
          logger.warn?.(`[appservice-sync] retryable batch for side ${side} attempt ${error.attempts}; `
            + `backing off ${waitMs}ms and retaining cursor ${error.heldCursor ?? '(none)'} `
            + `(failed next_batch ${error.failedNextBatch ?? '(none)'})`);
        }
        await sleep(waitMs);
        if (isRetryableBatch) {
          batchBackoffMs = Math.min(batchBackoffMs * 2, MAX_BATCH_BACKOFF_MS);
        } else {
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        }
      }
    }
  })();
  return { stop, stats, loop };
}
