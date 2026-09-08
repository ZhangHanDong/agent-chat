spec: task
name: "Show registered Matrix project sides on Projects"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE, ADR-019]
tags: [active, console, onboarding]
---

## Intent

Show the server connection that onboarding created even when no project has
requested an agent. Keep server credential state, room invitations and active
agent access distinguishable on the Projects page.

## Constraints

### Must
- Render registered project sides from the existing live project-side projection.
- Preserve missing, rejected, unreachable, unverified and inactive states.
- Describe accepted credentials as identity access, without claiming inbound readiness.
- Keep invitations and agent access derived from their existing authoritative stores.
- Preserve a failed read as unavailable rather than an empty registration list.

## Boundaries

### Allowed Changes
- mockup/app/projects/page.jsx
- mockup/lib/console-workflow.js
- mockup/lib/i18n.js
- mockup/scripts/check-project-side-visibility.mjs
- tests/console-live-ux.test.js
- specs/task-project-side-visibility.spec.md
- docs/**

### Forbidden
- Changing server credentials, allocating resources, creating rooms or changing membership.

## Acceptance Criteria

Scenario: Server credential status remains distinct from project access
  Test: project-side status requires current credentials and preserves inactive and failed states
  Given a project side with observed credential and active state
  When the Projects page summarizes its connection
  Then accepted credentials are shown even without agent access
  And missing credentials and inactive or failed states cannot be shown as accepted

## Decisions

Use the existing DataProvider projectSides projection. Run the bound Vitest file
and controlled Playwright checks for a connected side with no invitations or
bindings, an empty side list, and a failed side read. Validate the deployed page
against the operator's current side without mutating it. The installed Cargo-only
agent-spec lifecycle does not replace these Node and browser checks.

## Out of Scope

- Synchronizing all remote Palpo project metadata or automatically granting agent access.
