spec: task
name: "Authenticated project-side provenance at Matrix ingress"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE, REQ-OWNER-UI-APPROVAL, ADR-002, ADR-014, ADR-016]
tags: [matrix, appservice, provenance]
---

## Intent

Carry the authenticated project side and intake mode from push, edge, and
appservice sync to one Matrix ingress boundary before any room action or
approval parsing. Close review F06: preserving the complete event sender is
insufficient when the side that supplied the event has been discarded.
The operator selected model C: independent HAFleet instances share one Palpo,
each with its own registration, representative, agent prefix, and runtime.
Dispatches 16, 16-r1, and 16-r2 change only this spec; the named tests remain
planned for a subsequent implementation dispatch. Parse/lint success validates
the contract structure, not implementation or live Palpo behavior.

## Constraints

### Must

- Attach provenance containing the authenticated `registration`, canonical `sideId`, and `mode` from the closed set `push`, `edge`, `sync` to each appservice event. Registration is the non-secret identity of the authoritative credential record uniquely selected by hs_token within this HAFleet instance. Registration identity is derived as `<sideId>@<first 8 hex of sha256(hsToken)>`, so rotating the credential rotates the identity and a restart with the same token derives the same id. The existing sideId identifies its one registration on that server locally; it is not a global fleet ID or a token value. Construct provenance from the authenticated router entry and bridge-owned adapter, outside the event body. Preserve it through callbacks, retries, and backfill until the shared ingress boundary; bind backfill to that registration's credential and exact room.
- Validate provenance and room ownership before routing ordinary `m.room.message`, executing room state actions, parsing a structured approval verdict, or claiming a business-event deduplication key. Apply this order in both `MATRIX_TRUST_MODE=audit` and `enforce`, including bot-less operation.
- Resolve the side against the last successfully loaded authoritative project-side registry and its active inbound credential registration. Recheck that snapshot at ingress; a side removed by a successful refresh is absent even when its event was authenticated before the refresh.
- Require authoritative evidence that the selected registration's representative, recorded as a complete MXID through `/whoami`, has membership `join` in the exact opaque room ID. The only first-invite exception is an authenticated `m.room.member` event with membership `invite` and full state_key equal to that representative MXID. Matching server names, agent prefixes, project records, or another registration's representative do not establish this relation. Reject invalid room IDs, absent registrations, and definitively absent relations with named reasons; unavailable evidence remains retryable.
- Keep existing room-trust, mention, command ACL, and exact room-agent owner checks after provenance validation. A valid side relation establishes origin; it does not create an owner or approve an engagement.
- Distinguish definitive rejection from an unavailable registry, unavailable room-relation evidence, or missing internal provenance. Rejected events perform zero message, room, membership, or approval mutations. A batch containing any retryable failure returns HTTP 500, never 200, with no transaction completion, edge success ack, or sync cursor advance; the existing bounded retry policy remains in charge.
- After validation, coalesce concurrent deliveries and suppress completed repeats of the same `(registration, roomId, event_id)` across intake modes and transaction IDs. Failed attempts remain retryable; mode is diagnostic context, not logical event identity. Different registration/room scopes do not share a claim.
- For stripped member invites without an event ID, use the complete tuple `(registration, opaque roomId, full event.sender inviter MXID, full state_key target MXID, membership, authorization-relevant stripped content)`. Preserve both MXIDs in full, including localpart case and server; never reduce them to localparts or a representative label. Serialize the tuple unambiguously and canonicalize object key order in stripped content. Include the complete invite content conservatively, plus any additional stripped state consumed by the authorization decision; different authorization inputs must not share a claim. Missing required invite identity follows existing invalid-event validation, never a shared missing-ID key.
- Replaying the same idless invitation fact across modes is idempotent; a different full inviter MXID is distinct evidence and must reach the existing room-agent owner decision again. A fresh claim does not grant or transfer ownership; retain ADR-002's exact binding, ambiguity rejection, and explicit audited transfer rule.
- Log reason, non-secret registration identity, side ID, mode, room ID, and event ID or transaction ID when available. Exclude credentials, full event bodies, approval payloads, input digests, and private command details.
- Use deterministic Vitest fixtures with an isolated `HAFLEET_RUNTIME_DIR` set before bridge import, a disk-backed `TMPDIR` outside `/tmp`, disabled core dumps, and serial workers. Drive actual push, edge, and sync adapters through the real router and bridge ingress; observe typed downstream call counts and adapter transaction/ack/cursor outcomes. Predicate-only tests or direct ingress calls cannot substitute for these integration scenarios.
- Keep the two C instances' control planes, runtime directories, credentials, representative identities, agent namespaces, event claims, and sync cursors separate. Each instance retains one registration per server even though both local sideIds equal that server name. Use different Palpo registration IDs, as_token/hs_token pairs, complete representative MXIDs, non-overlapping agent prefixes/namespaces, and independently addressed push/edge delivery or sync credentials.

