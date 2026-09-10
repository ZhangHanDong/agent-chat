---
kind: requirement
id: REQ-PALPO-OUTBOUND
title: Hagency initiates every connection to the project deployment
status: Accepted
---

The operator requests implementation of the reviewed pure outbound transport.
Hagency publishes resources, heartbeats and results and actively claims durable
requests. Palpo serves persisted state and accepts established projects' requests
while Hagency is offline. The Matrix AS receiver runs beside Palpo and durably
relays transactions to Hagency's outbound collector. No inbound address on the
contributor or SSH reverse forwarding may be required by this transport.

Keep stable Matrix identities, project/request IDs, exact source-event authority,
contributor approval, private owner approvals, encrypted client devices and usage.
ACK means durably received, never approved or fulfilled. Leases, durable inbox and
outbox, content-bound idempotency and registration generations must survive crashes
and prevent duplicate allocations or stale acknowledgements/results. Existing
callback deployments remain an explicit legacy mode during migration.

The machine token is fleet scoped, independent of browser and Matrix credentials,
write-only in Hagency's public UI and invalidated by rotation/revocation. A real
authenticated Matrix delivery receipt is still required for initial connection.

Implement and verify in isolated Hagency and Palpo worktrees. Preserve concurrent
website work and the separate live Edison/xiaobai incident investigation. Coordinate
service replacement only after deterministic verification and an idle-state check.

The bridge owns a separate registration-bound transport inbox/outbox database;
it is not a second router task store. Its module `lib/fleet-outbound-store.js`
and the old-schema migration fixture `tests/fleet-outbound-store.test.js` may use
the pinned SQLite adapter directly. Router database access still goes through
`router/dist/index.js`, and these two files receive no exception for importing
router internals. Dependency checks reject all other non-router adapter owners.
