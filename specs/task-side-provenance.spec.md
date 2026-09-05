spec: task
name: "Authenticated project-side provenance at Matrix ingress"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE, REQ-OWNER-UI-APPROVAL, ADR-002, ADR-014, ADR-016]
tags: [draft, matrix, appservice, provenance]
---

## Intent

Carry the authenticated project side and intake mode from push, edge, and
appservice sync to one Matrix ingress boundary before any room action or
approval parsing. Close review F06: preserving the complete event sender is
insufficient when the side that supplied the event has been discarded.
This contract defines subsequent implementation; dispatch 16 creates only
this spec, with the named tests explicitly pending implementation.

## Constraints

### Must

- Attach provenance containing canonical `sideId` and `mode` from the closed set `push`, `edge`, `sync` to each appservice event. Construct it from the authenticated router entry and bridge-owned adapter, outside the event body. Preserve it through callbacks, retries, and backfill until the shared ingress boundary; bind backfill to the side credential and room used for that fetch.
- Validate provenance and room ownership before routing ordinary `m.room.message`, executing room state actions, parsing a structured approval verdict, or claiming a business-event deduplication key. Apply this order in both `MATRIX_TRUST_MODE=audit` and `enforce`, including bot-less operation.
- Resolve the side against the last successfully loaded authoritative project-side registry and its active inbound credential registration. Recheck that snapshot at ingress; a side removed by a successful refresh is absent even when its event was authenticated before the refresh.
- Use the non-federated room relation defined below. Compare the room ID's parsed server name with the registered side's server name, preserving the opaque room ID. Reject an invalid room ID, absent side, or conflicting side/room relation with a named reason and sanitized operator log.
- Keep existing room-trust, mention, command ACL, and exact room-agent owner checks after provenance validation. A valid side relation establishes origin; it does not create an owner or approve an engagement.
- Distinguish definitive rejection from an unavailable registry or missing internal provenance. Rejected events perform zero message, room, membership, or approval mutations. Retryable failures retain the transaction and sync cursor for the existing bounded retry machinery.
- After validation, coalesce concurrent deliveries and suppress completed repeats of the same `(sideId, roomId, event_id)` across intake modes and transaction IDs. Failed attempts remain retryable; mode is diagnostic context, not logical event identity. Different side/room scopes do not share a claim.
- Preserve the existing idempotent invitation path for stripped member events without an event ID. Scope it to side, room, representative, and membership; do not collapse unrelated invitations into one missing-ID key.
- Log reason, side ID, mode, room ID, and event ID or transaction ID when available. Exclude credentials, full event bodies, approval payloads, input digests, and private command details.
- Use deterministic Vitest fixtures with an isolated `HAFLEET_RUNTIME_DIR` set before bridge import, a disk-backed `TMPDIR` outside `/tmp`, disabled core dumps, and serial workers. Observe the real ingress boundary and typed downstream call counts; predicate-only tests cannot prove call-site ordering.

### Must Not

- Do not derive side ownership from a sender MXID suffix, localpart, display name, room name, API URL hostname, or a side claim in event content, query parameters, or HTTP headers. Incoming fields cannot replace authenticated provenance or select the intake mode.
- Do not classify an appservice event missing provenance as a bot SDK event, or use audit mode to continue after provenance rejection.
- Do not add a rejected event to successful business-event deduplication state, consume its approval, or suppress a later valid delivery with it.
- Do not grant a side/room relation from name, member, or tombstone content. A replacement room requires its own relation check before any follow-up join, mapping, or replay there.
- Do not enable simultaneous production intakes for the same side to test deduplication; preserve the configuration mutex and drive adapters in fixtures.

## Decisions

