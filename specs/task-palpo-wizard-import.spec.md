spec: task
name: "Import Palpo authorization inside project-side onboarding"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE, ADR-019]
tags: [active, console, onboarding, matrix]
---

## Intent

Let the operator import Palpo's existing scoped authorization, review its actual
representative and callback, save and verify it inside onboarding step three.
The operator must not leave the wizard to configure the same project side.

## Constraints

### Must
- Validate the selected server, fleet namespace and credential version before any write.
- Require an explicit save; preview and final summaries must exclude tokens.
- Clear imported secrets after saving and when replacing or cancelling an import.
- Keep a saved credential when verification fails and offer verification retry.
- Distinguish credential acceptance from actual inbound event delivery.
- Preserve registration-token onboarding and manual App Service generation.
- Keep deterministic tests independent of live Matrix services.

## Boundaries

### Allowed Changes
- mockup/app/projects/new/page.jsx
- mockup/lib/fleet-credential-import.js
- tests/fleet-credential-import.test.js
- mockup/scripts/check-palpo-onboarding.mjs
- mockup/.gitignore
- specs/task-palpo-wizard-import.spec.md
- docs/**

### Forbidden
- Backend authorization changes, automatic resource approval and raw runtime-state edits.

## Acceptance Criteria

Scenario: Imported authorization stays within its selected server
  Test: wizard import refuses foreign and invalid files before saving
  Given an authorization JSON and the selected Matrix server
  When the operator saves a foreign or malformed import
  Then neither credentials nor registration files are written

Scenario: The wizard saves and verifies existing authorization
  Test: wizard import saves existing credentials then verifies without generating a registration
  Given a valid downloaded Palpo authorization
  When the operator explicitly saves the preview
  Then the selected side receives that credential and verification follows
  And preview and completion summaries contain no tokens

Scenario: Failures retain the correct recovery step
  Test: wizard import preserves save and verification failures for retry
  Given credential saving or subsequent verification fails
  When the wizard reports the result
  Then a failed save does not trigger verification
  And a failed verification retains the saved credential without regenerating it

## Decisions

Run the bound Vitest file and the controlled Playwright wizard checks against a
local console build. Deploy the console to the existing isolated walkthrough;
live server verification is separate from the deterministic tests. Node tests
must be reported separately from any Cargo-only agent-spec lifecycle skips.

## Out of Scope

- Replacing Palpo administrator authorization or its owner-authenticated download.
- Claiming reception readiness from an outbound credential check alone.
