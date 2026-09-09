# Palpo / HAFleet outbound transport review

Follow-up: [implementation and Mini1 acceptance](2026-09-08-palpo-outbound-implementation.md).
The findings below describe the pre-implementation state and are preserved as
the design review, rather than the current deployment status.

Reviewed HAFleet `39196ee` and Palpo `0736f991` / `0b11e786` after the operator
requested an independent agent review. The findings below combine that agent's
code inspection with the primary agent's verification of the cited paths.
This is an architectural review, not an implemented or tested outbound release.

## Finding: the deployed repair still needs a reverse connection

The deployment direction should be HAFleet initiating connections to public
Palpo. The current timeout repair improves bounded reads and concurrent request
handling but retains the reverse dependency:

- Palpo `web-admin/lib/workflow.mjs:41` builds its provider client from
  `fleet.callbackUrl`. Capabilities at line47, connection probes at line175,
  submission at line309 and request status at line352 all call HAFleet.
- HAFleet `lib/fleet-protocol.js:98` consumes protocol events but records a
  connection proof only for `mode === 'push'` at line101. An edge or sync-delivered
  event alone cannot make the existing fleet verification ready.
- HAFleet `lib/appservice-edge.js:19` describes its deliberate nonpersistent
  relay. It waits for processing acknowledgement and depends on homeserver
  retries; its defaults are a 30-second delivery wait and a 25-second poll.
  `lib/appservice-puller.js` and the bridge integration already provide an
  outbound Matrix transport building block, not a durable fleet business queue.

Consequently, changing a callback URL or enabling the existing puller does not
complete the requested deployment. The current Mini1 web release still relies
on the existing reverse connection.

Palpo already persists request records in SQLite (`web-admin/lib/store.mjs:12`).
The missing part is durable delivery with claims, leases and acknowledgements.
HAFleet's generic sync collector also filters `to_device` events
(`lib/appservice-sync.js:113`); it cannot replace the separate crypto client's
device/key processing. Preserve that channel and its stored crypto state.

## Proposed minimum implementation

Keep two distinct data flows with separate acknowledgement semantics:

| Data | Proposed direction and responsibility |
|---|---|
| Resource pools, models and roles | HAFleet POSTs a versioned snapshot; Palpo persists and serves it locally. |
| Heartbeat, decisions and Agent state | HAFleet POSTs monotonic updates; Palpo records the observed time and online/offline state. |
| Project Agent requests | Palpo validates the actor and project, persists the request and returns its stable ID. Offline HAFleet leaves it pending. |
| Request delivery | HAFleet long-polls Palpo, durably records each request, then acknowledges delivery. HAFleet retains allocation/approval authority. |
| Matrix AS events | Palpo's homeserver pushes to a colocated relay; HAFleet initiates event polling from that relay. |
| Matrix client operations and files | Continue using outbound Matrix client APIs, retaining identity, membership and encryption checks. |

Use separate fleet-scoped transport credentials; do not reuse browser sessions or
give the transport authority to approve resources. Bind messages to the fleet,
registration generation, server and project. Preserve the existing Matrix source
event and owner checks when HAFleet ingests a business request.

Use a persistent outbox/inbox and stable request ID plus payload digest. A retry
of the same ID and payload returns the same operation; a changed payload conflicts.
Delivery leases expire and can be reclaimed, with a generation/receipt token so an
old worker cannot acknowledge a newer lease. Delivery ACK means durably received;
it is separate from approval, allocation and fulfillment. Persist those results
before retrying their POST, and reject older status versions.

For durable Matrix relay mode, store the complete transaction under its original
ID before acknowledging it to the homeserver. HAFleet acknowledges the relay
only after its own durable event processing. Preserve ordering, duplicate handling,
registration isolation and retention limits. The existing transient edge can remain
an explicit alternative with its documented retry dependence; it must not be
silently described as a durable queue.

Revise readiness to prove receipt through the configured authenticated transport,
bound to the exact challenge/event and registration generation. Removing the
`push` condition without replacing its provenance checks would weaken the proof.

## Migration and acceptance

1. Add an explicit outbound transport version and credential exchange; preserve
   existing fleet, Agent, project and request IDs. Keep legacy callback mode explicit.
2. Implement durable business queues and HAFleet publishing/polling. Make the web
   UI read persisted snapshots and show freshness/offline state.
3. Install and wire the colocated Matrix relay, update registration/import fields,
   and replace the push-only proof with transport-specific verified receipt.
4. Exercise an isolated deployment with no route from Palpo to HAFleet. Then migrate
   the existing fleet with a rollback path; remove reverse forwarding only after
   the acceptance checks pass.

Required tests include disconnect/reconnect; crashes before and after persistence
and ACK; lease expiry and competing consumers; duplicate IDs and conflicting payloads;
out-of-order results; credential rotation/revocation; cross-fleet rejection; Matrix
event redelivery; and encrypted DM/group/file workflows. With all reverse forwards
disabled, resource publication, pending requests, contributor approval, fulfillment
and usage reporting must still work. Reconnection must not create a second allocation.

The existing 42 Palpo tests and live renewal check validate the deployed timeout
and renewal repair only. They do not establish any of the outbound acceptance above.
