spec: task
name: "Close representative intake and admitted agent routing gaps"
inherits: project
satisfies: [ADR-016, ADR-018, REQ-OWNER-UI-APPROVAL, REQ-THREAD-SCOPED-SESSIONS]
tags: [matrix, intake, security, regression]
---

## Intent

Make the accepted registration-token reachability path collect real representative
events, and deliver explicitly addressed work to admitted agents before the fleet
bot joins the project room. Close the corresponding live UX findings without
inferring ownership from representative credentials or room membership.

## Constraints

### Must
- Authenticate outbound sync using the recorded representative token and bind every
  event to that credential generation, side and exact room before shared ingress.
- Deliver initial invites, hold cursors on failed delivery, persist gap recovery,
  stop collectors on side removal or credential replacement, and report poison batches.
- Copy only authoritative active backend room-agent owner bindings; require joined
  sender, representative and target agent before routing representative-room work.
- Preserve full sender MXIDs, mention gating, private approvals and source thread identity.

### Must Not
- Do not infer owners from representative tokens, display names or human room membership.
- Do not issue synthetic appservice credentials or bypass side provenance checks.
- Do not contact live services from deterministic regression tests.

## Boundaries

### Allowed Changes
- specs/task-live-matrix-intake.spec.md
- bridge-matrix.js
- lib/representative-sync.js
- lib/appservice-sync.js
- lib/matrix-representative.js
- tests/representative-sync.test.js
- tests/bridge-representative-intake.test.js

### Forbidden
- Runtime credentials and persisted production state
- router/**
- mockup/**

## Acceptance Criteria

Scenario: Registration-token sync preserves delivery and credential scope
  Given a recorded representative token and durable side cursor
  When an invite, a delivery failure, rotation or removal occurs
  Then intake preserves cursor ordering and stops stale credentials
  Test: registration representative sync delivers invites and retries before committing its cursor
  Test: registration representative sync aborts stopped polls and never dispatches stale results
  Test: ordinary representative sync joins before reading membership when stripped invite metadata comes first

Scenario: Representative-only rooms route admitted mentions
  Given a trusted room with two admitted agents and authoritative owner bindings
  When a joined human explicitly addresses one agent without the fleet bot present
  Then the addressed message reaches that agent with its source scope intact
  Test: representative room hydrates authoritative bindings and routes an admitted mention without a bot

Scenario: Admission remains fail closed
  Given missing, revoked or conflicting owner bindings or absent room members
  When representative-room input arrives
  Then no target receives work under stale or guessed authority
  Test: representative room rejects unbound targets and removes revoked imported bindings

Scenario: Each intake retains its own unavailable registry verdict
  Given the appservice registry has not loaded and the representative registry is empty
  When an appservice event reaches the provenance gate
  Then the event remains retryable without a completed claim
  Test: an unloaded appservice registry remains retryable beside an empty representative registry

Scenario: Bot sync retries failed admission hydration
  Given a bot sync response contains a trusted side-room message
  When the backend binding read fails before durable message acceptance
  Then the next SDK poll reuses the committed cursor and delivers the message once after recovery
  Test: bot sync retries side-room hydration from the committed cursor

Scenario: Unprovable gaps become actionable blocked recovery
  Given a limited timeline has no recorded prior event boundary
  When reconciliation cannot prove which events were missed
  Then the pending gap remains recorded and reports one operator warning without a poll storm
  Test: representative sync reports an unprovable gap once and preserves blocked recovery

Scenario: Bound project commands retain their authorization
  Given a joined borrower in a room with admitted agents
  When the borrower sends a protected control command
  Then the command is refused without granting approval or changing agent state
  Test: representative room control commands remain forbidden to a non-operator borrower
