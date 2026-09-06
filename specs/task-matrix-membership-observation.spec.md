spec: task
name: "Prevent Matrix membership observations from becoming commands"
inherits: project
satisfies: [REQ-MMO-ORIGIN, REQ-MMO-CURRENT, REQ-MMO-UNKNOWN, ADR-016]
tags: [matrix, membership, regression]
---

## Intent

Break the Matrix-to-roster-to-Matrix reflection that kicked a restored member
after a delayed leave event. Reconcile observed events against current Matrix
membership and retain observation provenance through backend SSE notifications.

## Constraints

### Must
- Keep ordinary API add and remove commands functional.
- Preserve authenticated Matrix observation provenance in SSE while suppressing reflected Matrix operations.
- Read current membership through the room's authorized credential before updating the roster.
- Reject unreadable membership with a retryable error and zero roster or Matrix mutations.

### Must Not
- Do not trust unauthenticated Matrix-origin claims.
- Do not use sleeps, increased timeouts, or local success placeholders to resolve stale events.
- Do not restart services or alter live E2E membership.

## Decisions

- The membership API carries source matrix only for authenticated bridge observations; ordinary commands retain their existing event shape.
- Current joined membership determines the roster result of a join, leave, or ban observation.
- [JS-only] Tests use the real backend, SSE frames, bridge handlers, and isolated HTTP Matrix fixtures, including delayed event delivery after remove and restore.

## Boundaries

### Allowed Changes
- backend-v2.js
- bridge-matrix.js
- tests/bridge-membership-observation.test.js
- knowledge/requirements/req-matrix-membership-observation.md
- specs/task-matrix-membership-observation.spec.md
- .agent-spec/runs/**

### Forbidden
- Do not edit backend code outside the group membership endpoint.
- Do not edit runtime files or unrelated task routing code.

## Acceptance Criteria

Scenario: Delayed leave and join observations do not undo a restored member
  Test: delayed leave and join observations preserve a restored member without reflected Matrix writes
  Given an API command removes and then restores a joined agent
  When the original Matrix leave and join events arrive after the restored join
  Then the real backend roster and Matrix fixture both retain the agent
  And Matrix-origin SSE notifications cause zero additional Matrix writes

Scenario: External leave observations update the roster without another kick
  Test: a current leave observation updates the roster without another Matrix operation
  Given the homeserver reports that the agent has left
  When the bridge consumes its leave event
  Then the backend removes the agent and emits a Matrix-origin notification
  And the bridge sends zero Matrix membership writes

Scenario: External join observations update the roster without another invitation
  Test: a current join observation updates the roster without another Matrix operation
  Given the homeserver reports that the agent has joined
  When the bridge consumes its join event
  Then the backend adds the agent and emits a Matrix-origin notification
  And the bridge sends zero Matrix membership writes

Scenario: A delayed join cannot restore an absent member
  Test: a delayed join reconciles current absence without restoring the member
  Given the homeserver currently reports that the agent has left
  When an older join event arrives
  Then the backend roster keeps the agent absent and the bridge sends zero Matrix writes

Scenario: Room scans preserve observation provenance
  Test: room reconciliation preserves Matrix observation provenance
  Given a currently joined Matrix member is missing from the backend roster
  When the bridge reconciles room membership
  Then it adds the member with Matrix-origin SSE provenance and sends zero Matrix membership writes

Scenario: Unreadable membership cannot change the roster
  Test: unreadable current membership rejects the observation without mutations
  Given the current membership endpoint answers HTTP 403
  When a leave observation arrives
  Then the handler raises a retryable membership_unknown error
  And the backend roster remains unchanged and no SSE notification or Matrix write is emitted

Scenario: Matrix origin requires bridge authentication
  Test: Matrix membership observations require configured bridge authentication
  Given missing or invalid bridge credentials
  When a caller claims source matrix on a membership update
  Then the API refuses the observation without changing the roster

## Out of Scope

- Live E2E revalidation, which the coordinating agent performs after the fix.
- Replacing the group model or introducing a durable membership command queue.
