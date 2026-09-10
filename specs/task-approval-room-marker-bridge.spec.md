spec: task
name: "Approval room marker production adapter"
status: draft
inherits: project
satisfies: [REQ-APPROVAL-CANONICAL-PROJECTION, REQ-OWNER-UI-APPROVAL]
---

## Intent

Connect canonical approval-room marker rows to the existing Matrix bridge and private representative transports. Publish v2 room state before separately receipted v1 retirement, while retaining durable uncertainty and exact publisher authority across retries and restart.

## Decisions

- Marker identity remains approval room, binding generation, and marker channel; the adapter never accepts caller-authored associations.
- The backend owns prepare, begin, receipt, retry, and reconciliation state. Matrix state PUT starts only after committed begin.
- The current private actor must exactly match the row or stored plan scope, MXID, credential kind, and generation before every network attempt and after each asynchronous boundary.
- Local-bot state uses the initialized SDK client with an explicit bounded request timeout. Side state uses `sendEmptyStateToRoomOnSide` with one whole-response deadline and exact representative or appservice identity.
- State PUT has no transaction deduplication or remote CAS. Exact receipts may arrive after actor rotation; failed or indeterminate sends remain canonical retry work.
- An authenticated bridge observation of a nonempty v1 state key may request exact-room retirement reconciliation without fabricating a legacy receipt.

## Boundaries

### Allowed Changes
- bridge-matrix.js
- lib/approval-marker-bridge.js
- tests/bridge-approval-room-marker.test.js
- specs/task-approval-room-marker-bridge.spec.md

### Forbidden

- Approval worker timers, SSE handlers, bridge start/stop lifecycle, request projection payloads, approval-store/schema changes, credential generation, public notices, native verdict handling, dependencies, live Matrix calls, or GUI code.

## Acceptance Criteria

Scenario: Four bindings publish one canonical v2 state
  Test: concrete bridge sync and publish preserve the four-binding canonical manifest
  Given three agents and two projects share one owner approval room
  When the concrete MatrixBridge marker seam synchronizes and publishes the due row
  Then one empty-key v2 state PUT contains all four backend-derived tuples and its exact receipt is durable.

Scenario: Retirement follows accepted v2 publication
  Test: v2 receipt precedes distinct v1 retirement and v2 failure blocks retirement
  Given v2 and v1 retirement are separate canonical marker channels
  When v2 succeeds or fails at the captured Matrix boundary
  Then retirement becomes sendable only after the v2 receipt and uses exact custom type, empty key, and `{}` content.

Scenario: Stored uncertainty never replaces canonical bytes
  Test: uncertain marker retry reuses the stored plan and rejects rotated or rebound context
  Given a marker plan crossed begin before a lost response or restart
  When the adapter retries under unchanged or changed authority
  Then unchanged authority sends stored bytes while rotation or rebind prevents a new Matrix attempt and keeps retry state.

Scenario: Local and side state sends preserve actor identity
  Test: concrete marker seam distinguishes local appservice and representative state routes
  Given local-bot, appservice, and registration-token private actors
  When each sends an empty-key marker state event
  Then local uses bounded SDK state PUT, appservice adds exact masquerade, and representative sends without masquerade.

Scenario: Full Matrix response remains inside one deadline
  Test: side marker deadline covers response body and rechecks current actor
  Given a side response stalls or the credential changes after headers
  When the helper consumes the response body
  Then the request aborts or fails closed without recording a receipt.

Scenario: Lost legacy response is reconciled from observed state
  Test: authenticated nonempty v1 observation queues exact room reconciliation
  Given accepted v2 history and a completed prior retirement
  When the concrete bridge reads a nonempty v1 empty-key state under current private authority
  Then it requests bounded canonical re-retirement without inventing a legacy event receipt.

## Out of Scope

Scheduling, pagination fairness, SSE wakes, startup/reconnect drain, worker cancellation, and live homeserver or GUI validation remain root-owned integration work.
