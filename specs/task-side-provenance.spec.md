spec: task
name: "Authenticated project-side provenance at Matrix ingress"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE, REQ-OWNER-UI-APPROVAL, ADR-002, ADR-014]
tags: [draft, matrix, appservice, provenance]
---

## Intent

Carry the authenticated project side and intake mode from push, edge, and
appservice sync to one Matrix ingress boundary before any room action or
approval parsing. Close review F06: preserving the complete event sender is
insufficient when the side that supplied the event has been discarded.
Dispatches 16 and 16-r1 change only this spec; the named tests remain planned.
This draft is not ready for implementation until the operator resolves the
identity model in Questions and the ADR, boundaries, and test fixtures agree
with that decision. Parse/lint success does not resolve that architecture choice.

## Constraints

### Must

- Attach provenance containing the authenticated `registration`, canonical `sideId`, and `mode` from the closed set `push`, `edge`, `sync` to each appservice event. Here registration denotes the non-secret identity of the selected authoritative credential record, not the token value or a newly assumed schema field; its stable identity depends on the pending A/B decision. Construct provenance from the authenticated router entry and bridge-owned adapter, outside the event body. Preserve it through callbacks, retries, and backfill until the shared ingress boundary; bind backfill to the registration credential and room used for that fetch.
- Validate provenance and room ownership before routing ordinary `m.room.message`, executing room state actions, parsing a structured approval verdict, or claiming a business-event deduplication key. Apply this order in both `MATRIX_TRUST_MODE=audit` and `enforce`, including bot-less operation.
- Resolve the side against the last successfully loaded authoritative project-side registry and its active inbound credential registration. Recheck that snapshot at ingress; a side removed by a successful refresh is absent even when its event was authenticated before the refresh.
- Require an authoritative room-to-registration relation under the operator-selected identity model, preserving the complete opaque room ID. A matching room server name alone cannot prove fleet ownership when registrations share that server. Reject an invalid room ID, absent registration, or definitively conflicting relation with a named reason and sanitized operator log; unavailable relation evidence remains retryable.
- Keep existing room-trust, mention, command ACL, and exact room-agent owner checks after provenance validation. A valid side relation establishes origin; it does not create an owner or approve an engagement.
- Distinguish definitive rejection from an unavailable registry, unavailable room-relation evidence, or missing internal provenance. Rejected events perform zero message, room, membership, or approval mutations. A batch containing any retryable failure returns HTTP 500, never 200, with no transaction completion, edge success ack, or sync cursor advance; the existing bounded retry policy remains in charge.
- After validation, coalesce concurrent deliveries and suppress completed repeats of the same `(registration, roomId, event_id)` across intake modes and transaction IDs. Failed attempts remain retryable; mode is diagnostic context, not logical event identity. Different registration/room scopes do not share a claim.
- For stripped member invites without an event ID, use the complete tuple `(registration, opaque roomId, full event.sender inviter MXID, full state_key target MXID, membership, authorization-relevant stripped content)`. Preserve both MXIDs in full, including localpart case and server; never reduce them to localparts or a representative label. Serialize the tuple unambiguously and canonicalize object key order in stripped content. Include the complete invite content conservatively, plus any additional stripped state consumed by the authorization decision; different authorization inputs must not share a claim. Missing required invite identity follows existing invalid-event validation, never a shared missing-ID key.
- Replaying the same idless invitation fact across modes is idempotent; a different full inviter MXID is distinct evidence and must reach the existing room-agent owner decision again. A fresh claim does not grant or transfer ownership; retain ADR-002's exact binding, ambiguity rejection, and explicit audited transfer rule.
- Log reason, non-secret registration identity, side ID, mode, room ID, and event ID or transaction ID when available. Exclude credentials, full event bodies, approval payloads, input digests, and private command details.
- Use deterministic Vitest fixtures with an isolated `HAFLEET_RUNTIME_DIR` set before bridge import, a disk-backed `TMPDIR` outside `/tmp`, disabled core dumps, and serial workers. Drive actual push, edge, and sync adapters through the real router and bridge ingress; observe typed downstream call counts and adapter transaction/ack/cursor outcomes. Predicate-only tests or direct ingress calls cannot substitute for these integration scenarios.

