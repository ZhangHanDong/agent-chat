spec: task
name: "Shared approval room marker v2 migration"
status: draft
inherits: project
---

## Intent

Replace the single-agent approval-room marker scope with one room-owned v2 manifest so multiple agents and projects sharing the same owner room remain discoverable. Migrate v1 marker history without altering native bindings or approval requests, and retire v1 only after a v2 receipt.

## Decisions

- The canonical identity is `(approval_room_id, room_generation, marker_channel)` and never contains a synthetic approval request ID.
- `com.agentchat.approval.room.v2` uses state key `""`, one common owner/private publisher, and at most 64 canonical `(agent, project_room_id, active)` tuples sorted by code-point order.
- `syncBindingMarker` accepts a compatibility agent selector but derives the whole room manifest from canonical bindings; null agent-membership observations remain eligible.
- `migrateMarkerRoomsV2({limit})` examines at most `limit` retained v1 candidates, persists its cursor, seeds each room generation above all v1/v2 high-water marks, and rolls back cursor plus aggregate state on persistence failure.
- A successful v2 receipt queues `room_marker_v1_retirement` with fixed `{}` content. A v1 retirement receipt stops v1 publication; failed or delayed writes remain reconciliation work.
- Equal-generation identical content replays; equal-generation changed content conflicts. Older ready/begin/retry work is superseded while exact receipts for already-attempted I/O remain valid.

## Boundaries

### Allowed Changes
- lib/approval-store.js
- backend-v2.js
- tests/approval-binding-marker.test.js
- tests/api-approval-binding-markers.test.js
- tests/approval-shared-room-marker-v2.test.js
- specs/task-approval-binding-marker-store.spec.md
- specs/task-approval-projection-store.spec.md
- specs/task-approval-shared-room-marker-v2.spec.md

### Forbidden

- Native approval request or binding mutation during marker sync/migration, caller-authored association payloads, request projection namespaces, Matrix I/O, bridge scheduling, Robrix source, GUI code, global authentication, dependencies, live configuration, room creation, or per-agent state keys.

## Acceptance Criteria

Scenario: Four canonical bindings share one complete manifest
  Test: four bindings across three agents and two projects form one room manifest
  Given the accepted four-binding topology including null agent membership observations
  When any associated agent synchronizes the room marker
  Then one v2 row contains all four exact active tuples and both project-two agents resolve to the same room.

Scenario: Room ownership and publisher conflicts fail atomically
  Test: room manifest rejects mixed owner or private publisher without partial state
  Given bindings that disagree on canonical owner or verified private publisher
  When marker synchronization runs
  Then it returns conflict and changes no marker, binding, request, generation, or migration cursor bytes.

Scenario: Marker persistence failure preserves canonical governance records
  Test: marker synchronization rolls back its aggregate without rolling back canonical bindings
  Given canonical bindings were committed before marker synchronization
  When the marker aggregate fails before rename
  Then marker state rolls back while the already committed native bindings remain byte-for-byte unchanged.

Scenario: Room manifest bounds and tuple identity are exact
  Test: duplicate tuples and overflow reject while distinct agents in one project remain valid
  Given duplicate, distinct-agent, and over-64 tuple candidates
  When the full room manifest is normalized
  Then duplicate and overflow inputs fail without truncation while distinct agent/project tuples remain separate.

Scenario: V1 migration is bounded durable and monotonic
  Test: v1 scopes migrate above room high-water across batches restart mutation and rollback
  Given more retained v1 scopes than one migration batch and existing room generation history
  When bounded batches run across restart and a pre-rename persistence fault
  Then each batch examines at most its limit, resumes its exact cursor, preserves direct mutations, and assigns v2 generations above every room high-water mark.

Scenario: Post-rename migration recovery trusts the committed file
  Test: post-rename migration commit reloads durable cursor and aggregate before recovery
  Given marker migration commits its rename but directory synchronization reports failure
  When the degraded instance is rejected and the store reloads
  Then the committed cursor and v2 aggregate remain together and normal writes recover only after reload.

Scenario: V2 publication queues explicit V1 retirement
  Test: v2 receipt queues fixed retirement and preserves old attempted receipt semantics
  Given v1 and v2 rows for one room
  When v2 receives an exact receipt
  Then one retirement row carries fixed v1 type, empty key, and `{}` payload while old ready work cannot begin and exact old attempted receipts remain valid.

Scenario: Failed retirement remains explicit reconciliation work
  Test: failed v1 retirement remains pending reconciliation
  Given retirement has crossed the send boundary
  When transport outcome is unknown and retry is scheduled
  Then the retirement stays hidden until due and reappears as uncertain work.

Scenario: Supersession preserves only already-attempted legacy receipts
  Test: v2 supersedes old ready work but preserves exact attempted receipt
  Given one old v1 plan is ready and another has crossed the send boundary
  When v2 work supersedes both legacy generations
  Then the ready plan cannot begin while the exact attempted receipt remains admissible.

Scenario: Marker replay and pagination remain deterministic
  Test: equal replay stable cursor and due channels survive completion
  Given multiple mixed-case rooms with v2 and retirement work
  When identical sync repeats and a page anchor completes
  Then generation stays equal, the next opaque cursor uses one code-point order, and due result counts remain bounded.

## Out of Scope

Matrix state publication and reconciliation scheduling are B1.4. Robrix dual-read ships in its independently owned frontend unit. This draft does not authorize production implementation before B1.3 review and explicit coordinator release.
