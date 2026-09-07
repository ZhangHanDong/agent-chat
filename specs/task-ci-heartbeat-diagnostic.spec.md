spec: task
name: "Preserve the response evidence for intermittent server-list failures"
inherits: project
satisfies: [ADR-001]
tags: [tests, diagnostics]
---

## Intent

The CI local-server inventory test returned HTTP 401 once, but its assertion
discarded the response body. Preserve that evidence without changing the
expected result or claiming an unproven root cause.

## Constraints

### Must
- Keep the existing HTTP 200 and local-server inventory assertions.
- Include response content, content type, and request URL in a failed status assertion.

### Must Not
- Do not add authorization headers, retries, or production authentication changes.
- Do not restart E2E services or alter active agents.

## Decisions

- [JS-only] Add diagnostic context to the existing Vitest assertion only.
- Keep the original failed CI log; 12 isolated file reruns and the exact backend API shard passed without reproducing it.

## Boundaries

### Allowed Changes
- tests/api-server-heartbeat-sweep.test.js
- specs/task-ci-heartbeat-diagnostic.spec.md
- .agent-spec/runs/**

## Acceptance Criteria

Scenario: Local server inventory retains its existing assertions
  Test: records the local runtime host only when the local server record flag is enabled
  Given the local server record flag is enabled in an isolated test runtime
  When the existing unauthenticated local request reads the server list
  Then HTTP 200 and the existing local-only inventory assertions remain enforced
  And a failed status assertion includes the response content, content type, and request URL

## Out of Scope

- Claiming that a clean rerun fixes the original intermittent failure.
- Broad test harness changes or production authentication changes.