### Must Not

- Do not derive side ownership from a sender MXID suffix, localpart, display name, room name, API URL hostname, or a side claim in event content, query parameters, or HTTP headers. Incoming fields cannot replace authenticated provenance or select the intake mode.
- Do not classify an appservice event missing provenance as a bot SDK event, or use audit mode to continue after provenance rejection.
- Do not add a rejected event to successful business-event deduplication state, consume its approval, or suppress a later valid delivery with it.
- Do not grant persistent side/room ownership from name, member, or tombstone content. The first-invite exception admits only the selected registration's exact representative under the operator-selected bootstrap proof; event content alone cannot establish that proof. A replacement room requires its own relation check before any follow-up join, mapping, or replay there.
- Do not enable simultaneous production intakes for the same side to test deduplication; preserve the configuration mutex and drive adapters in fixtures.

## Decisions

- **Provenance authority.** The router supplies the registration selected by hs_token authentication and its side. The local listener supplies push mode, the authenticated edge collector supplies edge mode, and the configured AS sync collector supplies sync mode. Edge/sync's configured registration must match the router's authenticated registration. Credential selection identifying more than one registration returns a refusal before dispatch; first-match selection is not authority. The term registration does not assert that today's server-keyed store can represent two fleets on one server.
- **Room relation evidence.** The identity model and its room-ownership proof are pending operator decision A/B in Questions. Common requirements are exact opaque room identity, authoritative registration evidence, rejection of conflicting ownership, and a distinct unavailable-evidence outcome. A failed or incomplete project/member lookup is not evidence of non-membership; only a successful, sufficient lookup may establish a definitive mismatch. A prior usable snapshot may be evaluated, but insufficient coverage is unavailable evidence. The Matrix server name and discovered API URL host remain distinct, and room IDs and server ports must be preserved.
- **Bootstrap and existing rooms.** Room-name/group caches are not an ownership registry or an enrollment prerequisite. A first representative invite must name the selected registration's exact representative MXID recorded through identity discovery, satisfy the operator-selected bootstrap proof, and then enter the existing invite/join and room-trust path. This exception does not admit unrelated messages, state, or verdicts in that room. Existing project and owner DM rooms need the selected model's authoritative relation. Home-server operation still uses the registered source; it does not skip the gate.
- **Ordering.** Authentication, provenance/room validation, shared event claim, then the existing typed path: ordinary text/commands; name/member/tombstone state; or structured approval verdicts in the already accepted protocol namespaces. Approval parsing and submission both occur after validation. Trusted bot SDK callbacks retain their authenticated client context; absent AS provenance never selects that path. Approval still checks complete sender, exact owner DM, agent, project room, request, digest, expiry, and pending state.
- **Terminal failures.** Bad credentials or ambiguous authenticated registration selection return HTTP 403 without event dispatch. At ingress, definitive registry absence yields `side_not_registered`, an invalid room ID yields `invalid_room_id`, and a successfully read, sufficient relation proving non-ownership or conflicting ownership yields `room_side_mismatch`. These are terminal per-event rejections: log and discard, then continue the batch. HTTP 200 is permitted only after every event has completed or been definitively rejected; rejected events are not business successes.
- **Retryable failures.** No usable registry snapshot yields `side_registry_unavailable`; missing, invalid, or inconsistent adapter provenance yields `invalid_transport_provenance`; failed relation reads or snapshots insufficient to decide project/representative room membership yield `room_relation_unavailable`. Each returns HTTP 500 with zero typed actions or completed event claims for that receipt. Any such event makes the entire batch retryable: no transaction completion, edge success ack, or sync cursor advance even if other events completed or were definitively rejected. Downstream transient failures also keep the batch retryable. Already completed events keep their claims and coalesce on whole-batch replay; failed events must be evaluated again. A failed refresh does not delete a usable prior snapshot or convert unavailable evidence into a definitive mismatch.
- **Duplicate disposition.** Validate each receipt before a business-event dedup hit returns success. One in-flight claim owns a logical event; concurrent callers await its result, and only completion suppresses another execution. Apply this to ordinary messages, state, and verdicts while retaining backend single-use approval checks. Preserve bounded retention and restart replay; this contract does not promise indefinite or globally exactly-once delivery.
- **ADR and requirement mapping.** ADR-002 and ADR-014 decision 1 retain exact room-agent inviter/owner provenance independently of identity provisioning; the idless tuple preserves different inviters as different evidence, not an implicit owner transfer. ADR-014 decisions 4/5 provide credential/homeserver and discovered representative identity. ADR-016 decisions 1/2 document the existing one-side-per-server and non-federated model; their structural identity conflicts with independent fleets sharing a server. ADR-016 is therefore deliberately absent from satisfies while A/B is unresolved, rather than asserted satisfied by a room-server comparison. REQ-CONTRIBUTION-CONSOLE-WHITELIST-KEY and REQ-CONTRIBUTION-CONSOLE-IDEMPOTENT bind authenticated room/event identity for ordinary requests. REQ-OWNER-UI-APPROVAL-IDENTITY and REQ-OWNER-UI-APPROVAL-BINDING retain complete sender and exact approval scope. These links cover ingress obligations, not completion of the entire REQs.
- **Test binding status [JS-only].** The Filter values below are exact planned Vitest titles in `tests/bridge-side-provenance.test.js`; none is claimed to exist or pass in dispatches 16/16-r1. Each title must expand into push, edge, and sync integration cases using the actual listener/puller/sync adapter, real receiver/router, and real bridge ingress. Mock only transport endpoints, registry/relation data reads, and typed downstream effects; provenance-failure cases may inject the named internal fault after authentication. Keep registration selection, relation validation, deduplication, and owner decisions real; spies may observe owner/approval checks but may not supply successful verdicts. Do not stub successful provenance validation or call only a predicate/ingress helper. Cross-mode titles exercise push-edge, push-sync, and edge-sync pairs with isolated adapter fixtures while retaining the production mutex. Create the titles verbatim and execute them directly with Vitest after the operator-selected proof is implemented; skipped lifecycle results or zero selected tests prove no behavior.

