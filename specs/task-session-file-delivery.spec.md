spec: task
name: "Send Agent deliverable files to the current Matrix conversation"
inherits: project
satisfies: [ADR-027, ADR-023, ADR-021, REQ-MATRIX-DM-PRIVACY, REQ-THREAD-SCOPED-SESSIONS]
tags: [active, matrix, attachments, runtime]
---

## Intent

Let Agents deliver workspace files and receive member uploads in their room,
thread or DM with accurate delivery feedback and encrypted private media.

## Constraints

### Must
- Authenticate the Agent and active dispatch before filesystem access and derive its destination from the session.
- Snapshot regular workspace files with bounded size, safe filenames and content integrity checks.
- Retain immutable file snapshots, prepared upload metadata and Matrix transaction IDs across retries.
- Encrypt attachment bytes and the message in encrypted rooms without plaintext fallback.
- Preserve per-Agent thread and DM routing, including private-room promotion protection.
- Report delivered only after Matrix acknowledgement; preserve useful queued and failed results.
- Let authenticated room members upload files, retain mention-only group wake and no-mention DM wake, and scope file reads to visible conversation history.

### Must Not
- Do not permit arbitrary destination IDs, paths outside the workspace, or weaker shell and sandbox permissions.
- Do not expose outgoing staging paths, credentials or encrypted attachment keys in model results or public notices.

## Boundaries

### Allowed Changes
- backend-v2.js
- bridge-matrix.js
- lib/session-file.js
- lib/matrix-file.js
- lib/matrix-direct-chat.js
- lib/mcp-server-core.js
- remote/lib/mcp-server-core.js
- router/src/**
- router/dist/**
- tests/**
- scripts/architecture-boundaries.json
- ./package.json
- ./package-lock.json
- knowledge/decisions/adr-027-session-file-delivery.md
- knowledge/decisions/adr-021-scoped-task-maintenance.md
- specs/task-session-file-delivery.spec.md
- docs/**

### Forbidden
- Root entry files, live credential files and weaker owner verdict or sandbox checks.

## Acceptance Criteria

Scenario: File reads stay inside the workspace
  Test: session file snapshots reject escapes special files oversized inputs and preserve bytes
  Given a dispatch workspace and files outside it
  When paths include traversal symlinks hardlinks or oversized files
  Then only bounded regular workspace files can be staged

Scenario: Actual MCP supports session attachment delivery
  Test: managed MCP sends a file through a fenced current conversation outbox
  Given a running Agent with a workspace deliverable
  When its send_file tool runs and the bridge acknowledges delivery
  Then the tool returns the delivered event without widening filesystem or room authority

Scenario: File delivery survives retries
  Test: file outbox replays immutable snapshots and fences foreign receipts
  Given an uploaded file with a persisted media reference
  When delivery retries after restart
  Then the same media and transaction are reused and another Agent cannot inspect or redirect it

Scenario: Encrypted attachments protect the actual bytes
  Test: Matrix files encrypt media before upload and retain private thread routing
  Given plaintext and encrypted Matrix destinations
  When the bridge sends the same file
  Then encrypted destinations upload ciphertext and authorized clients recover the exact file

Scenario: Failure never becomes success
  Test: attachment failures remain observable and never claim delivery
  Given a rejected upload or changed staged file
  When the bridge attempts delivery
  Then it records or retains a truthful failure and sends no false acknowledgement

Scenario: Members can send files to Agents
  Test: incoming files retain sender authority mention gating and scoped readable content
  Given uploaded files in a room and a DM
  When members address the Agent or send a private attachment
  Then the Agent can receive the exact file while foreign rooms future events and pre-promotion private files remain inaccessible

## Out of Scope

- Arbitrary cross-room forwarding, new Matrix usernames and replacing Matrix media storage.
