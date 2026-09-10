spec: task
name: "Remove manual agent creation from the resource provider console"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE, ADR-019, ADR-022]
tags: [active, console, resources, agents]
---

## Intent

Guide providers from Resource configuration to request approval and automatic
agent provisioning, then management of the resulting agent instances.

## Constraints

### Must
- Remove manual agent creation links from navigation and Resource pages, redirecting the old /onboard URL to /resources.
- Show resource configurations before agent instances and count them independently of the agent roster.
- Explain empty agent and seat lists without requiring manual agent creation in both English and Chinese.
- Preserve existing Agent management, Resource saving and authoritative capability and approval behavior.
- Verify navigation, empty and configured resources, and retained agent links with controlled browser fixtures.

### Must Not
- Do not delete existing agents, mutate runtime credentials or create/approve a live request during verification.
- Do not present resource configuration alone as completed runtime or project admission.

## Boundaries

### Allowed Changes
- mockup/components/Rail.jsx
- mockup/app/onboard/page.jsx
- mockup/app/resources/page.jsx
- mockup/app/resources/new/page.jsx
- mockup/lib/i18n.js
- mockup/scripts/check-resource-first.mjs
- mockup/scripts/live-ux.mjs
- mockup/scripts/shots.mjs
- mockup/README.md
- tests/resource-first-console.test.js
- tests/console-live-ux.test.js
- knowledge/decisions/adr-022-resource-first-agent-allocation.md
- specs/task-resource-first-console.spec.md
- docs/**

### Forbidden
- Backend provisioning and permission changes, live Agent deletion, or writes to generated workspace entry files.

## Acceptance Criteria

Scenario: The obsolete creation URL enters the Resource workflow
  Test: old agent creation route redirects to resource configuration
  Given an operator opens the old onboarding route
  When its page handler runs
  Then navigation redirects to resources without rendering or submitting an agent form

Scenario: Resource capacity is available before any Agent exists
  Test: unused eligible resources can staff roles and supply the second review family
  Given qualifying unused resource configurations and no agent instances
  When capability is queried
  Then those resources contribute to the roles available for requests

Scenario: Requests can name the resource that will supply an Agent
  Test: it names the preset that WOULD staff the role, and still records the request
  Given a qualifying resource without a pre-created agent
  When a borrower submits a role request
  Then the request is recorded and its provisioning plan identifies the resource

## Out of Scope

- Removing CLI/API provisioning, changing allocation policy or token metering, and creating new live resources for the operator.
