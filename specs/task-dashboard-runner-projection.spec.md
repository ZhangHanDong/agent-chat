spec: task
name: "Dashboard on-demand runner state projection"
inherits: project
satisfies:
  - REQ-DASHBOARD-RUNNER-PROJECTION
tags: [dashboard, runner, regression]
---

## Intent

Project persistent agent availability separately from disposable runner dispatch activity.
Remove false tmux offline reports while preserving legacy runtime behavior and honest metering.

## Constraints

### Must
- Expose only allowlisted runner fields with deterministic Vitest coverage.
- Preserve manual stops and fail closed on unsupported configuration and query failures.

### Must Not
- Infer a live process or effective model from configuration or completed dispatches.
- Contact live services, modify global settings, restart services or change remote code.

## Decisions

- Use an untruncated per-agent SQLite summary for active dispatch counts.
- Keep legacy online and healthy process semantics separate from runner availability.
- Skip tmux probes for positively identified on-demand agents and preserve known legacy transport after a missing pane.
- Use the managed workdir only for metering discovery; preserve transcript attribution checks and cache identity.
- [JS-only] Run exact Vitest selectors separately from agent-spec lifecycle.

## Boundaries

### Allowed Changes
- backend-v2.js
- lib/metering/attribute.js
- lib/metering/reader.js
- router/src/store.ts
- router/dist/store.js
- router/dist/store.d.ts
- router/dist/store.js.map
- tests/backend-runner-projection.test.js
- tests/runner-metering.test.js
- specs/task-dashboard-runner-projection.spec.md
- knowledge/requirements/req-dashboard-runner-projection.md

### Forbidden
- Do not change mockup, remote or runtime data.

## Acceptance Criteria

Scenario: Ready configuration is distinct from a running process
  Test: projects ready on-demand availability without fabricating a live process or model
  Given a local paneless persistent agent with workspace and credential
  When the agents API projects its state
  Then runner availability is ready and activity is idle while online remains false and model is null

Scenario: Full ledger distinguishes queued running parked and terminal states
  Test: projects current dispatch activity independently of terminal history and display limits
  Given more than one thousand terminal dispatch rows and current work
  When the per-agent summary is read
  Then active counts include leased started and parked rows and exclude terminal history

Scenario: Legacy and unsupported agents are not upgraded
  Test: preserves legacy and unsupported runtime classification
  Given explicit tmux or ACP transport or unsupported identity framework server or transport
  When the agents API projects its state
  Then no on-demand runner is fabricated

Scenario: Missing configuration and manual stops remain unavailable
  Test: refuses readiness for manual stops and incomplete configuration
  Given a manual stop or absent workspace credential or unrelated offline reason
  When the runner is projected
  Then runner availability is unavailable with a safe reason code

Scenario: Query errors and unknown dispatch states fail closed
  Test: fails closed on dispatch query errors and unknown states
  Given a failing query or unsupported dispatch state
  When the agents API projects its state
  Then runner availability and activity are unknown without exposing the error text

Scenario: Tmux probes do not create runner ghost alerts
  Test: skips missing tmux observations for runners and retains legacy transport after pane loss
  Given an on-demand agent and a legacy agent whose pane disappeared
  When three missing-pane sweeps run
  Then the runner has no tmux-missing reason or ghost warning and the legacy agent remains offline

Scenario: Metering uses managed workdir without inventing consumption
  Test: discovers runner transcripts by managed workdir and preserves unknown and cache identity
  Given an on-demand runner with a managed workdir but no observed pane workspace
  When metering scans then the workdir changes
  Then each directory is searched and missing transcripts remain unavailable

## Out of Scope

- Process probes for one-shot guardians, scheduling changes, live GUI acceptance and service restarts.
