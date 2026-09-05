/*
 * #16-impl shared harness: drives the REAL intake chain — push listener (HTTP) / edge puller /
 * sync collector → receiver/router → bridge handleAppserviceEvents — against a fake Palpo,
 * with an isolated ProjectSideStore per test (ruling C: independent registrations).
 */
import { createServer } from 'http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

export const MODES = ['push', 'edge', 'sync'];

export function bridgeUrl() {
  return pathToFileURL(path.resolve('bridge-matrix.js')).href;
}

/**
 * A fake Palpo: answers /whoami, room member reads, join, and records every request.
 * `interest` controls which registration's namespace a sync response serves.
 */
export async function fakePalpo({
  whoami = {},
  members = {},        // roomId -> [mxid, ...] joined members
  memberFailures = {}, // roomId -> HTTP status or a per-read status queue
  syncBatches = [],    // array of sync response bodies
  edgeQueue = [],      // array of { txnId, events }
} = {}) {
  const seen = [];
  const whoamiState = { ...whoami };
  const memberState = new Map(Object.entries(members).map(([k, v]) => [k, [...v]]));
  let syncIdx = 0;
  let edgeIdx = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = req.url ?? '';
      seen.push({ url, method: req.method, body: body ? JSON.parse(body) : null, auth: req.headers.authorization ?? null });
      const json = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (url.includes('/account/whoami')) {
        const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        const rec = whoamiState[token];
        if (!rec) return json(401, { errcode: 'M_UNKNOWN_TOKEN' });
        return json(200, { user_id: rec.mxid, device_id: 'DEV' });
      }
      if (/\/rooms\/[^/]+\/joined_members/.test(url)) {
        const roomId = decodeURIComponent(url.split('/rooms/')[1]?.split('/')[0] ?? '');
        const configuredFailure = memberFailures[roomId];
        const failure = Array.isArray(configuredFailure) ? configuredFailure.shift() : configuredFailure;
        if (failure) {
          const status = typeof failure === 'object' ? failure.status : failure;
          return json(status, {
            errcode: status === 429 ? 'M_LIMIT_EXCEEDED' : 'M_UNKNOWN',
            error: 'injected member read failure',
            ...(typeof failure === 'object' && Number.isFinite(failure.retryAfterMs)
              ? { retry_after_ms: failure.retryAfterMs }
              : {}),
          });
        }
        /*
         * A room with no member evidence answers 403, as a real homeserver does for a room the
         * credential's representative has no readable membership in — NOT an empty 200, which
         * would read as a definitive "not joined" and turn missing evidence into a terminal
         * mismatch. Evidence-absent must stay retryable (spec: relation unavailable).
         */
        if (!memberState.has(roomId)) return json(403, { errcode: 'M_FORBIDDEN' });
        const list = memberState.get(roomId) ?? [];
        return json(200, { joined: Object.fromEntries(list.map((m) => [m, 8])) });
      }
      if (/\/join\//.test(url)) {
        const roomId = decodeURIComponent(url.split('/join/')[1] ?? '');
        if (!memberState.has(roomId)) memberState.set(roomId, []);
        return json(200, { room_id: roomId });
      }
      if (url.includes('/login')) {
        // the sync collector logs in as the sender_localpart with the as_token
        return json(200, { user_id: '@hafleet:palpo.test', access_token: 'sync-access-token', device_id: 'DEV' });
      }
      if (url.includes('/_matrix/client/v3/sync')) {
        /*
         * 16-impl-r7: batches are served as a QUEUE (shift), not by index. An index races a
         * collector that polls before the test pushes its batches — the default empty answers
         * consume indices 0..n and the pushed batches become unreachable. A queue delivers each
         * pushed batch exactly once, whenever the next poll comes.
         */
        const batch = syncBatches.length ? syncBatches.shift() : { next_batch: `s${++syncIdx}`, rooms: {} };
        return json(200, batch);
      }
      if (url.includes('/_matrix/app/unstable/com.beeper.calendar/queue') || url.includes('/transactions')) {
        const next = edgeQueue[edgeIdx];
        edgeIdx += 1;
        if (!next) return json(200, { queue: [], next_batch: 'done' });
        return json(200, { queue: [next], next_batch: `e${edgeIdx}` });
      }
      return json(404, { errcode: 'M_NOT_FOUND' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    whoamiState,
    memberState,
    syncBatches,
    setMembers(roomId, list) { memberState.set(roomId, [...list]); },
    clearMemberFailure(roomId) { delete memberFailures[roomId]; },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** An isolated runtime + a one-side ProjectSideStore seeded through the real store API. */
export function makeInstance({ prefix = 'inst-', sideId, serverName, registration, hsToken, asToken, representativeMxid, namespace }) {
  const runtimeDir = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(runtimeDir, 'data'), { recursive: true });
  const storePath = path.join(runtimeDir, 'data', 'project-sides.json');
  writeFileSync(storePath, JSON.stringify({
    version: 1,
    sides: {
      [serverName]: {
        id: serverName,
        serverName,
        createdAt: 1,
        updatedAt: 1,
        apiBaseUrl: 'http://127.0.0.1:1',
        projects: {},
        credential: {
          kind: 'appservice',
          registration,
          hsToken,
          asToken,
          senderLocalpart: representativeMxid.slice(1, representativeMxid.indexOf(':')),
          namespace: namespace ?? '@ac_.*',
        },
        representative: representativeMxid
          ? { mxid: representativeMxid, localpart: representativeMxid.slice(1, representativeMxid.indexOf(':')), observedAt: 1 }
          : null,
      },
    },
    audit: [],
  }));
  return { runtimeDir, storePath, sideId, serverName };
}

/** A receiver-shaped router entry list for createAppserviceRouter, wired to a bridge. */
export function sideEntryFor(bridge, { sideId, hsToken, registration }) {
  return {
    sideId,
    hsToken,
    registration,
    onEvents: (events, meta) => bridge.handleAppserviceEvents(sideId, events, meta),
    onUserQuery: async () => true,
  };
}
