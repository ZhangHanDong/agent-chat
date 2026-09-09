spec: task
name: "Admit an explicitly mentioned worker into an existing Matrix thread"
inherits: project
satisfies: [REQ-THREAD-SCOPED-SESSIONS, REQ-MATRIX-THREAD-CONTINUITY, ADR-023]
tags: [active, matrix, sessions, recovery]
---

## Intent

Recover authenticated user input that explicitly addresses a second worker in
an existing thread without a task binding for that worker. Preserve the original
source event and thread while creating the target's own canonical task.

## Constraints

### Must
- Create a new binding only for authenticated human input explicitly mentioning that worker.
- Keep one task per agent, room and thread, with a separate session for each agent.
- Use the existing durable Matrix acknowledgement before activating task inputs or dispatching work.
- Attach follow-ups arriving before acknowledgement to the pending task, and preserve source idempotency across replay and restart.
- Preserve existing room admission, private-to-group promotion, sandbox and approval gates.

### Must Not
- Do not skip failed input, advance a sync cursor past an uncommitted event, or weaken task activation.
- Do not turn agent output or unmentioned group discussion into worker tasks.

## Boundaries

### Allowed Changes
- backend-v2.js
- router/src/store.ts
- router/dist/store.js
- router/dist/store.d.ts
- tests/router-backend.test.js
- tests/matrix-direct-backend.test.js
- knowledge/decisions/adr-023-room-conversation-context-and-direct-chat.md
- specs/task-cross-agent-thread.spec.md

### Forbidden
- Live runtime data, Matrix messages and credentials, and unrelated transport changes.

## Acceptance Criteria

Scenario: A second worker joins an existing thread through a confirmed task
  Test: explicit cross-agent thread mention creates an independent acknowledged task
  Given a task for one worker and a human mentioning another worker in its thread
  When the backend receives that authenticated event and later receives its Matrix acknowledgement
  Then the second worker runs only in its own task session with the original thread root
  And event replay and pending follow-ups do not create another task or dispatch

Scenario: A previously accepted input recovers after restart
  Test: accepted cross-agent thread input recovers without replacing its source event
  Given an accepted but uncommitted source message and no target task binding
  When startup reconciliation and normal source retry resume delivery
  Then the original message becomes committed and later inputs can be delivered

Scenario: Admission and private context remain protected
  Test: cross-agent thread creation preserves human mentions and private promotion gates
  Given admitted invited agents and a formerly private conversation
  When an unmentioned or unauthorized sender attempts new thread admission
  Then no new worker task is created
  And a promoted private thread starts fresh without importing private task input

## Out of Scope

- General poison-message handling, automatic approval, allocation changes, and outbound transport design.
