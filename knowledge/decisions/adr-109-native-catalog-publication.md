---
kind: decision
id: ADR-109
title: Publish coherent native resource catalogs through original outbound custody
status: Accepted
requirements: [REQ-RUST-MIGRATION-EXECUTION]
---

## Context

ADR108 changes the local resource catalog only. The native Palpo Adapter currently
publishes transport heartbeats; no caller composes current canonical resources.
The retained Palpo v2 updates protocol accepts a v1 capabilities projection,
while execution approval remains the domain writer's independent decision.

## Decision

The original domain writer supplies a finite coherent catalog observation for one
exact current registration. The host's generation and canonical registration
fingerprint must match that stored registration. Derive eligible roles using the
existing fleet-scoped qualification logic, including explicit role withdrawal and
cross-family requirements. Never expose preset IDs, account IDs, auth homes,
credentials, owner approval rooms or raw resource configurations.

Project the retained peer's complete capabilities shape: real fleet, server,
representative and approval-bot identities; eligible offers; public resource IDs,
framework/model/reasoning and a derived bounded display label. Actual model and
identity fields remain exact. The label is presentation only and may abbreviate
with an ellipsis. Refuse unsupported field sizes, more than200 resources per role,
or a publication exceeding the existing outbound body limit; never silently
truncate the resource list or claim a partial snapshot is complete. Empty offers
explicitly withdraw the prior catalog.

An opt-in resource publication loop uses the existing adapter's single publication
lane and immutable original update custody. It checks the current registration,
then retries an existing frozen publication unchanged, including its original
sequence and digest. Only after that pending update is settled may a new snapshot
be frozen. Resource edits while an acknowledgment is lost cannot rewrite or
replace the pending message. Registration rotation refuses old publication work;
no tokens, listener or authority are reconstructed from a stale cache. After
all custody waits, a fresh original-domain observation precedes HTTP admission.
Rotation before that observation refuses transmission and retains any old frozen
body as historical custody. Already admitted HTTP requests may finish during a
rotation: their bytes cannot be recalled, and their catalogs grant no execution
authority. This is not an atomic transaction across two stores and a network.

A publication acknowledgment means the peer accepted that exact catalog update.
Heartbeat and catalog data prove neither Matrix connectivity, Agent readiness,
remote allocation availability nor approval to execute. The new library entry
point does not imply that the current executable constructs it; the subsequent
service-owned configuration/lifetime partition must wire that before the console
can claim automatic remote publication.

## Consequences

Resource configuration, role choices and publication remain distinct from native
execution authority. Existing immutable outbound uncertainty and retry behavior
are reused. Actual local HTTPS tests qualify changing catalogs, lost acknowledgments,
registration rotation and bounded refusal. Live Palpo or production state is not
used, and full M5 service integration remains an explicit next step.
