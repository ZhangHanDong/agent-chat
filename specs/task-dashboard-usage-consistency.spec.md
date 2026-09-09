spec: task
name: "Dashboard usage charts share live totals"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE-BLANK, REQ-CONTRIBUTION-CONSOLE-METERING-SCOPE, REQ-CONTRIBUTION-CONSOLE-PROVENANCE, REQ-PROJECT-BOARD-BOUNDARY, ADR-013]
tags: [dashboard, usage, regression]
---

## Intent

Repair the local E2E discrepancy where the usage table reports three tasks and
two completions while the chart reports no activity. Keep current allocation
charts consistent with the active engagement total and state missing project
attribution explicitly.

## Constraints

### Must
- Count live tasks once per agent from the same data as the usage table and done total.
- Exclude pending and ended engagements from current allocation.
- State absent project attribution without inventing project task or token totals.
- Use deterministic local Vitest rendering tests with no external requests.

### Must Not
- Do not infer task project ownership from engagements or memberships.
- Do not add dependencies or mutate backend task or engagement state.

## Decisions

- Live task bars use per-agent counts from the usage endpoint.
- The current allocation card and donut use one active engagement selection.
- Existing project fixture rows remain separate from live task aggregation.
- [JS-only] Render the synchronous Next.js client page and real chart components
  with React server rendering; inject the data and locale contexts for Vitest.

## Boundaries

### Allowed Changes
- mockup/app/usage/page.jsx
- mockup/components/Charts.jsx
- tests/dashboard-usage*.test.js
- specs/task-dashboard-usage-consistency.spec.md
- knowledge/observations/dashboard-usage-consistency.md

### Forbidden
- mockup/lib/api.js
- mockup/components/Data.jsx
- mockup/lib/i18n.js
- backend-v2.js

## Completion Criteria

Scenario: Live tasks agree across table chart and done total
  Test: renders live agent task counts in the chart and summary
  Given two live agent rows report one done and one open task and one done task
  And the legacy project usage array is empty
  When the usage page renders
  Then task bars show the two agents with counts 1/1 and 1/0
  And the done card reports 2

Scenario: Engagements do not multiply agent task counts
  Test: does not duplicate live tasks across projects or legacy usage rows
  Given an agent serves two projects and legacy rows also contain task counts
  When the usage page renders
  Then its task chart contains one row for that agent
  And the done card remains the live total

Scenario: Missing project attribution is explained
  Test: explains missing project attribution without inventing rows
  Given live per-agent usage contains tasks without project attribution
  When the project usage section renders
  Then it states that project task and token totals are unknown
  And it creates no project task rows from engagements

Scenario: Ended allocations are excluded
  Test: excludes ended and pending engagements from the allocation donut
  Given active allocation is 1000 and ended allocation is 50000
  And one pending engagement has a requested allocation
  When the usage page renders
  Then the current allocation card and donut each report 1000

Scenario: No active allocation stays empty
  Test: renders no allocation when only ended engagements remain
  Given the only engagement is ended with 50000 allocated tokens
  When the usage page renders
  Then the allocation card reports 0
  And the donut states no allocation

Scenario: A measured zero remains zero
  Test: renders zero task counts for an observed agent without activity
  Given a live agent row reports zero tasks
  When the usage page renders
  Then its chart row reports done 0 and open 0
  And the done card reports 0

## Out of Scope

- Backend usage collection, task lifecycle, metering series and project attribution.
- Browser operation, service restarts, production builds and commits.
- Translation storage, coordinated separately by the parent task.
