---
kind: requirement
id: REQ-AGENT-OPS-MATRIX-INTAKE
title: "Receive project-side events through authenticated outbound sync"
status: Accepted
tags: [matrix, appservice, intake]
---

This supplies the missing stable requirement definition already referenced by
the accepted `task-appservice-sync-intake` contract, under ADR-014 and ADR-016.
It does not extend that contract's scope.

[REQ-MATRIX-INTAKE-AUTH] Outbound intake MUST authenticate with the configured
side's appservice credential and deliver through the common authenticated router.
The temporary sync token MUST remain process-local.

[REQ-MATRIX-INTAKE-DELIVERY] Invites MUST be delivered on every poll, including
the first. The first join timeline MUST be treated as history. Membership and
invite events MUST NOT be excluded by a timeline type filter.

[REQ-MATRIX-INTAKE-CURSOR] The durable side cursor MUST advance only after a
successful router receipt. A refusal MUST preserve the cursor and retry. Poison
batches MUST stop at the contract's bounded failure threshold, with the held
cursor and failed next-batch separately reported to the operator.

[REQ-MATRIX-INTAKE-EXCLUSIVITY] Normalized side identifiers MUST select exactly
one intake mode per side. Half-configured or conflicting modes MUST be refused.

Executable details and the eight bound acceptance scenarios remain in
`specs/task-appservice-sync-intake.spec.md`; downstream ownership, privacy and
side-provenance checks remain independent gates.
