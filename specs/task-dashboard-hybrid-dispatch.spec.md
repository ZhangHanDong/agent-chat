spec: task
name: "Dashboard hybrid thread dispatch activity"
inherits: project
satisfies: [REQ-DASHBOARD-RUNNER-PROJECTION, ADR-011]
tags: [dashboard, runner, regression]
---

## Intent

Show durable thread dispatch activity for a local Claude/Codex agent that also
retains a legacy terminal. Preserve terminal liveness and pane access while
preventing a quiet legacy pane from hiding a started or parked dispatch.

## Constraints

### Must
- Expose only allowlisted dispatch activity fields from the full per-agent ledger.
- Preserve legacy transport, runner availability classification, liveness and pane access.
- Preserve existing status fallback when there is no active or queued dispatch.

### Must Not
- Do not infer readiness, process liveness or task completion from dispatch activity.
- Do not contact external services, change runtime data, restart services or add dependencies.

## Decisions

- Add independent dispatchActivity metadata for stable local Claude/Codex identities when thread sessions are enabled, including legacy tmux/ACP transports.
- Keep runner mode and availability classification unchanged; share the existing ledger count query with the on-demand runner projection.
- Prefer running, parked, queued or unknown dispatch labels over pane activity; idle ledger state retains legacy runtime labels.
- Query errors and unknown ledger states expose unknown activity and null counts without exception text.
- [JS-only] Verify exact Vitest selectors separately from agent-spec lifecycle.

## Boundaries

### Allowed Changes
- backend-v2.js
- mockup/lib/api.js
- mockup/lib/agent-detail.js
- mockup/components/AgentHeader.jsx
- mockup/components/AgentTabs.jsx
- tests/backend-runner-projection.test.js
- tests/dashboard-runner-ui.test.js
- tests/dashboard-agent-detail.test.js
- knowledge/requirements/req-dashboard-runner-projection.md
- specs/task-dashboard-hybrid-dispatch.spec.md

## Acceptance Criteria

Scenario: Legacy Claude dispatch activity comes from the ledger
  Test: projects hybrid dispatch activity without replacing terminal liveness
  Given a local stable Claude agent with a configured tmux pane
  When queued leased started and parked dispatches are read through the agents API
  Then dispatchActivity reports their counts and activity while runner remains null
  And transport online healthy and terminal activity fields retain their observed values

Scenario: Terminal history and other agents do not imply hybrid work
  Test: ignores terminal history and other agents for hybrid dispatch activity
  Given no current dispatch and completed cancelled and outcome_unknown rows for a hybrid agent
  When another agent has a started dispatch
  Then the hybrid activity is idle with zero active and queued counts

Scenario: Hybrid query failure does not claim idle
  Test: fails closed on hybrid dispatch errors without hiding terminal state
  Given a hybrid dispatch query error or unknown ledger state
  When the agents API is read
  Then activity is unknown and counts are null without exception details
  And terminal liveness and runner classification are unchanged

Scenario: Legacy pane loss still produces terminal offline state
  Test: retains hybrid dispatch observation after legacy pane loss
  Given a started hybrid dispatch and three consecutive missing pane observations
  When the agents API is read
  Then its legacy transport remains tmux and its terminal is offline with a missing-pane reason
  And its started dispatch is still reported independently

Scenario: Unsupported identities are not assigned dispatch projections
  Test: excludes unsupported identities from dispatch activity
  Given remote unsupported-framework and missing-id agents
  When their agent API responses are read
  Then dispatchActivity is null

Scenario: Manual stop remains independent of dispatch observation
  Test: preserves a manually stopped hybrid terminal across dispatch activity
  Given a manually stopped hybrid agent with manual-offline reason
  When its ledger is idle then started then completed
  Then online remains false and manualDown transport and offline reason are preserved
  And runner remains null while dispatchActivity reflects the ledger

Scenario: The UI adapter cannot copy private dispatch fields
  Test: carries only public hybrid dispatch activity through the API adapter
  Given a backend dispatch projection with an extra private field
  When fetchLive maps the agent
  Then only public activity source and count fields enter dashboard state

Scenario: Roster activity does not hide the real terminal
  Test: renders hybrid dispatch activity without hiding the terminal
  Given a hybrid agent with running parked queued or unknown activity
  When resources workforce config header and runtime views render
  Then they display the dispatch label and retain the tmux identity and live pane

Scenario: Idle activity falls back to terminal state
  Test: falls back to observed legacy state when hybrid dispatches are idle
  Given a hybrid agent with idle dispatch activity or no projection
  When its runtime label and pane are read
  Then legacy idle active or offline labels and live pane eligibility remain unchanged

## Out of Scope

- Runner scheduling, process probes, task lifecycle, model attribution and metering.
- Live GUI testing and service restarts, which the parent E2E driver owns.
