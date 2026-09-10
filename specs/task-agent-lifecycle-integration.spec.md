spec: task
name: "Merge account and Agent lifecycle workflows with enforced boundaries"
inherits: project
satisfies: [REQ-PALPO-OUTBOUND, ADR-025]
tags: [active, integration, matrix]
---

## Intent

Commit and merge the verified account, naming and retirement changes while
retaining local stop authorization and independent outbound storage ownership.

## Constraints

### Must
- Keep router state writable only through the router API.
- Permit the pinned SQLite adapter only in router code and the separately owned outbound inbox module and its migration fixture.
- Keep the stop endpoint restricted to the local operator and retain the shared handler's local guard.
- Preserve unrelated website edits, existing deployment state and private credentials.
- Run CI and exact affected tests before completing the merge.

### Must Not
- Exempt outbound code from the router internal-import restriction.
- Treat native Node verification skips as passing.
- Publish changes or replace running services as part of the local merge.

## Boundaries

### Allowed Changes
- backend-v2.js
- scripts/check-router-boundary.js
- tests/router-build-contract.test.js
- knowledge/requirements/req-palpo-outbound.md
- specs/task-agent-lifecycle-integration.spec.md
- docs/**

## Acceptance Criteria

Scenario: The transport inbox owns only its independent storage
  Test: outbound SQLite ownership does not permit router internal imports or unrelated database clients
  Given a separate outbound inbox and router database
  When the dependency checker evaluates their imports
  Then the exact inbox module and migration fixture may use the pinned adapter
  And other consumers and router internal imports remain rejected

Scenario: The shared stop operation retains operator authorization
  Test: stop requires the local operator and refuses remote or unowned ACP processes
  Given a runtime stop request without local operator authority
  When the request reaches the stop endpoint
  Then the operation is refused
