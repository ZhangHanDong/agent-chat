/*
 * 16-impl-r4 E: a SHORT-LIVED child process that binds its own runtime BEFORE importing the
 * bridge, so two children are genuinely independent module/process contexts (spec:57).
 *
 * The ONLY seam inside the child is the backend HTTP hop: `backendApiForSides` returns what the
 * REAL projection (lib/project-side-inbound.js) computes from THIS child's REAL store file.
 * Store read, projection, refresh, router, adapter, typed path are all production code.
 *
 * Protocol: config arrives on argv as JSON; the child reports lifecycle + typed results on
 * stdout as NDJSON; it exits on SIGTERM.
 */
process.on('SIGTERM', () => process.exit(0));

const cfg = JSON.parse(process.argv[2] ?? '{}');
process.env.HAFLEET_RUNTIME_DIR = cfg.runtimeDir;

const emit = (obj) => {
  process.stdout.write(`${JSON.stringify({ ...obj, pid: process.pid })}\n`);
};

const { ProjectSideStore } = await import('../../lib/project-side-store.js');
const { inboundCredentialsProjection } = await import('../../lib/project-side-inbound.js');
const { pathToFileURL } = await import('url');
const path = await import('path');

const store = new ProjectSideStore(path.resolve(cfg.runtimeDir, 'data', 'project-sides.json'));
const publicSide = store.getSide(cfg.serverName);
const credential = store.credentialFor(cfg.serverName);
const projected = inboundCredentialsProjection(publicSide, credential);
emit({ t: 'projection', registration: projected?.registration, representative: projected?.representative?.mxid ?? null });

const bridgeUrl = pathToFileURL(path.resolve(process.cwd(), 'bridge-matrix.js')).href;
const m = await import(`${bridgeUrl}?child=${cfg.tag}`);
const proto = m.MatrixBridge.prototype;

const self = {
  actingCredentials: new Map([[cfg.sideId, {
    apiBaseUrl: cfg.palpoBaseUrl, serverName: cfg.serverName, kind: 'appservice',
    asToken: cfg.asToken, hsToken: cfg.hsToken, senderLocalpart: cfg.representativeMxid.slice(1, cfg.representativeMxid.indexOf(':')),
    namespace: cfg.namespace, registration: projected?.registration ?? null,
  }]]),
  appserviceInboundSnapshot: null,
  sideProvenanceClaims: new Map(),
  sideProvenanceClaimOrder: [],
  actingSideFor(id) {
    const row = this.actingCredentials.get(String(id).trim().toLowerCase());
    return row ? { side: { apiBaseUrl: row.apiBaseUrl, serverName: row.serverName }, credential: row } : null;
  },
  postWarning() {},
  async onRoomMessage(roomId, event) { emit({ t: 'typed', kind: 'message', roomId, eventId: event?.event_id }); },
  async onRoomEvent(roomId, event) { emit({ t: 'typed', kind: 'state', roomId, eventId: event?.event_id }); },
  async onAppserviceMembership(sideId, roomId, event) { emit({ t: 'typed', kind: 'membership', roomId, eventId: event?.event_id }); },
};
self.handleAppserviceEvents = proto.handleAppserviceEvents.bind(self);
self.assertSideProvenanceForEvent = proto.assertSideProvenanceForEvent.bind(self);
self.executeTypedForClaim = proto.executeTypedForClaim.bind(self);
self.refreshAppserviceSides = proto.refreshAppserviceSides.bind(self);
/*
 * THE ONLY SEAM: the backend HTTP hop is replaced by the REAL projection over the REAL store of
 * THIS process. Nothing else is stubbed.
 */
self.backendApiForSides = async () => ({ sides: [projected] });
self.appserviceRouter = { setSides() { /* the child drives handleAppserviceEvents directly */ } };

emit({ t: 'ready', registration: projected?.registration, runtimeDir: cfg.runtimeDir });

// drive loop: each line on stdin is one transaction to deliver under this child's provenance
const rl = (await import('readline')).createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const req = JSON.parse(line);
  try {
    if (req.op === 'refresh') {
      await self.refreshAppserviceSides();
      const entry = self.appserviceInboundSnapshot.get(req.sideId ?? cfg.sideId);
      emit({ t: 'snapshot', registration: entry?.registration ?? null, representative: entry?.representative?.mxid ?? null });
      return;
    }
    if (req.op === 'deliver') {
      await self.handleAppserviceEvents(req.sideId ?? cfg.sideId, req.events, {
        txnId: req.txnId,
        provenance: { registration: projected.registration, sideId: cfg.sideId, mode: req.mode ?? 'push' },
      });
      emit({ t: 'txn-ok', txnId: req.txnId });
      return;
    }
    if (req.op === 'stats') {
      emit({
        t: 'stats', claims: [...self.sideProvenanceClaims.keys()],
        registration: projected?.registration,
      });
      return;
    }
  } catch (error) {
    emit({ t: 'txn-err', txnId: req.txnId ?? null, code: error?.code ?? null, message: String(error?.message ?? error) });
  }
});
