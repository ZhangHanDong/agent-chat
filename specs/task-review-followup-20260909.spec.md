spec: task
name: "Close reviewed Matrix privacy, delivery and lifecycle regressions"
inherits: project
satisfies: [ADR-019, ADR-023, ADR-027, ADR-028, REQ-EXECUTION-AUTHORIZATION, REQ-PALPO-OUTBOUND, REQ-TSS-BUILD-CONTRACT]
tags: [active, review, matrix, privacy]
---

## Intent

Recheck the operator's c380959/f89c746 review against the merged implementation,
repair remaining defects and execute the complete suite without losing failures.

## Constraints

### Must
- Retain SDK dependency isolation, typed router ownership and sandbox defaults.
- Keep private-session replies out of rooms promoted to groups, including null-root sessions.
- Preserve durable message processing while refusing permanent authorization failures.
- Bound history work by admission time and explicit limits; never download historical attachments automatically.
- Project only approved execution-grant fields into the console.
- Preserve exact process birth ownership, database upgrades and approval rollback semantics.
- Keep operator website edits and live deployment state intact.
- Record already-fixed findings separately from new fixes and unverified claims.

### Must Not
- Weaken authorization, drop claimed commands silently or mark unknown work successful.
- Claim full-suite or native lifecycle success with failed or skipped scenarios.
- Commit credentials or private infrastructure addresses.

## Boundaries

### Allowed Changes
- backend-v2.js
- bridge-matrix.js
- lib/**
- router/**
- mockup/**
- tests/**
- **/.gitignore
- scripts/architecture-boundaries.json
- docs/**
- knowledge/decisions/adr-019-live-workflow-authority-and-termination-evidence.md
- knowledge/decisions/adr-023-room-conversation-context-and-direct-chat.md
- knowledge/decisions/adr-027-session-file-delivery.md
- knowledge/decisions/adr-028-execution-authorization.md
- specs/task-review-followup-20260909.spec.md

## Acceptance Criteria

Scenario: Direct room commands remain usable
  Test: direct room commands reply through the admitted Agent and reply failure does not wedge sync
  Given an authorized direct room with no bot or representative membership
  When a real command executes and its reply fails
  Then the command has a visible failure and later messages can proceed

Scenario: Retired mentions do not block another Agent
  Test: a joined Agent without a starting device cannot wedge another direct device
  Given a room mentioning an Agent without an active device
  When another Agent processes the message
  Then only an actually starting device may defer admission

Scenario: Promotion isolates every private session
  Test: null-root private session replies are permanently refused after group promotion
  Given a private session with no thread root
  When another member joins before its reply is delivered
  Then its reply cannot enter the promoted room and is not retried forever

Scenario: Unreachable side abandonment is explicit
  Test: forced abandonment accepts classified unreachable App Service withdrawals
  Given an App Service homeserver cannot be reached
  When the local operator explicitly abandons unreachable cleanup
  Then its side can be removed without claiming remote departure

Scenario: Execution grants expose a bounded console view
  Test: execution policy and grant management reject agent credentials and preserve defaults
  Given a stored execution grant with private owner-room and source details
  When the operator reads or revokes that grant through the console
  Then only the explicit management projection is returned

Scenario: Unknown Agent ownership requires agreement
  Test: null Agent owner resolution refuses conflicting room bindings
  Given multiple owner bindings in a room
  When no Agent has been selected
  Then insertion order cannot choose the owner

Scenario: Direct history stops at the admission boundary
  Test: direct history bounds pages and excludes pre-admission plaintext and encrypted events
  Given a large room predating an Agent invitation
  When the Agent backfills
  Then old events are excluded before verification and pagination is bounded

Scenario: Discussion history avoids eager media downloads
  Test: project discussion backfill honors Agent admission and records attachments without downloading
  Given historical files and discussion before an Agent joined
  When discussion context is archived
  Then only admitted context is retained without fetching media

Scenario: Partial conversation reads make bounded progress
  Test: bounded conversation windows advance only through fully read events
  Given more discussion than one dispatch can read
  When a dispatch reads a page and successfully delivers its response
  Then a later dispatch resumes after completed events without dropping unread parts
