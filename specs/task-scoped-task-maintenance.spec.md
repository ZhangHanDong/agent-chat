spec: task
name: "Report current-task lifecycle without shell network approval"
inherits: project
satisfies: [REQ-OWNER-UI-APPROVAL, REQ-THREAD-SCOPED-SESSIONS, ADR-011, ADR-019, ADR-021]
tags: [active, runtime, tasks, approvals]
---

## Intent

Let the managed agent report heartbeat, waiting and explicit completion through
its scoped MCP channel without asking its owner to approve routine HTTP commands.

## Constraints

### Must
- Authenticate every task update against the current agent, dispatch, runner and fence, permitting writes only to that dispatch's own task.
- Support heartbeat and waiting metadata through the actual MCP server and scoped backend route.
- Tell sandboxed runners to use the managed task tools in place of shell task-writer calls and report transport errors without fabricated completion.
- Require explicit done after the task's checks pass; a successful model turn alone must leave unfinished tasks open.
- Retain native sandbox policies and owner approval for every actual runtime approval request.

### Must Not
- Do not allow network access globally or auto-approve a shell command by matching its text or path.
- Do not let maintenance updates change status, identity or another task, or fall back to legacy authority.

## Boundaries

### Allowed Changes
- backend-v2.js
- lib/mcp-server-core.js
- remote/lib/mcp-server-core.js
- router/src/runner.ts
- router/dist/runner.js
- router/dist/runner.d.ts
- tests/ephemeral-session-tools.test.js
- tests/router-runner.test.js
- tests/fixtures/fake-codex-app-server.mjs
- scripts/probe-task-maintenance.mjs
- knowledge/decisions/adr-021-scoped-task-maintenance.md
- specs/task-scoped-task-maintenance.spec.md
- specs/project.spec.md
- docs/**

### Forbidden
- Root workspace entry files, live credentials or task-state edits, and weaker sandbox or owner verdict checks.

## Acceptance Criteria

Scenario: Routine lifecycle succeeds through actual scoped MCP
  Test: MCP lifecycle maintenance needs no owner approval and confirms explicit completion
  Given an active authenticated dispatch with an unfinished task
  When its MCP tools report heartbeat, waiting, resume and done
  Then canonical task state reflects each operation with no approval record

Scenario: Execution updates cannot widen authority
  Test: scoped execution maintenance rejects foreign stale and forged authority
  Given an active dispatch and tasks outside its write scope
  When execution updates select a foreign task or use invalid authority
  Then they fail without changing task state

Scenario: Maintenance fields cannot complete or reassign a task
  Test: scoped execution maintenance accepts only heartbeat and waiting metadata
  Given an unfinished task
  When an execution update includes forged identity and status fields
  Then only permitted execution metadata changes

Scenario: Dispatch instructions select the scoped tools without bypassing approval
  Test: sandboxed lifecycle guidance uses MCP while shell task writer still requires owner approval
  Given a managed Codex runner with its MCP server
  When it starts and a native task-writer command approval is requested
  Then runtime instructions select MCP lifecycle tools and the actual command still waits for its owner

Scenario: Model completion alone does not complete task work
  Test: runner asks for explicit task completion and a successful turn keeps the task open
  Given unfinished canonical work
  When its model turn returns successfully without an explicit done transition
  Then the task remains open

## Out of Scope

- Per-engagement network and filesystem grant UI, automatic permission verdicts, and changing the standalone CLI wrapper.
