spec: task
name: "Retire Matrix Agent access after its last allocation"
inherits: project
satisfies: [ADR-025, REQ-PALPO-OUTBOUND, REQ-CONTRIBUTION-CONSOLE]
tags: [active, matrix, retirement, outbound]
---

## Intent

Revoking the final allocation retires the managed Agent identity, removes all
room memberships and stops local use while retaining messages and work history.

## Constraints

### Must
- Initiate every retirement request from Hagency to Palpo using the current scoped outbound credential.
- Bind retirement to a known request, exact Agent MXID and actual App Service ownership.
- Preserve the shared App Service, its representative, human users and other allocated Agents.
- Retain another active allocation or in-progress reservation for this Agent.
- Persist a local admission fence before remote work and expose pending or failed results for explicit retry.
- Verify account deactivation, zero joined rooms and refused App Service authentication.
- Preserve the original decision, chat history and Agent work files.

### Must Not
- Treat a namespace match alone as authorization to deactivate a Matrix account.
- Claim that process exit or Matrix departure succeeded without observations.
- Use erase=true or recreate a retired identity.

## Boundaries

### Allowed Changes
- backend-v2.js
- bridge-matrix.js
- lib/**
- mockup/**
- tests/**
- specs/task-agent-matrix-retirement.spec.md
- knowledge/decisions/adr-025-project-owned-agent-definitions.md
- docs/**

## Acceptance Criteria

Scenario: The last allocation retires the identity
  Test: last Palpo allocation retirement fences admission and verifies remote removal
  Given an Agent with one allocation and several Matrix rooms
  When the operator revokes that allocation
  Then Hagency retires that exact identity through its outbound credential
  And Matrix access and room departure are verified before completion

Scenario: Another allocation preserves identity access
  Test: another live allocation prevents whole Agent retirement
  Given two live allocations for the same Agent
  When one allocation is revoked
  Then whole-account retirement is not requested

Scenario: Retirement failure is recoverable
  Test: incomplete Palpo retirement stays fenced and retries the original identity
  Given a completed local revoke and a failed remote retirement
  When the operator retries
  Then the original identity and decision time are retained

Scenario: Retired Agents leave the bridge roster
  Test: bridge excludes retired agents from its App Service roster
  Given a previously known Agent whose backend record is retired
  When the bridge refreshes its roster
  Then that Agent is unavailable for App Service masquerading