- **Provenance authority.** The router supplies the side selected by hs_token authentication. The local listener supplies push mode, the authenticated edge collector supplies edge mode, and the configured AS sync collector supplies sync mode. Edge/sync's configured side must match the router's authenticated side. Credential selection identifying more than one side returns a refusal before dispatch; first-match selection is not authority.
- **Registered room relation.** In this non-federated contract, registration is the existing ProjectSide relationship: canonical side ID, server name, active credential, and configured Matrix endpoint (ADR-016 decisions 1 and 2). A valid room ID belongs only when its server-name component equals that registered server name under the store's existing normalization. An explicit existing side/room record must also agree. Preserve the opaque part and any server port; do not replace this comparison with a suffix match on sender. The API URL host may differ from the Matrix server name.
- **No new per-room enrollment.** ADR-016 allows many rooms under one side registration. Room-name/group caches are not a second registry or an enrollment prerequisite. A first local-room invite for the side's configured representative can pass the origin check before a group exists; the existing invite/join path then determines room trust. A same-home-server deployment uses its registered side rather than skipping the check as a home-server case.
- **Ordering.** Authentication, provenance/room validation, shared event claim, then the existing typed path: ordinary text/commands; name/member/tombstone state; or structured approval verdicts in the already accepted protocol namespaces. Approval parsing and submission both occur after validation. Trusted bot SDK callbacks retain their authenticated client context; absent AS provenance never selects that path. Approval still checks complete sender, exact owner DM, agent, project room, request, digest, expiry, and pending state.
- **Failure disposition.** Bad credentials or ambiguous authenticated side selection return HTTP 403 without event dispatch. At ingress, definitive registry absence yields `side_not_registered`, an invalid room ID yields `invalid_room_id`, and ownership disagreement yields `room_side_mismatch`. These are terminal per-event rejections: log and discard, then continue the batch. A validly authenticated transaction returns 200 only after each event has completed or been definitively rejected; rejected events are not counted as business successes. No usable registry snapshot yields `side_registry_unavailable`; missing, invalid, or inconsistent adapter provenance yields `invalid_transport_provenance`. These return retryable HTTP 500: no transaction completion, edge success ack, or sync cursor advance. A failed backend refresh does not delete a usable prior snapshot.
- **Duplicate disposition.** Validate each receipt before a business-event dedup hit returns success. One in-flight claim owns a logical event; concurrent callers await its result, and only completion suppresses another execution. Apply this to ordinary messages, state, and verdicts while retaining backend single-use approval checks. Preserve bounded retention and restart replay; this contract does not promise indefinite or globally exactly-once delivery.
- **ADR and requirement mapping.** ADR-002 and ADR-014 decision 1 retain exact room-agent inviter/owner provenance independently of identity provisioning; this gate precedes and does not replace those checks. ADR-014 decisions 4/5 retain credential/homeserver identity, with the AS/non-federated shape settled by ADR-016. REQ-CONTRIBUTION-CONSOLE-WHITELIST-KEY and REQ-CONTRIBUTION-CONSOLE-IDEMPOTENT bind authenticated room/event identity for ordinary requests. REQ-OWNER-UI-APPROVAL-IDENTITY and REQ-OWNER-UI-APPROVAL-BINDING retain complete sender and exact approval scope. These links cover ingress obligations, not completion of the entire REQs.
- **Test binding status [JS-only].** The Filter values below are exact planned Vitest titles in `tests/bridge-side-provenance.test.js`; none is claimed to exist or pass in dispatch 16. Implementation must create these names verbatim and execute them directly with Vitest. agent-spec 1.4.0 parse/lint check the contract; skipped lifecycle results or zero selected tests prove no behavior.

## Boundaries

### Allowed Changes

- specs/task-side-provenance.spec.md
- bridge-matrix.js
- lib/appservice-receiver.js
- lib/appservice-listener.js
- lib/appservice-puller.js
- lib/appservice-sync.js
- lib/side-provenance.js
- tests/bridge-side-provenance.test.js
- tests/appservice-receiver.test.js
- tests/appservice-listener.test.js
- tests/appservice-edge.test.js
- tests/appservice-sync.test.js
- tests/bridge-appservice-intake.test.js
- tests/bridge-appservice-join-window.test.js
- tests/bridge-matrix.test.js
- tests/bridge-matrix-approval.test.js

### Forbidden

- Dispatch 16 may create or edit only specs/task-side-provenance.spec.md; the implementation paths above describe a subsequent authorized dispatch.
- Do not edit backend ownership, group-key migration, outbound masquerade, credential rotation, sync projection/gap recovery, or retry-budget policy in this ingress task; dispatches 15 and 17 own those changes.
- Do not edit remote/, install dependencies, change project-side schemas, expose secrets in the protocol, or replace the authoritative side registry.
- Do not modify runtime data, launch/restart E2E services, contact live Matrix or model services, or push this spec branch. Do not place worktrees, build outputs, or temporary files on `/tmp` under the operator's disk-space rule.

## Acceptance Criteria

### Rule: authenticated-origin — Adapters retain the authenticated source

Scenario: Push edge and sync retain adapter-owned provenance
  Tags: critical
  Test:
    Filter: side_provenance_reaches_ingress_from_push_edge_and_sync
    Level: integration
    Test Double: fake Matrix and edge endpoints, isolated bridge runtime
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given a registered side whose Matrix server name differs from its API URL host
  When push, edge, and sync each deliver a distinct event through their actual adapter and router
  Then ingress observes the canonical authenticated sideId and respective mode
  And event content and request fields cannot replace either value