### Must Not

- Do not derive side ownership from a sender MXID suffix, localpart, display name, room name, API URL hostname, or a side claim in event content, query parameters, or HTTP headers. Incoming fields cannot replace authenticated provenance or select the intake mode.
- Do not classify an appservice event missing provenance as a bot SDK event, or use audit mode to continue after provenance rejection.
- Do not add a rejected event to successful business-event deduplication state, consume its approval, or suppress a later valid delivery with it.
- Do not grant persistent side/room ownership from incoming name, member, or tombstone content. The authenticated first-invite exception admits only the selected registration's exact `/whoami` representative to the existing invite path; it does not establish joined membership for other events. A replacement room requires its own relation check before any follow-up join, mapping, or replay there.
- Do not enable simultaneous production intakes for the same side to test deduplication; preserve the configuration mutex and drive adapters in fixtures.

## Decisions

- **Model C is selected.** The operator's 16-r2 decision keeps ADR-016 decision 1 unchanged: one homeserver, credential, and representative per side within each independent HAFleet instance. Multiple instances may register separately on the same Palpo. No ProjectSide schema migration or global fleet ID is needed for this deployment. The local sideId remains serverName, with instance-local storage providing the registration scope of claims, room evidence, and cursors. Complete A, where one HAFleet instance manages multiple registrations on one server, is future work requiring its own ADR/schema/API migration contract.
- **Provenance authority.** The router supplies the local registration uniquely selected by hs_token authentication and its side. The listener supplies push mode, the edge collector supplies edge mode, and the AS sync collector supplies sync mode. Edge/sync's configured registration must match the router's authenticated registration. An unknown token or one matching multiple local registrations returns HTTP 403 before dispatch; first-match selection is not authority. A different instance's same-valued sideId never substitutes for its credential or runtime context.
- **Room relation evidence.** Use the exact representative MXID recorded from `/whoami` for the selected registration, never a reconstructed localpart, namespace match, or another instance's representative. Joined membership must come from an authoritative Matrix member lookup or room-state snapshot bound to this registration's endpoint/credential and exact room. A complete result showing that representative joined proves the relation; an explicit non-join state or a complete joined-member list excluding it proves absence. Failed reads or incomplete coverage yield `room_relation_unavailable`; a read error alone does not prove absence. A usable prior authoritative snapshot may be evaluated, but a successful newer non-join result replaces the prior join evidence. Room server equality, an existing project record, and Palpo delivery alone are not proof. Preserve opaque room IDs and ports; the discovered API URL host may differ from the Matrix server name.
- **Bootstrap and existing rooms.** Before the representative has joined, only an authenticated `m.room.member` invite with full state_key exactly equal to that registration's `/whoami` representative qualifies for bootstrap, including stripped invites without event_id. No group/project enrollment is needed. This admits that invitation to existing trust, inviter/owner, and join checks; it creates no owner, engagement, or blanket room relation. Other messages, state, or verdicts wait for their own positive membership proof. Another registration's representative in the room or in state_key does not qualify. Existing project rooms and AS-delivered owner DMs use the same member proof; home-server operation does not skip it.
- **Palpo interest dependency.** Model C relies on Palpo retaining separate registration IDs and routing interest per registration, including namespace/member interest and the exact representative invite. HAFleet's actual push/edge adapters consume those separate deliveries; sync is separately authenticated as each registration's representative. Distinct registration IDs, token pairs, sender_localparts, namespaces, and delivery destinations must be configured explicitly; shared defaults are not instance separation. This is an external delivery dependency, not the local room proof: even a wrongly interested or misdelivered event arriving with the recipient's valid hs_token must fail the local member/bootstrap check when that recipient has no relation. A foreign token fails authentication first. Joined representatives of two registrations may independently prove a shared room; either representative alone proves only its own registration's relation. Normal trust, mention, owner, and approval checks still decide business actions there.
- **Ordering.** Authentication, provenance/room validation, shared event claim, then the existing typed path: ordinary text/commands; name/member/tombstone state; or structured approval verdicts in the already accepted protocol namespaces. Approval parsing and submission both occur after validation. Trusted bot SDK callbacks retain their authenticated client context; absent AS provenance never selects that path. Approval still checks complete sender, exact owner DM, agent, project room, request, digest, expiry, and pending state.
- **Terminal failures.** Bad credentials or ambiguous authenticated registration selection return HTTP 403 without event dispatch. At ingress, definitive registry absence yields `side_not_registered`, an invalid room ID yields `invalid_room_id`, and authoritative evidence that the selected representative is not joined, with no exact-target invite exception, yields `room_side_mismatch`. A registration with no recorded representative MXID yields terminal `side_incomplete_registration` with zero claims and zero typed actions, logging the sideId and missing representative field; `room_relation_unavailable` instead denotes failed or incomplete evidence reads. These are terminal per-event rejections: log and discard, then continue the batch. HTTP 200 is permitted only after every event has completed or been definitively rejected; rejected events are not business successes.
- **Retryable failures.** No usable registry snapshot yields `side_registry_unavailable`; missing, invalid, or inconsistent adapter provenance yields `invalid_transport_provenance`; failed member reads or snapshots without the coverage needed to decide exact representative membership yield `room_relation_unavailable`. Each returns HTTP 500 with zero typed actions or completed event claims for that receipt. Any such event makes the entire batch retryable: no transaction completion, edge success ack, or sync cursor advance even if other events completed or were definitively rejected. Downstream transient failures also keep the batch retryable. Already completed events keep their claims and coalesce on whole-batch replay; failed events must be evaluated again. A failed refresh does not delete a usable prior snapshot or convert unavailable evidence into a definitive mismatch.
- **Duplicate disposition.** Validate each receipt before a business-event dedup hit returns success. One in-flight claim owns a logical event; concurrent callers await its result, and only completion suppresses another execution. Apply this to ordinary messages, state, and verdicts while retaining backend single-use approval checks. Preserve bounded retention and restart replay; this contract does not promise indefinite or globally exactly-once delivery.
- **ADR and requirement mapping.** ADR-002 and ADR-014 decision 1 retain exact room-agent inviter/owner provenance independently of identity provisioning; the idless tuple preserves different inviters as different evidence, not an implicit owner transfer. ADR-014 decisions 4/5 retain credential/homeserver and `/whoami` identity discovery. ADR-016 decision 1 applies to each instance's local registry, so C satisfies it while multiple instances share a Palpo; decisions 2/3 retain non-federated side reachability and representative-first room entry. Its one-side-per-server rule is not a Palpo-wide ban on multiple fleets, and server equality is not room proof. REQ-CONTRIBUTION-CONSOLE-WHITELIST-KEY and REQ-CONTRIBUTION-CONSOLE-IDEMPOTENT bind authenticated room/event identity for ordinary requests. REQ-OWNER-UI-APPROVAL-IDENTITY and REQ-OWNER-UI-APPROVAL-BINDING retain complete sender and exact approval scope. These links cover ingress obligations, not completion of the entire REQs.
- **Test binding status [JS-only].** The Filter values below are exact planned Vitest titles in `tests/bridge-side-provenance.test.js`; none is claimed to exist or pass in dispatches 16/16-r1/16-r2. Each title must expand into push, edge, and sync integration cases using the actual listener/puller/sync adapter, real receiver/router, and real bridge ingress. Mock only transport endpoints, registry/member data reads, and typed downstream effects; provenance-failure cases may inject the named internal fault after authentication. Keep registration selection, relation validation, deduplication, and owner decisions real; spies may observe owner/approval checks but may not supply successful verdicts. Do not stub successful provenance validation or call only a predicate/ingress helper. Cross-mode titles exercise push-edge, push-sync, and edge-sync pairs while retaining the production mutex. The two-instance group initializes two independent module/process runtime contexts before imports; changing one shared process environment after import is not instance isolation. Fake Palpo interest, membership, and sync responses are external-contract fixtures, not verification of deployed Palpo. Create the titles verbatim and execute them directly with Vitest after implementation; skipped lifecycle results or zero selected tests prove no behavior.

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

