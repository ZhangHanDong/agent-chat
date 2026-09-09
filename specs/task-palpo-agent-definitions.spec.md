spec: task
name: "Project-owned Agent definitions through Palpo requests"
inherits: project
satisfies: [ADR-025, REQ-CONTRIBUTION-CONSOLE, REQ-PALPO-HAFLEET-ONBOARDING]
tags: [active, resources, agents, palpo, console]
---

## Intent

Move Agent definition to the Palpo project request flow. HAFleet publishes
resources, approves the exact requested configuration and provisions it.

## Constraints

### Must
- Authenticate the Agent definition against its Matrix source event and bind it to request replay.
- Validate the published resource and role without exposing internal IDs or cross-project definitions.
- Provision distinct identities for multiple definitions sharing a resource only after approval.
- Preserve approved/reserved identities, owner authority, project-side scope and capacity checks.
- Remove the provider web definition entry and show the project's definition during approval.
- Automatically publish new resources and derive Palpo roles from qualifying resources while respecting explicit withdrawals.
- Refresh the Palpo resource pool without discarding request drafts or automatically submitting requests.
- Record verified Palpo requests without reserving capacity; fund named project definitions from their selected Resource pool and any declared shared-account limit at approval.
- Keep legacy project-side allocation gates and show their commitments separately from pool-funded definitions.
- Accept Chinese and other Unicode Agent names, normalize them to NFC, and preserve display text while generating ASCII runtime/Matrix identities.
- Preserve existing ASCII identity derivation and reject path separators, controls and overlong names.

### Must Not
- Do not silently substitute another Agent or resource for an explicit project definition.
- Do not erase existing definitions or allocations or change budgets during live UI verification.

## Boundaries

### Allowed Changes
- backend-v2.js
- lib/**
- tests/**
- mockup/**
- knowledge/decisions/adr-025-project-owned-agent-definitions.md
- knowledge/decisions/adr-024-resource-agent-definitions.md
- specs/task-palpo-agent-definitions.spec.md
- specs/task-resource-agent-definitions.spec.md
- docs/**

### Forbidden
- Runtime credentials/data in source control and root workspace templates.

## Acceptance Criteria

Scenario: Chinese display names have safe stable identities
  Test: Unicode project names keep display text and safe distinct runtime identities
  Given Chinese and canonically equivalent Unicode project Agent names
  When the definition is validated and its runtime identity is derived
  Then the normalized display name is retained and the internal identity is ASCII
  And different scoped requests remain distinct while legacy ASCII identities remain unchanged

Scenario: Definitions are authenticated request content
  Test: fleet source verification binds the project Agent definition
  Given an authenticated project request event
  When its Agent name or resource differs from the submitted definition
  Then the protocol refuses the request before recording an engagement

Scenario: Multiple project definitions share a published resource
  Test: Palpo definitions provision distinct agents on the requested resource without provider definitions
  Given an existing strong Agent and a published medium resource
  When two project definitions request that resource and receive approval
  Then two distinct Agents inherit medium reasoning without local template creation

Scenario: Selection and recovery retain authority
  Test: Palpo definition allocation refuses substitution and preserves reservation retry
  Given a project definition and interrupted fulfillment
  When a different resource or existing Agent is selected
  Then the assignment is refused and retry retains the original identity and quota

Scenario: Definition availability is checked without changing existing work
  Test: Palpo definitions reject unpublished resources and project name conflicts
  Given published and private resources and a pending project Agent name
  When a project requests an unavailable resource or duplicate name
  Then no new definition is accepted and existing request replay remains stable

Scenario: Resource creation automatically updates the Palpo pool
  Test: new resources automatically publish qualified Palpo roles without enabling automatic acceptance
  Given a connected Palpo with no manually published role offers
  When a qualifying Resource is saved
  Then its supported roles and sanitized resource configuration appear in the callback catalog
  And a project can submit a definition which still requires provider approval

Scenario: Automatic publication follows edits and explicit withdrawals
  Test: automatic Palpo catalog follows resource edits deletion and explicit role withdrawal
  Given automatically published resources
  When a resource changes or is withdrawn or deleted
  Then the next catalog read reflects that change and omits unqualified or explicitly withdrawn roles

Scenario: Defining an Agent does not require an approved allocation
  Test: Palpo requests on a fresh resource wait for approval without consuming exhausted project budgets
  Given a project side with its allocation fully committed to an existing Agent
  When another Agent is requested on a new Resource
  Then the request is recorded once as pending without creating an Agent or reserving tokens
  And approval draws only on the selected Resource and any declared shared-account quota

Scenario: Different pools have independent capacity within a shared account
  Test: Palpo pool approval separates resource ceilings and enforces shared account quota
  Given allocations on a high pool and a fresh medium pool on the same account
  When the medium Agent is approved
  Then only medium pool commitments reduce its pool ceiling
  And the actual declared account quota still limits both pools together

Scenario: Concurrent approvals cannot oversubscribe one pool
  Test: concurrent Palpo definitions reserve the selected pool only once and preserve retry
  Given two pending definitions competing for the last allocation on one pool
  When both approvals verify their owners concurrently
  Then only one reserves capacity and retry preserves that reservation