Scenario: Bad credentials and ambiguous side selection dispatch nothing
  Tags: critical
  Test:
    Filter: side_provenance_rejects_bad_or_ambiguous_credentials
    Level: integration
    Test Double: registered-side fixtures and ingress callback counter
    Targets: lib/appservice-receiver.js
  Given a request with no matching credential or one matching two registered sides
  When the router authenticates the transaction
  Then it returns HTTP 403 and the ingress callback count is zero

Scenario: Missing or inconsistent provenance remains retryable
  Tags: critical
  Test:
    Filter: side_provenance_missing_or_inconsistent_context_keeps_batch_retryable
    Level: integration
    Test Double: actual adapter/router calls with controlled provenance omissions and ack counters
    Targets: lib/appservice-receiver.js, lib/appservice-puller.js, lib/appservice-sync.js, bridge-matrix.js
  Given authenticated AS deliveries with absent provenance, an invalid mode, or a different configured collector side
  When each reaches ingress in audit and enforce mode
  Then invalid_transport_provenance returns HTTP 500 with zero downstream calls
  And transaction completion, edge success ack, and sync cursor remain unchanged
  And no delivery is reclassified as a bot SDK event

### Rule: registered-room — Room identity belongs to a registered side

Scenario: A side removed after authentication no longer admits its event
  Tags: critical
  Test:
    Filter: side_provenance_rechecks_removed_side_before_event_claim
    Level: integration
    Test Double: controlled registry refresh and isolated bridge state
    Targets: bridge-matrix.js
  Given authentication precedes a successful registry refresh removing that side
  When its event reaches ingress in audit and enforce mode
  Then side_not_registered is logged and the event is definitively rejected
  And room state, owner bindings, approvals, and successful event claims are unchanged

Scenario: An unavailable registry is not an empty registry
  Tags: critical
  Test:
    Filter: side_provenance_unavailable_registry_preserves_retry_and_prior_snapshot
    Level: integration
    Test Double: failed registry responses with and without a prior snapshot, cursor recorder
    Targets: bridge-matrix.js, lib/appservice-sync.js
  Given a lookup without a usable snapshot and a separate failed refresh with a usable snapshot
  When ingress validates an event in each case
  Then the first returns side_registry_unavailable and HTTP 500 without cursor advance
  And the second evaluates the prior snapshot without deleting registered sides

Scenario: Matching sender text does not establish room ownership
  Tags: critical
  Test:
    Filter: side_provenance_rejects_room_mismatch_before_three_typed_paths
    Level: integration
    Test Double: isolated registry and message, state, approval parser and submission counters
    Targets: bridge-matrix.js
  Given a sender naming side A and rooms with invalid IDs, side B origin, or conflicting explicit ownership
  When ordinary messages, name, member, tombstone, and structured verdict fixtures arrive authenticated as side A
  Then invalid_room_id or room_side_mismatch rejects each fixture before its typed path
  And approval parser and submission counts are zero and group, trust, membership, and owner state remain unchanged
  And audit and enforce produce identical provenance rejections

Scenario: Valid local rooms retain typed paths and owner checks
  Tags: critical
  Test:
    Filter: side_provenance_valid_rooms_preserve_message_state_and_owner_checks
    Level: integration
    Test Double: isolated bridge and approval store, action-order recorders
    Targets: bridge-matrix.js
  Given side A is registered, including when it is the home server, and its project and owner DM rooms pass existing trust checks
  When an addressed message, name, member, tombstone, and structured verdict enter with authenticated side A provenance
  Then each reaches its typed path after the origin check
  And an unaddressed message wakes no agent and a verdict from a different full owner MXID is refused
  And a room name or matching sender suffix changes neither owner nor side registration

Scenario: The first representative invite needs no group enrollment
  Test:
    Filter: side_provenance_first_invite_preserves_registered_side_intake
    Level: integration
    Test Double: fake Matrix join endpoint and isolated room-trust state
    Targets: bridge-matrix.js
  Given a registered side and a local room without a group mapping
  When an authenticated invite names that side's configured representative
  Then the origin check admits it to the existing invite and room-trust path
  And the provenance check creates no owner or engagement

Scenario: Backfill and replacement rooms retain checked context
  Tags: critical
  Test:
    Filter: side_provenance_backfill_and_replacement_rooms_require_checked_context
    Level: integration
    Test Double: fake backfill response and replacement-room join/mapping counters
    Targets: bridge-matrix.js
  Given a side A backfill fetch and a side A tombstone referencing a side B room
  When fetched events and the replacement-room follow-up reach their ingress checks
  Then backfill retains side A and the originating mode and validates each event room
  And the side B replacement triggers no join or mapping and acquires no side A provenance

