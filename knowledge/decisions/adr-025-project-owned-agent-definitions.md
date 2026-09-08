---
kind: decision
id: ADR-025
title: "Palpo projects define Agents and request published HAFleet resources"
status: Accepted
tags: [resources, agents, palpo, engagement]
---

The operator clarified that Agent definitions belong to project users on Palpo.
This supersedes ADR-024's provider-owned web definition workflow. HAFleet configures
and publishes resources; Palpo defines each Agent by name, role and selected
resource and submits it for provider approval. Multiple project Agents may request
the same resource. Defining or submitting does not provision or approve capacity.

The authenticated Matrix request and its durable request context carry the same
bounded Agent definition. A published resource has a stable opaque catalog ID;
internal preset IDs and other projects' Agent names are not catalog metadata.
Validate publication and qualification at submission and again before initial
approval. Exact request replays remain readable after publication is withdrawn;
an already reserved fulfillment keeps its resource and identity for recovery.

Each new definition provisions a distinct project-scoped runtime identity upon
approval. It cannot silently reuse an existing Agent or switch resources. The
provider can approve or reject; a changed definition requires a new request.
Name collisions within the project's pending/active definitions are refused,
while different projects can independently use the same name. Preserve request
idempotency, Matrix sender and owner verification, project-side/seat budgets and
existing operation permissions. A definition never grants network or sandbox rights.

Keep existing allocations and legacy role-only requests working. Existing local
definition records remain readable for compatibility, but the HAFleet web no
longer creates them. Palpo displays each definition with its own request status;
HAFleet displays the requested definition and resource during approval.

The operator's September 8 follow-up requires automatic resource publication.
New resources default to catalog publication in the same persistence transaction
as creation. Explicit withdrawal remains durable; older records without a
publication choice keep their previous visibility. The existing three live
resources have been explicitly published at the operator's request.

Palpo derives its role catalog from published, qualifying resources. An absent
manual role offer does not block publication; an explicitly withdrawn role does.
Qualification and cross-family requirements still apply. This derived catalog
does not alter legacy automatic-acceptance policy, capacity, or owner approval.
Resource edits and deletion are reflected by the existing authenticated callback.
The visible Palpo page refreshes this catalog every ten seconds and on return,
preserves draft inputs, and disables requests when catalog refresh fails.

Defining/requesting an Agent on a new Resource must remain possible when the
project side's allocation is exhausted or not yet assigned. Verified Palpo
requests always enter manual review, with no allocated tokens or runtime creation.
Initially the project-side budget gate applied at approval/reservation, not when
recording this pending request. This narrows the older intake gate for the
authenticated fleet protocol only; legacy automatic admission remains gated.
Resource/seat limits, owner authority and project-side budgets still apply before
any approval can reserve capacity. Increasing a Resource ceiling never increases
the project side's budget.

The operator's subsequent Edison correction supersedes that approval gate for
project-defined Agents: selecting a published pool selects the funding source.
These manually approved definitions draw from that Resource's ceiling, shared
across all its Agents and projects, and any declared quota on their shared model
account. They do not draw from the older project-side allocation. Legacy requests
without a project Agent definition retain ADR-016's project-side admission limits,
including unset and zero allocations. Keep both sets of commitments visible and
separate; do not raise, erase or relabel the operator's saved allocations.

Pool commitments follow the actual preset ID, not model/account identity. A
different pool's commitments affect the chosen pool only through a real declared
shared-account quota. Pending definitions reserve nothing; active engagements and
in-progress fulfillment reservations count once. Retry excludes its own existing
reservation and cannot switch identity, resource or amount. Capacity is rechecked
after asynchronous owner verification, before reservation. Approval shows the
chosen pool's ceiling, commitments and available allocation, separately from the
shared-account limit. An undeclared account quota stays unknown; a pool ceiling
does not claim that the provider guarantees that many tokens.
