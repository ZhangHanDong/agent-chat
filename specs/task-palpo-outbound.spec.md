spec: task
name: "Pure outbound Palpo integration"
inherits: project
satisfies: [REQ-PALPO-OUTBOUND]
tags: [active, matrix, outbound, durability]
---

## Intent

Operate Hagency behind NAT without a callback or SSH reverse forwarding, while
preserving verified Matrix authority, durable work and private approvals.

## Constraints

- Persist received work before ACK and preserve identical update retries.
- Reject mismatched fleets, generations, payloads and stale leases.
- Only configured authenticated outbound delivery may establish an edge proof.
- Keep legacy push and sync trust boundaries and sandbox defaults enforced.
- Keep all machine credentials out of public projections and completion summaries.
- Live service changes must be coordinated with the independent incident investigation.

## Boundaries

### Allowed Changes
- lib/**
- backend-v2.js
- bridge-matrix.js
- mockup/**
- tests/**
- specs/**
- knowledge/**
- docs/**
- scripts/architecture-boundaries.json

### Forbidden
- Original concurrent worktrees, root agent entry files and unrelated runtime state.
- Publishing credentials, weakening owner approval or inventing fulfillment.

## Acceptance Criteria

Scenario: Private machine configuration
  Test: outbound import keeps machine credentials private and rejects another fleet
  Given a Palpo outbound configuration
  When the contributor imports it
  Then only the matching fleet and server are saved and public summaries contain no token

Scenario: Durable receive and restart
  Test: outbound inbox commits before acknowledgement and resumes after restart
  Given an offered delivery and a process crash
  When the contributor acknowledges and restarts
  Then its durable inbox resumes the unprocessed delivery

Scenario: Idempotent result retry
  Test: outbound update outbox retries identical sequence after lost response
  Given a published result whose response is lost
  When the contributor restarts
  Then the same sequence and content are retried before any new update

Scenario: Conflicting delivery refused
  Test: outbound lease recovery never executes a conflicting delivery
  Given an expired lease and a repeated message identifier
  When the server issues a new lease or changes its content
  Then only the matching durable content may proceed

Scenario: Outbound bridge startup
  Test: outbound bridge works without a listener and stops replaced registrations
  Given an imported outbound fleet and no inbound socket configuration
  When the bridge starts and its registration changes
  Then the configured outbound worker starts and the old worker stops

Scenario: Exact transport proof
  Test: outbound probe receipt requires configured authenticated edge
  Given push sync and edge copies of a connection event
  When receipt provenance is checked
  Then only the configured transport and registration can establish readiness

Scenario: Preserve existing encrypted devices
  Test: changed direct device endpoint verifies the original token and preserves device and crypto state
  Given a cached encrypted device and a new configured URL for the same homeserver
  When the bridge restarts with the new endpoint
  Then the existing device token must prove the same Matrix user and device before only its cached URL changes

## Out of Scope

- Replacing Matrix encryption or model execution approval.
- Claiming fixture results are live browser or native-client acceptance.