- Dispatches 16/16-r1/16-r2 may create or edit only specs/task-side-provenance.spec.md; the implementation paths above describe a subsequent authorized dispatch under the selected C model.
- Do not edit backend ownership, group-key migration, outbound masquerade, credential rotation, sync projection/gap recovery, or retry-budget policy in this ingress task; dispatches 15 and 17 own those changes.
- Do not edit remote/, install dependencies, change project-side schemas, expose secrets in the protocol, or replace the authoritative side registry. Complete A requires a separate future ADR and schema/store/API migration task; it is not part of implementing C.
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
  Given a sender naming side A and rooms with invalid IDs or complete member results showing that registration A's exact representative is not joined
  When each real push, edge, and sync adapter delivers ordinary messages, name, non-bootstrap member events, tombstone, and structured verdict fixtures authenticated as registration A
  Then invalid_room_id or room_side_mismatch rejects each fixture before its typed path
  And approval parser and submission counts are zero and group, trust, membership, and owner state remain unchanged
  And audit and enforce produce identical provenance rejections

Scenario: Relation read failure is retryable and differs from proven mismatch
  Tags: critical
  Test:
    Filter: side_provenance_relation_unavailable_retries_before_three_typed_paths
    Level: integration
    Test Double: fake transport endpoints, missing whoami record, failed representative member reads, incomplete and complete snapshots, typed-path and ack/cursor counters
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given a valid authenticated registration with a missing whoami identity record or failed/incomplete exact representative member reads
  When each real push, edge, and sync adapter delivers ordinary messages, name, non-bootstrap member events, tombstone, and structured verdicts in audit and enforce mode
  Then the missing representative MXID case yields terminal side_incomplete_registration with zero claims and zero typed calls, logging the sideId and missing representative field
  And a batch containing only that terminal rejection may return HTTP 200
  And failed/incomplete member reads yield room_relation_unavailable and HTTP 500 with zero message, state, approval parser, and submission calls and no successful event claim
  And these retryable cases leave the transaction incomplete, send no edge success ack, and keep the sync cursor unchanged
  When the retryable member-read cases recover and the same batch is replayed through the same adapter
  Then recorded whoami identity and a complete result showing that exact representative joined admit its typed path once
  And a separate complete result showing that representative not joined yields terminal room_side_mismatch with zero typed calls and permits HTTP 200 when no other event needs retry