## Questions

- **Identity model (room ownership proof): pending operator decision A/B — 待 operator 裁决.** A introduces a stable registrationId/fleetId independent of serverName: hs_token uniquely selects it, and exact opaque room IDs need that registration's authoritative room-domain proof. A project record must identify that registration; if representative membership proves an existing room, verify its exact discovered representative and reject conflicting registration evidence. The first-invite exception requires that exact representative as state_key and preserves existing trust/owner checks. A requires an ADR-016 revision or successor, schema/store/candidate/receiver changes, and expanded boundaries before implementation; same-server multi-fleet fixtures must then prove A-token/B-room message, state, and approval rejection before parsing, while A-room succeeds. B retains one-side-per-server: registration identity is the existing side ID/serverName, with one credential and representative; room-server equality is usable only within that explicit deployment assumption and any authoritative side/room record must agree. B must document independent fleets sharing a server as unsupported; operators need separate homeservers or one shared fleet registration. Neither option is selected by this draft, and neither is implicitly accepted by parse/lint.

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

- Dispatches 16/16-r1 may create or edit only specs/task-side-provenance.spec.md; the implementation paths above are provisional for a subsequent authorized dispatch after the operator's A/B decision.
- Do not edit backend ownership, group-key migration, outbound masquerade, credential rotation, sync projection/gap recovery, or retry-budget policy in this ingress task; dispatches 15 and 17 own those changes.
- Do not edit remote/, install dependencies, change project-side schemas, expose secrets in the protocol, or replace the authoritative side registry in this dispatch. If A is selected, revise the ADR and these boundaries in a separately authorized task before its required schema/store/candidate/receiver changes; this list does not authorize a schema-free substitute for A.
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
  Then ingress observes the authenticated registration, canonical sideId, and respective mode
  And event content and request fields cannot replace any of these values

