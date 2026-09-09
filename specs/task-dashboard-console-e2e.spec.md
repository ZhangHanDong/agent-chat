spec: task
name: "Dashboard live controls and runner labels"
inherits: project
satisfies:
  - REQ-CONTRIBUTION-CONSOLE
tags: [dashboard, regression, local-e2e]
---

## Intent

Make the local contribution console show the runtime evidence it receives and
route configuration actions to working forms. Remove success-only prototype
controls that leave the operator believing a change was saved or an agent stopped.

## Constraints

### Must
- Read on-demand runner availability separately from process liveness.
- Keep unavailable observations explicit and render probe states in both locales.
- Run deterministic Vitest regressions and actual local browser checks.

### Must Not
- Change global credentials, mempal configuration, or original Herdr jobs.
- Contact remote homeservers or publish source changes.
- Claim task, process, or mutation success from a toast alone.

## Decisions

- Reuse the existing preset wizard, onboarding route, and agent detail actions.
- Consume the backend's explicit runner projection without inventing a model.
- [JS-only] Run exact Vitest selectors separately; lifecycle skips are not passing tests.

## Boundaries

### Allowed Changes
- mockup/**
- tests/dashboard-console.test.js
- tests/dashboard-runner-ui.test.js
- tests/helpers/dashboard-render.js
- specs/task-dashboard-console-e2e.spec.md
- specs/project.spec.md
- docs/**
- README.md
- ./package.json
- .github/workflows/ci.yml

## Acceptance Criteria

Scenario: Configuration opens real forms
  Test: opens resource configuration and project request review through real links
  Given the live configuration page
  When the operator chooses to configure a resource or review project requests
  Then the existing form route opens

Scenario: Lifecycle controls preserve actual authority
  Test: delegates lifecycle operations to agent detail instead of fake success buttons
  Given a registered agent
  When the operator chooses lifecycle management
  Then the detail page provides the existing confirmed actions

Scenario: Host probe failures are readable
  Test: names an unusable framework without leaking a dictionary key
  Given a host probe reporting an unusable framework
  When the console renders either locale
  Then a readable failure label is shown

Scenario: Rosters display on-demand readiness separately
  Test: distinguishes ready runners from offline tmux sessions
  Given an idle headless runner that can accept a dispatch
  When the resource roster, workforce, and configuration page render
  Then they show on-demand readiness without a missing tmux warning

Scenario: API mapping retains the public runner evidence
  Test: carries only the public runner projection through the API adapter
  Given a runner projection from the backend
  When the client adapts the agent record
  Then it retains readiness and activity while excluding private launch fields

Scenario: Resources use measured consumption
  Test: resources show measured token consumption from the same live usage slice
  Given an agent with recorded fresh tokens and cache reads
  When its resource row renders
  Then it shows fresh tokens without labeling them unmeasured

Scenario: Old onboarding links use resource allocation
  Test: routes legacy onboarding to resource allocation
  Given a saved local Agent onboarding link
  When the operator opens it
  Then it redirects to Resources where approved project requests allocate Agents

## Out of Scope

- Creating a replacement task scheduler, adding provider credentials, or terminating live jobs.
