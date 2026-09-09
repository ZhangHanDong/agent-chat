spec: task
name: "Approval status follows the originating task thread"
inherits: project
satisfies: [REQ-OWNER-UI-APPROVAL]
tags: [matrix, approval, local-e2e]
---

## Intent

Keep repeated native approval status in its originating task thread instead of
filling the project's main timeline. Preserve every private approval request,
non-actionable public notice, and existing authorization checks.

## Decisions

- Resolve the public thread from the persisted approval wait, dispatch and
  session, matching the registered stable agent ID and exact project room.
- The bridge-only Matrix approval endpoint adds this resolved thread ID. Do not
  accept a caller-provided thread or infer it from the newest room message.
- Legacy approvals without a matching router origin retain their room notice.
- Every approval still gets its own notice; no deduplication may hide requests or
  weaken fail-closed private/public delivery semantics.
- Run exact Vitest selectors separately; Node lifecycle skips are not passes.

## Boundaries

### Allowed Changes
- backend-v2.js
- bridge-matrix.js
- router/src/store.ts
- router/dist/store.js
- router/dist/store.d.ts
- tests/approval-thread-notice.test.js
- tests/bridge-matrix-approval.test.js
- specs/task-approval-thread-notice.spec.md
- docs/**

## Acceptance Criteria

Scenario: Notice uses the server-bound task thread
  Test: binds public approval status to the persisted runner thread
  Given a parked runner approval tied to a persisted task thread
  When the bridge reads its Matrix approval record
  Then the record contains the original thread ID regardless of caller input

Scenario: Scope mismatch cannot misroute a notice
  Test: does not infer a thread from another agent room or legacy request
  Test: legacy deployments publish approval notices without a router
  Given a different agent, room, or non-router upstream request
  When the bridge resolves the public notice destination
  Then no unrelated task thread is returned
  And the Matrix record still requires bridge authentication

Scenario: Thread relation contains only public coordination state
  Test: thread approval notices remain in the originating task thread
  Test: public_approval_notice_is_redacted_and_non_actionable
  Given a bridge approval record with an authenticated thread origin
  When the public status notice is built
  Then it has a Matrix thread relation to that origin
  And it contains no private input or actionable approval fields

## Out of Scope

- Suppressing approval requests, changing approval policy, or rewriting old events.
- Modifying task completion or starting another lower implementation job.