Scenario: Bad credentials and ambiguous side selection dispatch nothing
  Tags: critical
  Test:
    Filter: side_provenance_rejects_bad_or_ambiguous_credentials
    Level: integration
    Test Double: fake transport endpoints, registered-credential fixtures, bridge dispatch counter
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given adapter requests with no matching credential or one matching two authoritative registration records
  When each real push, edge, and sync adapter submits its transaction to the router
  Then the router returns HTTP 403 and the bridge ingress dispatch count is zero

Scenario: Missing or inconsistent provenance remains retryable
  Tags: critical
  Test:
    Filter: side_provenance_missing_or_inconsistent_context_keeps_batch_retryable
    Level: integration
    Test Double: actual adapter/router calls with controlled provenance omissions and ack counters
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given authenticated AS deliveries with absent provenance, an invalid mode, or a different configured collector side
  When each real push, edge, and sync adapter delivers the affected batch in audit and enforce mode
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
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given authentication precedes a successful registry refresh removing that side
  When each real push, edge, and sync adapter releases its authenticated event to ingress in audit and enforce mode
  Then side_not_registered is logged and the event is definitively rejected
  And room state, owner bindings, approvals, and successful event claims are unchanged

Scenario: An unavailable registry is not an empty registry
  Tags: critical
  Test:
    Filter: side_provenance_unavailable_registry_preserves_retry_and_prior_snapshot
    Level: integration
    Test Double: failed registry responses with and without a prior snapshot, cursor recorder
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given a lookup without a usable snapshot and a separate failed refresh with a usable snapshot
  When each real push, edge, and sync adapter delivers an event in each case
  Then the first returns side_registry_unavailable and HTTP 500 without transaction completion, edge success ack, or cursor advance
  And the second evaluates the prior snapshot without deleting registered sides

Scenario: Matching sender text does not establish room ownership
  Tags: critical
  Test:
    Filter: side_provenance_rejects_room_mismatch_before_three_typed_paths
    Level: integration
    Test Double: isolated registry and message, state, approval parser and submission counters
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given a sender naming side A and rooms with invalid IDs or sufficient authoritative relation reads proving non-ownership or conflicting ownership
  When each real push, edge, and sync adapter delivers ordinary messages, name, member, tombstone, and structured verdict fixtures authenticated as registration A
  Then invalid_room_id or room_side_mismatch rejects each fixture before its typed path
  And approval parser and submission counts are zero and group, trust, membership, and owner state remain unchanged
  And audit and enforce produce identical provenance rejections

Scenario: Relation read failure is retryable and differs from proven mismatch
  Tags: critical
  Test:
    Filter: side_provenance_relation_unavailable_retries_before_three_typed_paths
    Level: integration
    Test Double: fake transport endpoints, failed project/member relation reads, incomplete and complete snapshots, typed-path and ack/cursor counters
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given a valid authenticated registration with relation reads that fail or lack sufficient snapshot coverage for the operator-selected proof
  When each real push, edge, and sync adapter delivers ordinary messages, name, member, tombstone, and structured verdicts in audit and enforce mode
  Then room_relation_unavailable returns HTTP 500 with zero message, state, approval parser, and submission calls and no successful event claim
  And no transaction completes, no edge success ack is sent, and the sync cursor remains unchanged
  When relation reads recover and the same batch is replayed through the same adapter
  Then a sufficient positive relation admits its typed path once
  And a separate sufficient negative or conflicting relation yields terminal room_side_mismatch with zero typed calls and permits HTTP 200 when no other event needs retry

Scenario: Valid local rooms retain typed paths and owner checks
  Tags: critical
  Test:
    Filter: side_provenance_valid_rooms_preserve_message_state_and_owner_checks
    Level: integration
    Test Double: isolated bridge and approval store, action-order recorders
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given registration A is active, including on the home server, and its project and owner DM rooms have authoritative relation evidence under the operator-selected model and pass existing trust checks
  When each real push, edge, and sync adapter delivers an addressed message, name, member, tombstone, and structured verdict authenticated as registration A
  Then each reaches its typed path after the origin check
  And an unaddressed message wakes no agent and a verdict from a different full owner MXID is refused
  And a room name or matching sender suffix changes neither owner nor side registration

