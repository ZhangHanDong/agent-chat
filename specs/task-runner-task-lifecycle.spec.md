spec: task
name: "Capability-scoped runner task lifecycle"
inherits: project
satisfies:
  - REQ-THREE-LAYER-COMPLETION
tags: [tasks, runner, mcp, regression]
---

## Intent

Allow a Hagency-managed agent to record verified inner work and complete its
bound task through structured MCP operations. Preserve session isolation and
keep final response text separate from durable task and dispatch state.

## Constraints

### Must
- Authenticate the complete runner capability and agent identity on every operation.
- Preserve the existing task state machine and local/remote MCP mirror equality.
- Run deterministic Vitest tests without contacting live services.

### Must Not
- Expose another session's tasks or use a model-authored final response to change state.
- Weaken coding-agent sandbox defaults or modify global mempal settings.

## Decisions

- Add one capability-scoped task operation endpoint and reuse the durable task repository.
- Persist mutation receipts transactionally with their effects, keyed by dispatch and tool call.
- Derive comment author and task scope from backend state.
- Convert Matrix mention links before extracting the promoted task title.
- [JS-only] Execute exact Vitest selectors separately from agent-spec lifecycle.

## Boundaries

### Allowed Changes
- backend-v2.js
- scripts/architecture-boundaries.json
- router/src/**
- router/dist/**
- lib/mcp-server-core.js
- remote/lib/mcp-server-core.js
- tests/router-task-lifecycle.test.js
- tests/router-task-lifecycle-backend.test.js
- tests/router-task-resume-backend.test.js
- tests/mcp-task-lifecycle.test.js
- tests/router-backend.test.js
- knowledge/requirements/req-three-layer-task-completion.md
- specs/task-runner-task-lifecycle.spec.md
- docs/THREAD-SESSIONS.md
- docs/E2E-RUNBOOK-macos.md
- docs/superpowers/plans/2026-09-06-three-layer-e2e-repair.md
- docs/agent-knowledge.md
- docs/progress.md

## Acceptance Criteria

Scenario: A started runner completes its own verified task
  Test: completes the bound task through structured operations
  Given a started runner with an active task binding
  When it records verification and transitions its task to done
  Then the existing task is done with its comment and completed timestamp

Scenario: Other task scope is denied
  Test: rejects other tasks and revoked or unstarted capabilities
  Given a runner bound to one task
  When it requests another task or uses an invalid capability
  Then no task content or mutation is returned

Scenario: Mutation retry does not duplicate effects
  Test: replays identical calls and refuses changed payloads
  Given a successful comment operation
  When its call id is reused with identical or changed content
  Then identical content replays once and changed content is refused

Scenario: Invalid transition remains visible
  Test: keeps invalid transitions and plain completion from marking tasks done
  Given a started task dispatch
  When it requests an invalid transition or settles with completion text only
  Then the task state machine rejects the transition and text does not complete the task

Scenario: MCP reaches the scoped endpoint
  Test: routes runner task tools through capability-scoped operations
  Given an ephemeral MCP server
  When task tools are invoked over stdio
  Then they use the scoped endpoint with current capability headers

Scenario: Promoted title preserves the human request
  Test: promoted task title removes complete Matrix mentions without corrupting text
  Given a human message beginning with a Matrix Markdown mention
  When the backend promotes the message to a task
  Then the task title contains the request without a broken mention URL

Scenario: Coordinator reads remain within its session
  Test: coordinator reads prior creations only in its own session and cannot mutate them
  Given tasks created by earlier coordinator dispatches
  When the coordinator reads or mutates a child task
  Then its own session may read the child but cannot mutate it
  And another session cannot read it

Scenario: Receipt and task effects commit together
  Test: receipt storage failure rolls back task changes and restart preserves retry receipts
  Given a task operation whose receipt insert fails
  When the operation runs or the database is reopened
  Then failed effects roll back and successful receipts still replay once

Scenario: Loopback and agent credentials cannot bypass capability scope
  Test: requires capability even on loopback and with the agent token
  Test: rejects legacy mutations without a capability but preserves operator access
  Test: global task reads require operator authority in thread-session mode
  Test: global task mutations fail closed when operator credentials are absent
  Given thread sessions are enabled
  When a caller omits capability or tries a global task route without operator authority
  Then the request is refused even on loopback and when no operator token is configured

Scenario: Operator resume wakes the existing blocked dispatch
  Test: operator resume starts queued work without another message
  Given a blocked task with a queued follow-up and no active runner
  When an authenticated operator resumes the existing task
  Then the queued dispatch is scheduled without a new message or restart
  And unauthorized or invalid transitions neither resume nor launch it
  And launch failure remains a failed launch instead of task completion

## Out of Scope

- Remote service deployment, global configuration changes, or automatic task completion from terminal text.
- Making Octos a disposable Hagency runner; it remains a lower-level execution choice.
