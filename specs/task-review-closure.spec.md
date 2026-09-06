spec: task
name: "Close September specification review findings"
inherits: project
satisfies: [REQ-THREAD-SCOPED-SESSIONS, REQ-CONTRIBUTION-CONSOLE, REQ-OWNER-UI-APPROVAL, REQ-AGENT-OPS-CLIENT, ADR-016, ADR-011, ADR-018]
tags: [security, correctness, regression, review]
---

## Intent

Close the confirmed findings in docs/reviews/2026-09-05-spec-gap-review.md
with executable regression evidence. Keep the original review as historical
evidence and record closure separately, including any unmet external release gate.

## Constraints

### Must

- Hold runtime resources until the owned runtime process group has terminated.
- Fail closed on ambiguous credentials, unavailable provenance, missing ownership,
  retired identities and unauthenticated requester room claims.
- Derive seats from raw credentials without returning secrets to clients.
- Resolve request-id replay before charging a new commitment.
- Fulfill accepted resource requests through durable, recoverable provisioning.
- Preserve private approval controls and exact borrower/inviter ownership.
- Exercise the actual production adapters and state transitions in regression tests.
- Record pass, fail, skip, uncertain and external evidence separately.

### Must Not

- Do not weaken sandboxes, Matrix sender/room validation or privacy to close a finding.
- Do not count test names, renamed contracts or development manifests as release evidence.
- Do not use production services or credentials in deterministic tests.
- Do not delete dirty worktrees, production rooms or historical ledger records.

## Boundaries

### Allowed Changes

- backend-v2.js
- bridge-matrix.js
- lib/**
- router/src/**
- router/dist/**
- tests/**
- specs/**
- knowledge/**
- docs/**
- scripts/**
- ./package.json
- ./package-lock.json

### Forbidden

- Runtime data, local environment files, root AGENTS.md and root CLAUDE.md.
- Production configuration, deployment, remote service restart and credential publication.

## Acceptance Criteria

Scenario: Runtime cleanup precedes workspace release
  Test: completed Codex dispatch retains its lease until runtime termination
  Given a runtime delays its shutdown and writes during that delay
  When its model turn reports completion
  Then the workspace remains leased until that runtime exits

Scenario: Runtime descendants do not survive completion
  Test: guardian cleans up descendants when the runtime exits normally
  Given a runtime starts a background child and then exits successfully
  When the runner completes
  Then no descendant can continue writing to the released workspace

Scenario: Credential selection is unique
  Test: side_provenance_rejects_bad_or_ambiguous_credentials
  Given two distinct registrations share an inbound token
  When the token authenticates a transaction
  Then dispatch is refused before selecting a registration

Scenario: Internal provenance faults retain retries
  Test: side_provenance_missing_or_inconsistent_context_keeps_batch_retryable
  Given an authenticated adapter supplies missing or inconsistent metadata
  When the batch reaches ingress
  Then the batch fails without transaction completion or cursor advance

Scenario: Transport metadata belongs to the adapter
  Test: push listener cannot accept a body-selected intake mode
  Given a push body claims another intake mode
  When it enters through the HTTP listener
  Then its provenance remains push

Scenario: Contribution selection respects project and retirement
  Test: engagement selection excludes foreign-side and retired agents
  Given eligible agents belong to different sides or have been retired
  When a request selects its serving agent
  Then only a live identity on the requested side may be reused

Scenario: Seat accounting uses credential identity and comparable periods
  Test: engagement admission preserves seat identity and unknown periods
  Given distinct API keys or a quota with an unknown period
  When the backend reports seats and evaluates automatic admission
  Then keys remain separate and an unknown period requires approval

Scenario: Owner binding is an activation prerequisite
  Test: missing engagement owner does not commit active success
  Given no exact room owner can be resolved
  When an engagement is approved
  Then the request stays unfulfilled without a committed allocation

Scenario: Replay precedes budget admission
  Test: engagement replay succeeds after exhausting side allocation
  Given a request has already committed the remaining allocation
  When the same request is repeated
  Then the original engagement is returned without a new budget alarm

Scenario: Demand provisions its serving resource
  Test: accepted engagement provisions a resource without a preexisting agent
  Given a qualifying resource exists and no agent has been created
  When an authorized request is accepted
  Then a durable provisioning operation creates and binds its serving agent

Scenario: Requester identity is not room authority
  Test: requester token cannot claim a whitelisted room
  Given a submit-only caller names another room
  When it submits or reads that room's whitelist state
  Then no automatic admission or private room disclosure occurs

Scenario: Borrower responses exclude private binding details
  Test: requester engagement responses redact private ownership and configuration
  Given an internal binding result contains owner or configuration metadata
  When it is returned to a requester
  Then only the borrower-safe fulfillment result is disclosed

Scenario: Side retirement cleans only its own resources
  Test: side removal preserves unrelated alerts and withdraws memberships
  Given two sides have alerts and joined agents
  When one side is removed
  Then its memberships are withdrawn before credentials are forgotten
  And the other side's alerts remain active

Scenario: Acceptance selectors resolve to executable evidence
  Test: active spec selectors resolve to registered tests
  Given the active specification files and registered test titles
  When acceptance bindings are checked
  Then every bound selector names an executable test

Scenario: Registration-token resources are fulfilled by the bridge
  Test: registration-token fulfillment persists the bridge credential before activation and uses it to leave
  Given the project side supplies a registration token
  When its resource request is approved
  Then the bridge durably owns the new credential before activation
  And departure and side removal use and revoke the owned tokens

Scenario: Lost registration acknowledgements recover without another account
  Test: a lost registration acknowledgement reuses the durable credential after bridge restart
  Given registration succeeded but its acknowledgement was lost
  When the queue claim expires and the bridge restarts
  Then the same credential completes the request and stale acknowledgements are rejected

Scenario: Cancelled joins are compensated
  Test: cancelling a fulfillment during Matrix join withdraws again after the late join
  Given the homeserver has an in-flight join
  When the operator rejects the request
  Then a late join is followed by withdrawal and the incomplete agent cannot be reused

Scenario: Capacity reservations precede agent creation
  Test: an unprovisioned reservation prevents another side from overbooking the same seat
  Given a reservation exists but its agent home is not ready
  When another side asks for the remaining resource
  Then admission includes the durable reservation in seat accounting

Scenario: Provider bootstrap ownership cannot replace borrower ownership
  Test: a configured provider owner never replaces an absent borrower binding on a project side
  Given a project side exists without its own owner binding
  When an operator approves a request
  Then provider environment defaults cannot activate it
  And an explicit borrower owner can establish the required binding

Scenario: Cross-family availability agrees across surfaces
  Test: one-family review offers, preview and admission agree that the role is unavailable
  Given only one qualifying model family serves the project side
  When review capacity is previewed, advertised or requested
  Then no surface claims that the cross-family role can be fulfilled

Scenario: Irrecoverable cleanup requires an explicit recorded decision
  Test: permanently unavailable Matrix credentials require explicit audited cleanup abandonment
  Given an agent credential belongs to a different homeserver
  When side removal cannot withdraw its membership
  Then credentials remain until an operator explicitly abandons the unreachable membership
  And the partial outcome is preserved in the removal audit
