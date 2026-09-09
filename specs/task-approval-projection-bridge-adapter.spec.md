spec: task
name: "Approval projection production request adapter"
status: accepted
inherits: project
---

## Intent

Connect canonical approval projection rows to the existing bridge actor, security, encryption, and exact Matrix transport seams without starting a worker.

## Decisions

- The adapter reads and mutates projection state only through bridge-secret backend routes.
- Private local content passes the established approval-room security policy and is encrypted once before durable prepare.
- Matrix receives only the durable winning event type, payload, transaction identity, and pinned current actor.
- Scheduling, shared-room markers, and legacy publication remain later checkpoints.

## Boundaries

### Allowed Changes
- bridge-matrix.js
- tests/bridge-approval-projection-adapter.test.js
- tests/bridge-approval-projection.test.js
- tests/bridge-appservice-send.test.js
- specs/task-approval-projection-bridge-adapter.spec.md

### Forbidden
- Backend or approval-store changes, startup timers, SSE listeners, marker publication, GUI, Cargo, live Matrix/provider calls, native verdict authorization, and plaintext downgrade.

## Acceptance Criteria

Scenario: Local encrypted projection follows the durable protocol
  Test: real Express and approval store with a captured Matrix boundary
  Given a canonical due private request and verified local bot context
  When the adapter prepares and publishes it
  Then security and encryption run before durable prepare
  And durable begin precedes the exact raw Matrix PUT
  And receipt records the returned event without re-encrypting.

Scenario: Existing prepared work reuses winning bytes
  Test: immutable retry regression
  Given an uncertain projection with stored encrypted content
  When the adapter retries it
  Then it skips fresh encryption and sends the exact stored payload and transaction identity.

Scenario: Current identity gates transport
  Test: captured and authoritative credential rotation regressions
  Given a pinned projection actor
  When the captured or current credential generation differs
  Then no later Matrix request uses that context.

## Out of Scope

Automatic startup, SSE or timer drain; marker state events; GUI integration; and live deployment.
