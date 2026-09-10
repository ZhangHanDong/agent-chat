/*
 * 16-impl-r5 E: a short-lived child process driving the REAL adapters.
 *
 * Lifecycle: config on argv (JSON). The child binds HAGENCY_RUNTIME_DIR BEFORE importing the
 * bridge, reads its OWN store through the real ProjectSideStore, projects through the real
 * inboundCredentialsProjection (the ONLY seam is the backend HTTP hop), refreshes through the
 * real refreshAppserviceSides wiring the REAL createAppserviceRouter, and then starts ONE REAL
 * adapter per config.mode:
 *   push → startAppserviceListener (real HTTP; the parent PUTs transactions at it)
 *   edge → startEdgePuller (pulls from the parent's fake edge)
 *   sync → startAppserviceSyncCollector (polls the parent's fake Palpo /sync)
 * Reports typed/claims/cursor/ack counts on stdout as NDJSON. stdin carries control ops only
 * (start/stop/report) — events NEVER enter through stdin.
 */
process.on('SIGTERM', () => process.exit(0));

const cfg = JSON.parse(process.argv[2] ?? '{}');
process.env.HAGENCY_RUNTIME_DIR = cfg.runtimeDir;

const emit = (obj) => process.stdout.write(`${JSON.stringify({ ...obj, pid: process.pid })}\n`);

const { ProjectSideStore } = await import('../../lib/project-side-store.js');
const { inboundCredentialsProjection } = await import('../../lib/project-side-inbound.js');
const { createAppserviceRouter } = await import('../../lib/appservice-receiver.js');
const { startAppserviceListener } = await import('../../lib/appservice-listener.js');
const { startEdgePuller } = await import('../../lib/appservice-puller.js');
const { startAppserviceSyncCollector } = await import('../../lib/appservice-sync.js');
const { pathToFileURL } = await import('url');
const path = await import('path');

const store = new ProjectSideStore(path.resolve(cfg.runtimeDir, 'data', 'project-sides.json'));
const publicSide = store.getSide(cfg.serverName);
const credential = store.credentialFor(cfg.serverName);
const projected = inboundCredentialsProjection(publicSide, credential);

const bridgeUrl = pathToFileURL(path.resolve(process.cwd(), 'bridge-matrix.js')).href;
const m = await import(`${bridgeUrl}?child=${cfg.tag}`);
const proto = m.MatrixBridge.prototype;

const counters = { typed: 0, ack: 0, cursor: 0, refused: 0 };
const typedDetail = [];
const self = {
  appserviceRouter: null,
  appserviceSideTokens: null,
  appserviceInboundSnapshot: null,
  sideProvenanceClaims: new Map(),
  sideProvenanceClaimOrder: [],
  actingCredentials: new Map([[cfg.sideId, {
    apiBaseUrl: cfg.palpoBaseUrl, serverName: cfg.serverName, kind: 'appservice',
    asToken: projected?.asToken ?? cfg.asToken, hsToken: projected?.hsToken,
    senderLocalpart: projected?.senderLocalpart ?? 'hagency', namespace: projected?.namespace ?? '@ac_.*',
    registration: projected?.registration ?? null,
  }]]),
  actingSideFor(id) {
    const row = this.actingCredentials.get(String(id).trim().toLowerCase());
    return row ? { side: { apiBaseUrl: row.apiBaseUrl, serverName: row.serverName }, credential: row } : null;
  },
  postWarning() {},
  async onRoomMessage(roomId, event) { counters.typed += 1; const d = { kind: 'message', roomId, eventId: event?.event_id ?? null }; typedDetail.push(d); emit({ t: 'typed', ...d }); },
  async onRoomEvent(roomId, event) { counters.typed += 1; const d = { kind: 'state', roomId, eventId: event?.event_id ?? null }; typedDetail.push(d); emit({ t: 'typed', ...d }); },
  async onAppserviceMembership(sideId, roomId, event) { counters.typed += 1; const d = { kind: 'membership', roomId, eventId: event?.event_id ?? null }; typedDetail.push(d); emit({ t: 'typed', ...d }); },
};
self.handleAppserviceEvents = proto.handleAppserviceEvents.bind(self);
self.assertSideProvenanceForEvent = proto.assertSideProvenanceForEvent.bind(self);
self.executeTypedForClaim = proto.executeTypedForClaim.bind(self);
self.refreshAppserviceSides = proto.refreshAppserviceSides.bind(self);
self.refreshOutboundFleets = proto.refreshOutboundFleets.bind(self);
self.reconcileOutboundFleets = proto.reconcileOutboundFleets.bind(self);
self.refreshActingCredentials = proto.refreshActingCredentials.bind(self);
// THE ONLY SEAM: the backend HTTP hop returns the real projection over this child's real store.
self.backendApiForSides = async () => ({ sides: [projected] });

