spec: task
name: "Continue completed Matrix tasks on fresh requester follow-ups"
inherits: project
satisfies: [REQ-THREAD-SCOPED-SESSIONS, ADR-011, ADR-020]
tags: [active, matrix, sessions, tasks]
---

## Intent

Run the original requester's fresh same-thread follow-up after prior work is
complete, preserving the unique task binding and all prior execution evidence.

## Constraints

### Must
- Reopen only for a never-started queued batch with unprocessed supplementary Matrix input from the original human requester in the exact task/session/room/thread.
- Commit reopening and the new dispatch lease together after all existing runner and workspace gates pass.
- Keep task, session and thread identities stable; record the prior completion and triggering input in the audit event.
- Recover an already queued follow-up through normal startup scheduling without rewriting its input or dispatch identity.
- Preserve blocked, uncertain and quarantined states and require their existing recovery procedures.
- Keep consumed input inert on replay and deliver a visible notice for ineligible pending work on a completed task.

### Must Not
- Do not replay a started dispatch, widen generic task transitions, or approve runtime operations.
- Do not infer authority from message text or accept a foreign sender, peer message, processed input or mismatched scope as a reopening request.

## Boundaries

### Allowed Changes
- router/src/store.ts
- router/dist/store.js
- router/dist/store.d.ts
- tests/router-core.test.js
- tests/router-backend.test.js
- knowledge/decisions/adr-020-completed-thread-followups.md
- specs/task-completed-thread-followup.spec.md
- docs/**

### Forbidden
- Direct writes to live runtime state, changed Matrix membership or credentials, and weakened sandbox or owner approval enforcement.

## Acceptance Criteria

Scenario: A fresh follow-up continues the completed thread exactly once
  Test: completed thread follow-up reopens the same task and never replays consumed work
  Given completed work with an active task binding
  When the original requester sends a fresh authenticated supplementary thread message
  Then a new dispatch reopens that same task with its prior context
  And old outputs and processed inputs remain intact on later replay

Scenario: Restart resumes the already queued unanswered message
  Test: completed thread follow-up survives restart with the original queued dispatch
  Given a never-started queued follow-up blocked solely by completed task status
  When the router reopens its durable store and schedules work
  Then it claims the original queued dispatch without fabricating another message

Scenario: Authenticated backend intake preserves context across completion
  Test: authenticated Matrix follow-up executes after its prior task completes
  Given a completed task created through the Matrix bridge API
  When the original requester mentions the agent in that same thread
  Then the next runner receives the new input and previous result in that same task session
  And replaying the Matrix event cannot create another dispatch

Scenario: Continuation respects live and unsafe work boundaries
  Test: completed thread follow-up waits for the previous runner and workspace gates
  Given fresh follow-up input and an active runner or restricted workspace
  When scheduling is attempted before the existing gate is cleared
  Then neither task reopening nor another runner starts

Scenario: Untrusted or stale input cannot reopen completed work
  Test: completed thread follow-up rejects foreign peer processed and mismatched inputs
  Given a completed task with ineligible pending input
  When the router considers that queued dispatch
  Then task completion remains unchanged and a deduplicated notice explains the refusal

## Out of Scope

- Automatic runtime permission approval, generic task reopening endpoints, and extending mentionless addressing to completed tasks.
