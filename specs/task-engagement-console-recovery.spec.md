spec: task
name: "Project labels and recoverable engagement revocation"
inherits: project
satisfies: [ADR-025, REQ-CONTRIBUTION-CONSOLE]
tags: [active, console, engagement, matrix]
---

## Intent

Show the project's observed room name and report the actual outcome of revocation
when a response is lost or Matrix refuses to leave the room.

## Constraints

### Must
- Keep room IDs and full MXIDs as authorization keys; project names are display metadata only.
- Read names from the authenticated target room after request verification.
- Persist revocation before external cleanup and retain its cleanup outcome for refresh and retry.
- Reconcile an ambiguous response against authoritative state without automatically resending the write.
- Retain another live engagement's room binding and preserve original revocation time on retry.

### Must Not
- Deactivate human Matrix accounts or revoke unrelated live allocations during verification.
- Treat failed or unknown room withdrawal as a confirmed departure.

## Boundaries

### Allowed Changes
- backend-v2.js
- lib/engagement-store.js
- lib/fleet-protocol.js
- mockup/**
- tests/**
- knowledge/decisions/adr-025-project-owned-agent-definitions.md
- specs/task-engagement-console-recovery.spec.md
- docs/**

## Acceptance Criteria

Scenario: Verified room names remain separate from request authority
  Test: fleet observes project names without trusting request display metadata
  Given an authorized project request with an invented display name
  When the bridge reads its target Matrix room
  Then it forwards the observed name separately from the immutable request context

Scenario: Labels do not merge different rooms
  Test: console project labels use exact rooms and preserve unknown identifiers
  Given projects with equal names on different rooms
  When the console resolves a project label
  Then it uses the exact room identity and preserves the identifier for unnamed rooms

Scenario: A lost response can be reconciled
  Test: console reconciles a timed out revoke without repeating the write
  Given a revoke response is lost after the decision is saved
  When the console reads the exact engagement
  Then it reports the saved decision while retaining the room cleanup state

Scenario: Failed cleanup can be retried safely
  Test: revoked room cleanup survives refresh and retries without releasing twice
  Given Matrix refuses the first room leave
  When the operator retries the same revocation
  Then the persisted cleanup result updates without changing the original decision

Scenario: Another allocation retains its room seat
  Test: but NOT while another engagement still puts that agent in that room
  Given two active engagements for one agent in one room
  When one engagement is revoked
  Then the remaining engagement retains room access
