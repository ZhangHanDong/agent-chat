spec: task
name: "Recover incremental sync gaps within durable cursor bounds"
inherits: project
satisfies: [REQ-AGENT-OPS-MATRIX-INTAKE, ADR-016]
tags: [matrix, appservice, regression]
---

## Intent

Recover messages omitted by a limited incremental sync timeline. The macOS
Docker Palpo E2E lost 23 of 45 messages because reconciliation called the
invite-to-join selector, which excludes messages sent after joining.

## Constraints

### Must
- Persist both the pre-batch and next-batch cursor before advancing sync.
- Read only the missing sync interval on the same project side, in forward order.
- Deliver recovered events through the existing authenticated appservice router.
- Preserve pending recovery when reads, pagination or router delivery fail.

### Must Not
- Do not replay room history without a proven lower cursor boundary.
- Do not turn initial sync into replay of the room's historical commands.
- Do not clear a gap after a malformed page or exhausted pagination budget.

## Decisions

- Keep the existing durable reconciliation queue and its retry behavior.
  Extend its records with kind, from and to; merging gaps preserves the oldest
  lower bound and latest upper bound. Legacy records without bounds fail visibly.
- Initial sync keeps the existing invite-to-join reconciliation policy.
- Recover only m.room.message after validating the complete interval; normal
  sync state owns membership reconciliation so an older leave cannot undo a newer join.
- Use Matrix /messages from/to sync tokens, a finite page/event budget, and
  stable transaction ids. No timestamp ordering or guessed history window.
- [JS-only] Run deterministic Vitest tests separately from live Palpo evidence.

## Boundaries

### Allowed Changes
- bridge-matrix.js
- lib/appservice-sync.js
- lib/matrix-representative.js
- tests/bridge-appservice-gap.test.js
- tests/appservice-sync-gap.test.js
- specs/task-sync-gap-window.spec.md
- docs/E2E-RUNBOOK-macos.md
- docs/progress.md
- docs/agent-knowledge.md

### Forbidden
- remote/**
- Runtime credentials
- Matrix authorization policy or task lifecycle changes

## Acceptance Criteria

Scenario: Incremental reconciliation persists cursor bounds before advancing
  Test: sync gap bounds are recorded before cursor advancement
  Given a limited incremental sync between two cursor tokens
  When its event batch is accepted
  Then the recovery record contains both tokens before the sync cursor advances

Scenario: The bridge recovers post-join messages through the side router
  Test: persisted sync gaps route forward history through the authenticated router
  Given a pending gap bounded by two sync tokens
  When the bridge reads all pages on that project side
  Then post-join events reach the appservice router in order with a stable transaction id

Scenario: Invalid history preserves pending recovery
  Test: failed or malformed gap reads do not deliver or clear the pending record
  Given a pending gap whose history read fails or contains a malformed page or event
  When reconciliation runs
  Then it rejects without delivery and the durable record remains

Scenario: Missing bounds and stalled pagination are refused
  Test: missing bounds and stalled gap pages refuse without replaying history
  Given a legacy record without cursor bounds or a page that repeats its token
  When reconciliation runs
  Then it rejects without routing events

Scenario: A rejected router receipt keeps the original gap retryable
  Test: rejected gap delivery retries with the same transaction identity
  Given a complete gap whose router delivery is refused
  When reconciliation is retried
  Then both attempts use the same transaction identity and pending bounds remain

Scenario: Initial sync keeps historical messages outside incremental recovery
  Test: initial history still uses only the invite-to-join policy
  Given an initial sync without a lower cursor
  When reconciliation runs
  Then it uses the existing invite-to-join policy without incremental history replay

Scenario: Pagination budgets prevent partial recovery claims
  Test: exhausted or oversized gap pages retain pending recovery without partial delivery
  Given history exceeds the finite page or event budget
  When reconciliation runs
  Then it rejects without partial delivery and preserves the pending record

Scenario: Legacy recovery cannot be replaced by a newer incomplete interval
  Test: later gaps do not overwrite legacy pending recovery with unknown bounds
  Given a legacy pending record without cursor bounds
  When a later limited sync records new bounds
  Then the earlier unproven recovery remains pending and no history is replayed

Scenario: Gap recovery cannot roll membership back behind current sync state
  Test: gap messages recover without replaying stale membership over current sync state
  Given normal sync has applied a newer join and a gap contains an older leave
  When recovery routes the missed messages
  Then the newer joined membership remains unchanged

## Out of Scope

- Automatically reconstructing cursor bounds missing from legacy records.
- Claiming ordering across already-delivered limited timeline events and late recovery.