Scenario: The first representative invite needs no group enrollment
  Test:
    Filter: side_provenance_first_invite_preserves_registered_side_intake
    Level: integration
    Test Double: fake Matrix join endpoint and isolated room-trust state
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given an active registration and a room without a group mapping whose bootstrap proof satisfies the operator-selected model
  When each real push, edge, and sync adapter delivers an authenticated invite with state_key equal to that registration's exact discovered representative MXID
  Then the origin check admits it to the existing invite and room-trust path
  And the provenance check creates no owner or engagement
  And an invite naming another representative fails that bootstrap proof before the invite path

Scenario: Backfill and replacement rooms retain checked context
  Tags: critical
  Test:
    Filter: side_provenance_backfill_and_replacement_rooms_require_checked_context
    Level: integration
    Test Double: fake backfill response and replacement-room join/mapping counters
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given registration A with an admitted room and sufficient authoritative evidence that a replacement room does not belong to A
  When each real push, edge, and sync adapter delivers events that trigger backfill and a tombstone replacement follow-up
  Then backfill retains registration A, side A, and the originating mode and validates each event room
  And the mismatched replacement triggers no join or mapping and acquires no registration A provenance

### Rule: rejection-and-replay — Rejection cannot become a successful claim

Scenario: Definitive rejection permits valid events in the batch
  Tags: critical
  Test:
    Filter: side_provenance_mixed_batch_rejects_invalid_events_without_success_claims
    Level: integration
    Test Double: real router, isolated bridge, completed-event and rejection-log recorders
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given one definitively mismatched event between two valid events in an authenticated transaction
  When each real push, edge, and sync adapter delivers the batch and the two valid events complete
  Then HTTP 200 acknowledges the batch and only the two valid events have business success claims
  And the rejected event produces a named log and no downstream action
  And a later valid delivery of that event identity is evaluated without a rejection-created dedup hit

Scenario: Transient downstream failure retains the event for retry
  Tags: critical
  Test:
    Filter: side_provenance_failed_delivery_keeps_claim_and_cursor_retryable
    Level: integration
    Test Double: fake transport endpoints, one failing downstream action, transaction/ack/cursor recorders
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given an admitted event whose downstream action fails before completion
  When each real push, edge, and sync adapter delivers and retries it with the same checked source
  Then the first attempt returns HTTP 500 without a completed claim, transaction completion, edge success ack, or cursor advance
  And the next attempt reaches its typed path and can complete

Scenario: One unavailable relation keeps the whole mixed batch retryable
  Tags: critical
  Test:
    Filter: side_provenance_mixed_batch_relation_failure_prevents_ack_and_cursor
    Level: integration
    Test Double: fake transport endpoints, per-room relation read failure then recovery, completed-event and transaction/ack/cursor recorders
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given a batch containing a valid completed event, a terminal room_side_mismatch, and an event whose relation read is unavailable
  When each real push, edge, and sync adapter delivers that batch through the real router and bridge
  Then the batch returns HTTP 500 and never HTTP 200, with no transaction completion, edge success ack, or sync cursor advance
  And the completed event alone keeps its business success claim while the unavailable event has zero typed actions and no completed claim
  When the unavailable relation recovers and the whole batch is replayed
  Then the completed event takes no additional action, the mismatch remains a terminal rejection, and the previously unavailable event completes once
  And only after that replay finishes may the batch complete, edge acknowledge success, or sync advance its cursor

Scenario: Two intake modes execute one logical event once
  Tags: critical
  Test:
    Filter: side_provenance_cross_mode_duplicates_share_one_event_claim
    Level: integration
    Test Double: controlled promises, isolated runtime, three typed-path action counters
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given the same registration, roomId, and event_id in actual adapter fixtures with different modes and transaction IDs
  When each push-edge, push-sync, and edge-sync pair delivers concurrently through the real router and bridge, then the second mode repeats after completion
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
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given an event completed with valid side A provenance
  When each real push, edge, and sync adapter delivers another receipt with the same event_id but mismatched registration/room provenance
  Then the origin check rejects it before a business-event dedup success is returned
  And no completed claim changes and no downstream action runs

