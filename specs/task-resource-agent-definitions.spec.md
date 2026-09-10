spec: task
name: "Resource-owned Agent definitions and explicit approval selection"
inherits: project
satisfies: [ADR-024, REQ-CONTRIBUTION-CONSOLE]
tags: [historical, resources, agents, console]
---

## Intent

The provider-owned web flow is superseded by ADR-025 and
`task-palpo-agent-definitions.spec.md`. These selectors retain compatibility
coverage for existing local definition records.

Define multiple Agents under each Resource and select them when approving a
project request, while showing the published configurations in Palpo.

## Constraints

### Must
- Persist resource-owned definitions without provisioning or starting an Agent on definition creation.
- Validate unique names, roles, resource qualification and operator authority.
- Preserve explicit allocation across retry and forbid changing reserved or active assignments.
- Retain project-side, owner, seat, ceiling and existing-agent admission checks.
- Show resource definitions and explicit approval selection in both console languages.
- Keep public catalogs free of credentials, local paths and private approval data.

### Must Not
- Do not reuse an existing Agent when the provider selected a different definition.
- Do not inflate shared capacity by adding definitions or modify live allocations during ordinary UI verification.

## Boundaries

### Allowed Changes
- backend-v2.js
- lib/**
- tests/**
- mockup/**
- scripts/architecture-boundaries.json
- knowledge/decisions/adr-024-resource-agent-definitions.md
- knowledge/decisions/adr-022-resource-first-agent-allocation.md
- specs/task-resource-agent-definitions.spec.md
- docs/**

### Forbidden
- Credentials or runtime data in source control, live cursor edits and root workspace templates.

## Acceptance Criteria

Scenario: Multiple definitions persist under a resource
  Test: resource definitions persist without provisioning and enforce unique qualified names
  Given a configured resource
  When the operator defines multiple Agents
  Then their distinct names and roles persist without creating runtime agents

Scenario: Approval provisions the selected second Agent
  Test: explicit definition provisions a second agent with its own resource and stable retry
  Given an existing strong Agent and a medium resource definition
  When the provider approves a request using the definition
  Then a distinct Agent inherits the selected model and reasoning and retry retains its identity

Scenario: Assignment boundaries remain enforced
  Test: allocation choices reject foreign agents and reserved identity changes
  Given pending and reserved assignments
  When an invalid or conflicting allocation choice is supplied
  Then approval is refused without changing the existing assignment

Scenario: Public resource catalogs are bounded disclosures
  Test: published capability resources disclose models and definitions without deployment secrets
  Given published and unpublished roles with resource definitions
  When the fleet reads its capability catalog
  Then only eligible published configurations and safe Agent metadata are returned
