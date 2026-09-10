spec: task
name: "Deliver approved engagement results to the requesting Matrix room"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE, ADR-016, ADR-019]
tags: [active, matrix, engagement]
---

## Intent

Close the borrower-visible gap where a manual approval succeeds but the project
room still contains only its earlier pending acknowledgement.

## Constraints

### Must
- Persist notification intent with the approval and retry delivery after interruption.
- Send from the configured project representative to the authoritative request room.
- Disclose the approved allocation and serving agent without private owner or deployment data.
- Reuse the same Matrix transaction identity when acknowledgement or delivery is retried.
- Keep delivery failure separate from the already committed approval.

### Must Not
- Do not change the room whitelist, repeat allocation, or submit another engagement.
- Do not backfill unrelated historical decisions or send for a revoked engagement.
- Do not contact live services from deterministic tests.
- Do not route the representative's result notices or echoed commands into agent work.

## Boundaries

### Allowed Changes
- backend-v2.js
- bridge-matrix.js
- lib/engagement-store.js
- lib/engagement-notice.js
- lib/matrix-work-store.js
- lib/matrix-work-executor.js
- tests/matrix-work.test.js
- tests/api-engagement-room-admission.test.js
- tests/bridge-representative-intake.test.js
- specs/task-engagement-approval-notice.spec.md
- docs/**

### Forbidden
- Credentials, runtime-state files, approval authorization and unrelated deployments.

## Acceptance Criteria

Scenario: Approved requests receive a private-data-free result
  Test: manual approval durably queues a public result and verdict replay does not allocate twice
  Given a configured project representative and an approved bound request
  When the bridge claims and acknowledges its result notification
  Then only the requested room and public serving details are sent
  And replaying the verdict neither reallocates nor sends a second notice

Scenario: Withdrawal fences unsent approval notices
  Test: a revoked engagement cannot claim its old approval notice
  Given a request is approved and then revoked before delivery
  When the bridge claims work
  Then no approval notice is delivered for that request

Scenario: Interrupted notification delivery is retryable
  Test: approval notices retain one transaction through failed delivery and lost acknowledgement
  Given a persisted approval notice and an intermittent homeserver
  When delivery fails or the bridge restarts before acknowledgement
  Then the work remains retryable with the same transaction and no secret persistence

Scenario: Notification intent cannot escape a failed approval write
  Test: approval notification intent commits atomically with allocation
  Given engagement persistence fails during approval
  When the approval is retried after storage recovers
  Then the failed write retains neither allocation nor notification intent
  And the successful retry retains both

Scenario: Representative receipts never become agent instructions
  Test: representative output is ignored before command parsing and agent dispatch
  Given the fleet representative emits a result containing agent addresses or command text
  When that event returns through Matrix sync
  Then no command or agent dispatch is created