// REAL router, wired by the REAL refresh
self.appserviceRouter = createAppserviceRouter({
  sides: [{
    sideId: projected.sideId,
    hsToken: projected.hsToken,
    registration: projected.registration,
    onEvents: (events, meta) => self.handleAppserviceEvents(projected.sideId, events, {
      ...meta,
      provenance: { registration: projected.registration, sideId: projected.sideId, mode: meta?.mode ?? cfg.mode ?? 'push' },
    }),
    onUserQuery: async () => true,
  }],
});
self.appserviceSideTokens = new Map([[projected.sideId, projected.hsToken]]);

let adapters = [];
const startAdapters = async () => {
  await self.refreshAppserviceSides();
  if ((cfg.mode ?? 'push') === 'push') {
    const listener = await startAppserviceListener({ receiver: self.appserviceRouter, port: 0, host: '127.0.0.1' });
    adapters.push(() => listener.close());
    const port = listener.server?.address?.()?.port ?? listener.port;
    emit({ t: 'listening', port, registration: projected.registration });
  } else if (cfg.mode === 'edge') {
    const puller = startEdgePuller({
      url: cfg.edgeBaseUrl,
      token: cfg.edgeToken ?? 'edge-token',
      router: self.appserviceRouter,
      hsTokenFor: () => projected.hsToken,
      sleep: async () => { await new Promise((r) => setTimeout(r, 5)); },
      shouldContinue: () => !self.__stopped,
    });
    adapters.push(() => { self.__stopped = true; });
    // the puller exposes stats() as a function; read processed (= acked 200s) at report time
    self.__pullerStats = () => puller.stats();
    emit({ t: 'edge-started', registration: projected.registration });
  } else if (cfg.mode === 'sync') {
    const collector = startAppserviceSyncCollector({
      baseUrl: cfg.palpoBaseUrl, side: projected.sideId, router: self.appserviceRouter,
      credentialFor: () => ({
        kind: 'appservice', asToken: projected.hsToken, hsToken: projected.hsToken,
        senderLocalpart: projected.senderLocalpart ?? 'hagency',
      }),
      readCursor: () => self.__cursor ?? null,
      writeCursor: async (next) => { self.__cursor = next; counters.cursor += 1; },
      fetchImpl: (u, init) => fetch(u, init),
      sleep: async () => { await new Promise((r) => setTimeout(r, 5)); },
      shouldContinue: () => !self.__stopped,
    });
    adapters.push(() => { self.__stopped = true; });
    emit({ t: 'sync-started', registration: projected.registration });
  }
  emit({ t: 'ready', registration: projected.registration, runtimeDir: cfg.runtimeDir });
};

const rl = (await import('readline')).createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const req = JSON.parse(line);
  try {
    if (req.op === 'start') { await startAdapters(); return; }
    if (req.op === 'stop') {
      self.__stopped = true;
      for (const close of adapters) { try { close(); } catch { /* closing twice */ } }
      emit({
        t: 'report', typed: counters.typed, ack: counters.ack, cursor: counters.cursor,
        refused: counters.refused, claims: [...self.sideProvenanceClaims.keys()],
        snapshotRegistration: self.appserviceInboundSnapshot?.get(projected.sideId)?.registration ?? null,
        edgeProcessed: typeof self.__pullerStats === 'function' ? (self.__pullerStats().processed ?? 0) : null,
        typedDetail,
      });
      return;
    }
    if (req.op === 'refresh-empty') {
      // simulate the side being removed on the backend: the next refresh sees an empty list
      self.backendApiForSides = async () => ({ sides: [] });
      await self.refreshAppserviceSides();
      emit({ t: 'refreshed-empty', snapshotSize: self.appserviceInboundSnapshot.size });
      return;
    }
    if (req.op === 'rotate') {
      // rotate the token in THIS child's store; both projections then derive a new registration
      store.setCredential(cfg.serverName, { ...credential, hsToken: req.hsToken, asToken: req.asToken });
      const freshCred = store.credentialFor(cfg.serverName);
      const freshSide = store.getSide(cfg.serverName);
      const fresh = inboundCredentialsProjection(freshSide, freshCred);
      self.backendApiForSides = async () => ({ sides: [fresh] });
      await self.refreshAppserviceSides();
      self.actingCredentials.set(cfg.sideId, {
        ...self.actingCredentials.get(cfg.sideId),
        hsToken: fresh.hsToken, registration: fresh.registration,
      });
      emit({ t: 'rotated', registration: fresh.registration });
      return;
    }
  } catch (error) {
    emit({ t: 'err', message: String(error?.message ?? error), code: error?.code ?? null });
  }
});