Scenario: Stripped invites replay only the same complete invitation fact
  Test:
    Filter: side_provenance_idless_invites_do_not_share_a_global_claim
    Level: integration
    Test Double: fake Matrix join endpoint and two isolated room-state fixtures
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given valid idless member invites for two opaque room IDs on one registration with complete sender, state_key, membership, and authorization-relevant stripped content
  When each real push, edge, and sync adapter delivers both and each cross-mode pair repeats the first with identical tuple values and reordered content keys
  Then both rooms reach the existing invitation path
  And the repeat creates no additional owner, group, or trust transition
  And no undefined event ID suppresses the other room's invitation
  And only key order changes in otherwise identical stripped content preserve the same claim

Scenario: Different full inviters do not share an idless invite claim
  Tags: critical
  Test:
    Filter: side_provenance_idless_different_inviters_reenter_owner_checks
    Level: integration
    Test Double: fake transport endpoints, isolated exact room-agent owner bindings, invitation and owner-decision recorders
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given two valid idless invites with identical registration, opaque roomId, full state_key, membership, and authorization-relevant stripped content but different complete sender MXIDs
  When each real push, edge, and sync adapter delivers both through the real router and bridge, including cross-mode delivery pairs
  Then the invitations have independent claims and both reach the existing exact room-agent owner decision
  And the second inviter is not treated as the first inviter's replay or granted the first inviter's owner binding
  And existing owner ambiguity or transfer rules may refuse the second invitation without silently replacing ownership
  When each invitation is replayed with its own identical full sender and tuple through another real adapter
  Then neither replay adds an owner, group, trust, or approval transition

Scenario: Invite target and authorization content remain part of idless identity
  Tags: critical
  Test:
    Filter: side_provenance_idless_target_and_authorization_content_do_not_collapse
    Level: integration
    Test Double: fake transport endpoints, admitted managed invite targets, canonical stripped-content fixtures, owner-decision recorder
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given admitted idless invite facts with the same registration, opaque roomId, full sender, and membership
  When each real push, edge, and sync adapter delivers variants changing only the full admitted state_key or an authorization-relevant stripped-content value consumed by the invite decision
  Then each changed fact has an independent claim and reaches the existing owner decision rather than returning an earlier dedup success
  And successful handling still depends on that fact's existing target and owner checks

Scenario: Rejection logs exclude private payloads
  Tags: critical
  Test:
    Filter: side_provenance_rejection_logs_omit_tokens_and_approval_payloads
    Level: integration
    Test Double: sentinel private fields and captured operator logs
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given a rejected fixture containing sentinel credentials and private approval fields
  When each real push, edge, and sync adapter delivers it and ingress logs the rejection
  Then the log contains reason, non-secret registration identity, sideId, mode, roomId, and available event or transaction ID
  And no sentinel credential, event body, approval payload, input digest, or private command appears

## Out of Scope

- Same-server multiple independent fleets are unsupported by the current ProjectSide schema: side ID equals serverName with one credential and representative. Their support is outside this spec-only revision, pending operator choice A/B. A requires a separate architectural revision and corresponding integration scenarios; B retains this known deployment limitation and must state it in multi-fleet documentation. This draft does not claim to close F06 for same-server multiple fleets.
- Federated or cross-server rooms and reuse of a remote-origin room through another side; this contract does not define their reachability evidence.
- E2EE transport, crypto stores, key recovery, or approval-room encryption policy. Existing decrypted bot SDK behavior is not expanded.
- Robrix2 UI/computer-use testing and live E2E acceptance.
- Outbound fleet roster/masquerade, sync projection/gap recovery, registration or token rotation, join-error policy, budgets, and remote launchers.
- New per-room enrollment APIs, project-side schema migration in this dispatch, owner transfer, F03/F04 group/binding repairs, or indefinite/global exactly-once delivery. Selecting A requires reopening the schema and proof boundaries rather than treating them as permanently excluded.
- Implementing tests or production code in dispatches 16/16-r1. Test/lifecycle behavior remains unverified until implementation supplies and executes the named tests; parse/lint success is spec validation only and does not resolve the operator's identity decision.