Scenario: Valid local rooms retain typed paths and owner checks
  Tags: critical
  Test:
    Filter: side_provenance_valid_rooms_preserve_message_state_and_owner_checks
    Level: integration
    Test Double: isolated bridge and approval store, action-order recorders
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given registration A is active, including on the home server, and its exact whoami representative is authoritatively joined to its project and owner DM rooms which pass existing trust checks
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
  Given an active registration with a recorded whoami representative not yet joined and a room without a group mapping
  When each real push, edge, and sync adapter delivers an authenticated invite with state_key equal to that registration's exact discovered representative MXID
  Then the origin check admits it to the existing invite and room-trust path
  And the provenance check creates no owner or engagement
  And an invite naming another representative fails bootstrap and yields room_side_mismatch when a complete member result confirms the selected representative is not joined

Scenario: Backfill and replacement rooms retain checked context
  Tags: critical
  Test:
    Filter: side_provenance_backfill_and_replacement_rooms_require_checked_context
    Level: integration
    Test Double: fake backfill response and replacement-room join/mapping counters
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given registration A with its exact representative joined to the admitted room and a complete member result showing that representative absent from a replacement room
  When each real push, edge, and sync adapter delivers events that trigger backfill and a tombstone replacement follow-up
  Then backfill retains registration A, side A, and the originating mode and validates each event room
  And the mismatched replacement triggers no join or mapping and acquires no registration A provenance

