spec: task
name: "Clean up MCP PID files when termination follows publication"
inherits: project
satisfies: [ADR-001]
tags: [mcp, lifecycle, regression]
---

## Intent

A newly visible MCP PID file can be followed immediately by a termination
signal. Ensure cleanup is already installed when the file becomes visible,
so an orderly termination cannot leave that process's PID file behind.

## Constraints

### Must
- Install exit and signal cleanup before publishing the PID file.
- Preserve the guard that only removes a PID file owned by the exiting process.
- Preserve local and remote MCP behavior parity.

### Must Not
- Do not increase test timeouts or add termination retries to hide failures.
- Do not alter MCP tool routing, authentication, or active E2E processes.

## Decisions

- [JS-only] Exercise the real Node subprocesses with a preload that sends a real signal immediately after writing the PID file.
- Keep existing derived and explicit state directory placement.
- Include child exit code and terminating signal in PID cleanup failure diagnostics.

## Boundaries

### Allowed Changes
- lib/mcp-server-core.js
- remote/lib/mcp-server-core.js
- tests/mcp-heartbeat.test.js
- specs/task-mcp-pid-cleanup.spec.md
- .agent-spec/runs/**

### Forbidden
- Do not edit MCP code outside the PID lifecycle block.
- Do not edit real runtime state.

## Acceptance Criteria

Scenario: SIGTERM at publication removes the process PID file
  Test: cleans up its pid file when SIGTERM arrives during publication
  Given isolated lib/mcp-server-core.js and remote/lib/mcp-server-core.js subprocesses
  When a real SIGTERM arrives immediately after the PID file is written
  Then each subprocess exits with code zero and removes its own PID file
  And the assertion retains exit code and signal diagnostics without extending timeouts

Scenario: SIGINT at publication removes the process PID file
  Test: cleans up its pid file when SIGINT arrives during publication
  Given isolated local and remote MCP subprocesses
  When a real SIGINT arrives immediately after the PID file is written
  Then each subprocess exits with code zero and removes its own PID file

Scenario: Explicit state directory placement remains supported
  Test: writes pid file under explicit agent state dir when provided
  Given an isolated explicit agent state directory
  When the MCP subprocess starts and receives SIGTERM
  Then its PID file appears in that directory and is removed after exit

Scenario: Derived state directory placement remains supported
  Test: writes pid file under derived agent state dir when explicit state dir is missing
  Given no explicit agent state directory
  When the isolated MCP subprocess starts and receives SIGTERM
  Then its PID file appears in the derived directory and is removed after exit

## Out of Scope

- Attributing the original CI failure to a specific exit signal without evidence.
- Broad heartbeat, test harness, or shutdown policy changes.