### Rule: rejection-and-replay — Rejection cannot become a successful claim

Scenario: Definitive rejection permits valid events in the batch
  Tags: critical
  Test:
    Filter: side_provenance_mixed_batch_rejects_invalid_events_without_success_claims
    Level: integration
    Test Double: real router, isolated bridge, completed-event and rejection-log recorders
    Targets: lib/appservice-receiver.js, bridge-matrix.js
  Given one definitively mismatched event between two valid events in an authenticated transaction
  When the two valid events complete
  Then HTTP 200 acknowledges the batch and only the two valid events have business success claims
  And the rejected event produces a named log and no downstream action
  And a later valid delivery of that event identity is evaluated without a rejection-created dedup hit

Scenario: Transient downstream failure retains the event for retry
  Tags: critical
  Test:
    Filter: side_provenance_failed_delivery_keeps_claim_and_cursor_retryable
    Level: integration
    Test Double: one failing downstream action, real router and sync cursor recorder
    Targets: bridge-matrix.js, lib/appservice-receiver.js, lib/appservice-sync.js
  Given an admitted event whose downstream action fails before completion
  When it is delivered and retried with the same checked source
  Then the first attempt returns HTTP 500 without a completed claim or cursor advance
  And the next attempt reaches its typed path and can complete

Scenario: Two intake modes execute one logical event once
  Tags: critical
  Test:
    Filter: side_provenance_cross_mode_duplicates_share_one_event_claim
    Level: integration
    Test Double: controlled promises, isolated runtime, three typed-path action counters
    Targets: lib/appservice-receiver.js, bridge-matrix.js
  Given the same sideId, roomId, and event_id in adapter fixtures with different modes and transaction IDs
  When both arrive concurrently and the second mode repeats after completion
  Then each ordinary-message, room-state, and verdict fixture executes its typed action once
  And the concurrent duplicate awaits that result and the completed duplicate takes no action
  And the same event_id in another valid room has an independent claim
  And the production same-side intake mutex remains unchanged

Scenario: Invalid duplicates are checked before a completed claim
  Tags: critical
  Test:
    Filter: side_provenance_rejects_invalid_duplicate_before_dedup_success
    Level: integration
    Test Double: completed event fixture and mismatched-source repeat
    Targets: bridge-matrix.js
  Given an event completed with valid side A provenance
  When another receipt has the same event_id but mismatched side/room provenance
  Then the origin check rejects it before a business-event dedup success is returned
  And no completed claim changes and no downstream action runs

Scenario: Stripped invites retain room-scoped idempotence
  Test:
    Filter: side_provenance_idless_invites_do_not_share_a_global_claim
    Level: integration
    Test Double: fake Matrix join endpoint and two isolated room-state fixtures
    Targets: bridge-matrix.js
  Given valid member invites without event IDs for two rooms on a registered side
  When both arrive and the first repeats through another adapter fixture
  Then both rooms reach the existing invitation path
  And the repeat creates no additional owner, group, or trust transition
  And no undefined event ID suppresses the other room's invitation

Scenario: Rejection logs exclude private payloads
  Tags: critical
  Test:
    Filter: side_provenance_rejection_logs_omit_tokens_and_approval_payloads
    Level: integration
    Test Double: sentinel private fields and captured operator logs
    Targets: bridge-matrix.js
  Given a rejected fixture containing sentinel credentials and private approval fields
  When ingress logs its rejection
  Then the log contains reason, sideId, mode, roomId, and available event or transaction ID
  And no sentinel credential, event body, approval payload, input digest, or private command appears

## Out of Scope

- Federated or cross-server rooms and reuse of a remote-origin room through another side; this contract does not define their reachability evidence.
- E2EE transport, crypto stores, key recovery, or approval-room encryption policy. Existing decrypted bot SDK behavior is not expanded.
- Robrix2 UI/computer-use testing and live E2E acceptance.
- Outbound fleet roster/masquerade, sync projection/gap recovery, registration or token rotation, join-error policy, budgets, and remote launchers.
- New per-room enrollment APIs, project-side schema migration, owner transfer, F03/F04 group/binding repairs, or indefinite/global exactly-once delivery.
- Implementing tests or production code in dispatch 16. Test/lifecycle behavior remains unverified until implementation supplies and executes the named tests; parse/lint success is spec validation only.
