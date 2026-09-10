import { appserviceSyncOnce } from './appservice-sync.js';
import { buildSideProvenance } from './side-provenance.js';

/** Ordinary-token counterpart to appservice sync; no login or synthetic hs_token. */
export function startRepresentativeSyncCollector({
  side, baseUrl, registration, accessToken, representativeMxid, onEvents,
  readCursor = () => null, writeCursor = async () => {},
  readPendingReconcile = () => [], writePendingReconcile = async () => {},
  onReconcile = async () => {}, onLeaves = async () => {}, onCircuitBreak = () => {},
  onObservedTimeline = async () => {},
  onReconcileBlocked = async () => {},
  fetchImpl = fetch, logger = console, shouldContinue = () => true,
  sleep = (ms, signal) => new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  }),
}) {
  const provenance = buildSideProvenance({ sideId: side, registration, mode: 'sync' });
  const controller = new AbortController();
  const active = () => !controller.signal.aborted && shouldContinue();
  const stats = { polls: 0, processed: 0, failed: 0, batchAttempts: 0, lastError: null };
  const blockedReconciles = new Set();
  const reconcile = async () => {
    for (const roomId of readPendingReconcile()) {
      if (!active()) return;
      if (blockedReconciles.has(roomId)) continue;
      try {
        await onReconcile(roomId);
        if (active()) await writePendingReconcile(roomId, 'cleared');
      } catch (error) {
        if (error?.code === 'unproven_gap_boundary') {
          blockedReconciles.add(roomId);
          try { await onReconcileBlocked(roomId, error.message); }
          catch (warningError) { logger.warn?.(`[representative-sync] side ${side} blocked-recovery warning failed: ${warningError.message}`); }
        }
        logger.warn?.(`[representative-sync] side ${side} room ${roomId} reconcile failed: ${error.message}`);
      }
    }
  };
  const loop = (async () => {
    let backoff = 1_000;
    while (active()) {
      let deliveryFailed = false;
      try {
        await reconcile();
        if (!active()) break;
        const since = readCursor();
        const result = await appserviceSyncOnce({ baseUrl, accessToken, since, fetchImpl, signal: controller.signal });
        if (!active()) break;
        stats.polls += 1;
        // Stripped invite state is room metadata, not an admitted timeline. Palpo
        // puts create/name/rules before the membership invite and refuses member
        // reads until joined. Only the recorded representative's exact invite can
        // bootstrap that join through the shared provenance and inviter gates.
        const invites = result.inviteEvents.filter(event => event.type === 'm.room.member'
          && event.content?.membership === 'invite' && event.state_key === representativeMxid);
        const events = [...invites, ...(result.initial ? [] : [...result.timelineEvents, ...result.stateEvents])];
        try {
          if (events.length) await onEvents(events, { provenance, txnId: `representative-sync-${result.nextBatch}` });
          if (!active()) break;
          // Leaves revoke local reachability before committing the response.
          if (result.leaves.length) await onLeaves(result.leaves);
        } catch (error) {
          deliveryFailed = true;
          throw error;
        }
        if (!active()) break;
        // An initial timeline is historical baseline, not a missed live interval.
        if (!result.initial) {
          for (const roomId of result.roomsNeedingReconcile) {
            await writePendingReconcile(roomId, 'pending', { from: result.reconcileTokens[roomId] });
          }
        }
        await onObservedTimeline(result.timelineEvents);
        if (!active()) break;
        await writeCursor(result.nextBatch);
        stats.processed += 1;
        stats.batchAttempts = 0;
        stats.lastError = null;
        backoff = 1_000;
        await reconcile();
      } catch (error) {
        if (!active()) break;
        stats.failed += 1;
        stats.lastError = String(error?.message || error);
        if (deliveryFailed && ++stats.batchAttempts >= 8) {
          stats.gaveUp = true;
          try { onCircuitBreak({ attempts: stats.batchAttempts, heldCursor: readCursor(), lastError: stats.lastError }); }
          catch (warningError) { logger.warn?.(`[representative-sync] side ${side} circuit-break warning failed: ${warningError.message}`); }
          break;
        }
        logger.warn?.(`[representative-sync] side ${side} intake failed: ${stats.lastError}`);
        await sleep(deliveryFailed ? 1_000 : backoff, controller.signal);
        if (!deliveryFailed) backoff = Math.min(backoff * 2, 60_000);
      }
    }
  })();
  return { stop: () => controller.abort(), loop, stats };
}

/** Recover a limited timeline only as far back as a previously observed event. */
export async function reconcileRepresentativeTimeline({ from, knownEventIds, readPage, onEvents, maxPages = 10 }) {
  const unproven = message => Object.assign(new Error(message), { code: 'unproven_gap_boundary' });
  if (!from || !knownEventIds?.length) throw unproven('sync gap has no proven cursor/event boundary');
  const known = new Set(knownEventIds);
  const pending = [];
  let cursor = from;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await readPage(cursor);
    if (page?.known !== true) throw new Error(page?.reason || 'sync gap history is unavailable');
    for (const event of page.chunk ?? []) {
      if (known.has(event.event_id)) {
        await onEvents(pending.reverse());
        return;
      }
      if (event?.type === 'm.room.message' && event.event_id) pending.push(event);
    }
    if (!page.end || page.end === cursor || !page.chunk?.length) break;
    cursor = page.end;
  }
  throw unproven('sync gap history did not reach a previously observed event; recovery remains pending');
}