### Rule: independent-instances — Two registrations share Palpo without sharing instance authority

Scenario: Two instances on one Palpo receive only their own interested rooms
  Tags: critical
  Test:
    Filter: side_provenance_two_instances_share_palpo_across_three_adapters
    Level: integration
    Test Double: two independently initialized runtime contexts, one fake Palpo with separate registration interest and member responses, separate edge queues, typed-path and state recorders
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given instances A and B have separate control planes and runtime directories, the same sideId palpo.test, different registration IDs and token pairs, representatives @hafleet_a:palpo.test and @hafleet_b:palpo.test recorded by whoami, and disjoint ac_a_ and ac_b_ agent namespaces
  And each instance's project and owner DM rooms contain only its own representative and have valid trust, mention, and owner fixtures
  When each real push, edge, and sync adapter in both instances consumes its registration's interest deliveries or representative sync response from the fake Palpo
  Then each addressed message, name, member, tombstone, and valid structured verdict reaches only its intended instance's typed path after its member check
  And A's events cause zero message, state, approval parser, or submission calls in B, and B's events cause zero such calls in A
  And claims, group and owner state, transaction completion, edge acknowledgments, and sync cursors stay in the corresponding instance's runtime

Scenario: A foreign registration token cannot select the local instance by server name
  Tags: critical
  Test:
    Filter: side_provenance_two_instances_foreign_token_rejected_before_ingress
    Level: integration
    Test Double: two isolated runtimes, fake push/edge/sync transports with a foreign hs_token supplied at the actual adapter transaction boundary, bridge dispatch counters
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given independent A and B registrations on palpo.test with distinct hs_tokens and identically valued local sideIds
  When each real push, edge, and sync adapter for B submits a transaction using A's hs_token to B's real router, and the reverse case is exercised for A
  Then HTTP 403 is returned before bridge ingress and all typed-path counts remain zero
  And matching serverName or sideId does not select the other instance's registration or state

Scenario: Misdelivered room events fail even with a valid recipient registration token
  Tags: critical
  Test:
    Filter: side_provenance_two_instances_foreign_room_rejected_with_local_token
    Level: integration
    Test Double: two isolated runtimes, fake Palpo interest and sync misdelivery, authoritative exact member responses, message/state/approval and success-claim recorders
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given only A's representative is joined to A's project and owner DM rooms on palpo.test and a complete authoritative result shows B's representative is absent
  When each real push, edge, and sync adapter delivers A-room message, name, non-bootstrap member, tombstone, and structured verdict fixtures to B's router with B's valid hs_token in audit and enforce mode
  Then B returns terminal room_side_mismatch before message/state actions, approval parsing, or submission, and creates no successful business claim
  And a sender or agent prefix matching B, the shared room server name, and delivery attributed to Palpo do not supply missing representative membership
  And the reverse A-recipient/B-room cases have the same refusal and a batch of only these terminal rejections may return HTTP 200

