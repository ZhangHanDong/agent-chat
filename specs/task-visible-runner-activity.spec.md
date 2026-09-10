spec: task
name: "Readable Agent names and observable Matrix execution"
inherits: project
satisfies: [ADR-026, ADR-023, ADR-025, REQ-THREAD-SCOPED-SESSIONS]
tags: [active, matrix, runtime]
---

## Intent

Show project Agent names and live tool activity in the same Matrix conversation.

## Constraints

### Must
- Preserve Matrix identity and manually customized display names while repairing generated names.
- Derive progress from fenced runner events and durable approval and settlement state.
- Coalesce updates into one editable status with periodic liveness and durable delivery retries.
- Preserve per-Agent thread routing and encrypted DM delivery; exclude status from model context.
- Send only fixed categories and counts without commands, arguments, results or private approval details.

### Must Not
- Do not weaken sandbox, owner approval, Matrix identity or task completion authority.
- Do not accept activity from a foreign turn or a stale runner.

## Boundaries

### Allowed Changes
- lib/matrix-agent-profile.js
- lib/matrix-activity.js
- lib/matrix-direct-chat.js
- bridge-matrix.js
- router/src/**
- router/dist/**
- tests/**
- specs/task-visible-runner-activity.spec.md
- knowledge/decisions/adr-026-visible-runner-activity.md
- docs/**
- scripts/architecture-boundaries.json

### Forbidden
- Root workspace entry files, live credentials, canonical task records and weaker sandbox policies.

## Acceptance Criteria

Scenario: Profile repair retains identity and user customization
  Test: repairs generated Matrix names and preserves custom profiles with verified readback
  Given a project Agent with a generated Matrix profile
  When profile reconciliation runs
  Then its readable name is published without changing its MXID or overwriting a custom name

Scenario: Progress is fenced redacted and durable
  Test: activity coalesces retries and fences terminal or foreign writes
  Given an active dispatch and its authoritative conversation
  When tool events repeat and delivery retries after restart
  Then one status anchor receives bounded updates and invalid writes have no effect

Scenario: Native events produce visible activity
  Test: Codex and Claude tool events publish redacted progress before the final answer
  Given real runner adapters with deterministic subprocess fixtures
  When tools execute and Codex sends foreign notifications
  Then matching activity appears before completion and foreign events are ignored

Scenario: Approval state stays accurate
  Test: activity reflects approval parking resumption and terminal state
  Given an active runner with an owner approval
  When it parks resumes and settles
  Then status follows durable state without exposing approval details or marking its task done

Scenario: Matrix status edits stay in the correct conversation
  Test: activity edits preserve threads and encrypted DM routing without becoming model input
  Given a status anchor in a thread or DM
  When a progress edit is sent and received
  Then it updates that Agent's anchor through the existing transport and never wakes an Agent

## Out of Scope

- Renaming Matrix IDs, changing global username allocation, and changing permissions.
