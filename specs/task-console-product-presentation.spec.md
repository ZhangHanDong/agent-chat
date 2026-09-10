spec: task
name: "Remove debugging clutter from the provider console"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE, REQ-CONSOLE-PRODUCT-PRESENTATION]
tags: [active, console, presentation]
---

## Intent

Make the Hagency console readable for providers while preserving truthful status,
permission scope and access to diagnostics.

## Constraints

### Must
- Use concise English and Chinese product copy and accessible collapsed technical details.
- Keep sample data, unavailable slices, unknown usage and execution policy visible and truthful.
- Preserve resource publication, agent identities, approval payloads and recovery actions.
- Verify real components with deterministic Vitest tests and intercepted browser fixtures.

### Must Not
- Do not change backend behavior, credentials, authorization or live project data.
- Do not hide pending or failed operations, fabricate usage or silently present sample data as live.

## Boundaries

### Allowed Changes
- mockup/**
- tests/console-product-presentation.test.js
- tests/dashboard-console.test.js
- knowledge/requirements/req-console-product-presentation.md
- specs/task-console-product-presentation.spec.md
- docs/**

### Forbidden
- Backend, router, Matrix services and generated workspace entry files.

## Acceptance Criteria

Scenario: Diagnostics are optional without masking data failures
  Test: data status keeps partial failures visible and diagnostics collapsed
  Given live resources and unavailable or sample usage
  When the data status is rendered
  Then each affected slice is named and raw diagnostics remain in a closed disclosure

Scenario: Unknown usage stays unknown
  Test: unavailable usage has a concise label and retains its diagnostic
  Given an agent without measured usage
  When its usage cell is rendered
  Then the cell displays unavailable usage without inventing a zero and retains optional diagnostics

Scenario: Permission summaries preserve the actual policy
  Test: resource permissions remain explicit before opening the editor
  Given resources with different saved execution policies
  When the resource page is rendered
  Then each closed permission editor states the saved policy and can be opened to edit it

Scenario: Resource presentation contains no placeholder diagnostics
  Test: resource presentation has no empty error or null provider label
  Given resources without a reported provider and no failed action
  When the resource page is rendered in English or Chinese
  Then there is no empty error notification or null provider label and the runtime budget limitation remains visible

## Out of Scope

- Palpo administration, public website changes, backend naming, registration and Agent/backend runtime deployment.

The web UI may be restarted with the verified build and its existing backend
credential. Verify the same roster before switching; do not restart Agent or
Matrix processes.