Scenario: Another representative in a locally named room does not prove the local relation
  Tags: critical
  Test:
    Filter: side_provenance_two_instances_foreign_representative_cannot_prove_membership_or_bootstrap
    Level: integration
    Test Double: two isolated runtimes, fake whoami/member and stripped-invite responses, existing local project record, invitation and typed-path recorders
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given A has a project record for a palpo.test room but complete member evidence shows only B's full representative MXID joined and A's whoami representative absent
  When each real push, edge, and sync adapter for A receives messages, state, verdicts, and an idless invite targeting B's representative, authenticated with A's hs_token
  Then B's membership and the local project record do not prove A's relation and B's state_key does not qualify for A's bootstrap exception
  And room_side_mismatch precedes every typed action, approval parse/submission, invite join, and completed claim
  When the same real adapters instead deliver a valid invite whose full state_key equals A's exact whoami representative
  Then only that invitation enters A's existing trust and inviter/owner path without granting other events a room relation

Scenario: A shared room requires each instance to prove its own representative membership
  Tags: critical
  Test:
    Filter: side_provenance_two_instances_shared_room_checks_each_own_membership
    Level: integration
    Test Double: two isolated runtimes, fake Palpo shared-room interest and member snapshots, independent event-claim and typed-path recorders
    Targets: lib/appservice-listener.js, lib/appservice-puller.js, lib/appservice-sync.js, lib/appservice-receiver.js, bridge-matrix.js
  Given both registrations' exact whoami representatives are authoritatively joined to one palpo.test room and each instance has an addressed, trusted message fixture
  When each real push, edge, and sync adapter delivers the same room event_id to both instances under their respective valid tokens
  Then both prove their own relation and perform only their locally admitted action, with independent completed claims despite equal sideId, roomId, and event_id values
  When a newer complete snapshot shows A's representative left while B's remains joined and the adapters deliver a new room message
  Then B may continue after its existing checks and A returns room_side_mismatch before its message action
  And B's presence does not preserve A's old membership evidence

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
  Given valid idless member invites for two opaque room IDs on one registration with complete sender, state_key, membership, and authorization-relevant stripped content, each passing exact representative membership or bootstrap
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
  Given two valid idless agent invites in a room where the registration's representative is joined, with identical registration, opaque roomId, full state_key, membership, and authorization-relevant stripped content but different complete sender MXIDs
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
  Given admitted idless agent invite facts in a room where the registration's representative is joined, with the same registration, opaque roomId, full sender, and membership
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

- Complete A: multiple registrations for one server inside a single HAFleet instance, a shared multi-fleet control plane or state directory, and the associated global registration ID/schema migration. C, with separate instances and registrations on the same Palpo, is in scope; it preserves one-side-per-server per instance.
- Federated or cross-server rooms and reuse of a remote-origin room through another side; this contract does not define their reachability evidence.
- E2EE transport, crypto stores, key recovery, or approval-room encryption policy. Existing decrypted bot SDK behavior is not expanded.
- Robrix2 UI/computer-use testing and live E2E acceptance.
- Outbound fleet roster/masquerade, sync projection/gap recovery, registration or token rotation, join-error policy, budgets, and remote launchers.
- New per-room enrollment APIs, project-side schema migration, Palpo implementation changes, owner transfer, F03/F04 group/binding repairs, or indefinite/global exactly-once delivery. The Palpo interest dependency is exercised with contract fixtures here; live server conformance and deployment acceptance require separate verification.
- Implementing tests or production code in dispatches 16/16-r1/16-r2. Test/lifecycle behavior remains unverified until implementation supplies and executes the named tests; parse/lint success is spec validation only.
