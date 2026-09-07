spec: task
name: "Dashboard agent detail evidence and runner presentation"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE-PROVENANCE, REQ-CONTRIBUTION-CONSOLE-BLANK, ADR-011]
tags: [dashboard, runtime, regression]
---

## Intent

Make the agent detail page distinguish explicit on-demand runner state from terminal
state, and display only sourced profile, activity and oversight information.
Remove controls that claim success without changing or persisting anything.

## Constraints

### Must
- Preserve live and fixture provenance separately for the displayed evidence.
- Display an explicit unknown value when the backend does not report a fact.
- Run deterministic Vitest regressions using real React server rendering without external services.

### Must Not
- Do not infer missing execution history from missing terminal panes or logs.
- Do not report profile persistence or paused polling without an implemented operation.
- Do not edit backend code, API mappings, translation dictionaries or global configuration in this task.

## Decisions

- Classify runtime from explicit on-demand runner metadata, a named tmux pane, or ACP transport; otherwise report unknown.
- Keep on-demand availability distinct from current dispatch activity and preserve provider-default model uncertainty.
- Poll only a real live agent's named pane; omit the ineffective header pause and cadence buttons.
- Render profile read-only and withhold fabricated oversight for live agents; fixture evidence carries a visible sample label.
- Refuse agent deletion without a current live record and exact typed confirmation; hold a submission guard until deletion and refresh finish.
- [JS-only] Run exact Vitest tests separately because agent-spec cannot execute this Node suite.

## Boundaries

### Allowed Changes
- mockup/components/AgentDetail.jsx
- mockup/components/AgentHeader.jsx
- mockup/components/AgentTabs.jsx
- mockup/components/AgentActions.jsx
- mockup/lib/agent-detail.js
- tests/dashboard-agent-detail.test.js
- tests/dashboard-agent-actions.test.js
- knowledge/context/dashboard-agent-detail-evidence.md
- specs/task-dashboard-agent-detail-truth.spec.md

## Acceptance Criteria

Scenario: A headless ready runner is not a missing tmux session
  Test: renders an explicit ready on-demand runner without a fabricated terminal
  Given an on-demand runner with ready availability and no pane
  When AgentHeader is rendered
  Then its mode and readiness are displayed without TMUX null or refresh controls

Scenario: Runner activity and legacy terminal status remain distinguishable
  Test: renders runner activity and unknown runtime without guessing a process
  Given running, parked, queued and unknown runner observations
  When AgentHeader is rendered
  Then each observation has its own truthful label

Scenario: Profile cannot claim a save or invent identity records
  Test: renders a read-only profile without fabricated dates guidance or save controls
  Given a live agent without created date or guidance
  When Profile is rendered
  Then it displays missing data and no editable guidance or save button

Scenario: A fixture name collision cannot inject live activity
  Test: excludes sample activity for a live agent with the same fixture name
  Given a live agent whose name exists in sample logs
  When Activity is rendered
  Then it reports unavailable live logs and excludes the sample lines

Scenario: Offline activity remains explicitly a sample
  Test: labels offline activity samples at their point of use
  Given a fixture agent with sample log lines
  When Activity is rendered
  Then the lines carry a fixture label

Scenario: Missing live oversight is not a healthy assessment
  Test: excludes fabricated live oversight assessments and decisions
  Given a live active agent without supervisor evidence
  When Oversight is rendered
  Then it reports missing evidence without a health assessment or decision history

Scenario: A headless runtime does not poll an absent pane
  Test: renders headless runtime with provider-default model and no pane polling panel
  Given a headless runner without a configured model
  When Runtime is rendered
  Then it displays the real workspace, provider default and absent persistent pane

Scenario: A terminal agent does not expose an ineffective pause control
  Test: omits ineffective pause controls for a terminal agent
  Given a named tmux pane
  When AgentHeader and Runtime are rendered
  Then Runtime renders the pane reader and AgentHeader contains no pause or cadence buttons

Scenario: Missing runtime model cannot fall through to an edited preset
  Test: does not replace an observed provider-default runtime with a later preset model
  Given a resolved runtime profile without a declared model and a later edited preset
  When Runtime is rendered
  Then the model remains provider default instead of the later preset model

Scenario: Unknown provenance cannot poll a terminal
  Test: does not read a live pane for a fixture agent or unknown source
  Given a terminal-shaped agent with fixture or unavailable provenance
  When Runtime is rendered
  Then no live pane reader is mounted

Scenario: Idle dispatch state differs from runner readiness
  Test: keeps idle dispatch observation separate from runner readiness
  Given an available on-demand runner with no active dispatch
  When Runtime is rendered
  Then its availability and idle dispatch activity are displayed separately

Scenario: Non-live agent actions refuse writes even when callbacks are invoked directly
  Test: refuses deletion callbacks without live provenance
  Given a fixture or unavailable agent record and an exact typed confirmation
  When the actual remove callback is invoked
  Then it sends no request and emits no success toast

Scenario: A stale confirmation cannot delete after the live roster falls back to fixtures
  Test: refuses a previously captured callback after live provenance is lost
  Given an open live deletion confirmation
  When provenance becomes fixture before the captured callback executes
  Then it sends no delete request

Scenario: Duplicate submissions cannot overlap deletion and refresh
  Test: prevents duplicate submission until deletion and refresh finish
  Given a live agent and a confirmed removal with a pending request
  When the callback is invoked again before response and again during refresh
  Then exactly one delete request and one navigation occur

Scenario: A rejected deletion releases the submission guard without success
  Test: permits a fresh retry after a rejected delete without reporting success
  Given a live confirmed deletion whose server response is an error
  When the operator retries through the current callback
  Then the first attempt reports failure and the second request may execute

## Out of Scope

- New profile, guidance, log or supervisor persistence endpoints.
- Browser automation, service restarts, commits and runtime mutations.
