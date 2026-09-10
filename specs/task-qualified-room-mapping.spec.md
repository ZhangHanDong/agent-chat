spec: task
name: "Preserve qualified room mappings through credential projection"
inherits: project
satisfies: [ADR-016]
tags: [active, matrix, room-mapping]
---

## Intent

Use the registered project-side identity when mapping newly named or renamed
rooms, matching the existing startup migration. Reject same-side duplicate
names without changing either room's previous route.

## Constraints

### Must
- Exercise the actual acting credential projection and side lookup in deterministic Vitest tests.
- Preserve both mapping directions and report a conflict when a target group belongs to another room.
- Keep room trust, side provenance, and room-agent ownership gates unchanged.

### Must Not
- Do not contact live Matrix, backend, or agent services in tests.
- Do not derive authorization from the room name or display name.

## Decisions

- The side ID emitted by actingSideFor is the canonical credential-map key. Existing room-name and tryMapRoom consumers use this ID, and bindRoom supplies it too.
- Same-name rooms on different registered sides remain independently mapped; own-server rooms retain bare keys.
- mapRoom validates target ownership before deleting a renamed room's previous reverse route.
- Historical mixed-case qualified keys remain usable through canonical side lookup, retaining their stored spelling and refusing duplicate same-side names.
- Case-equivalent aliases for different rooms are ambiguous: mapping returns false and lookup returns null with diagnostics. Equivalent aliases for one room remain usable. Group names stay case-sensitive; the own-server comparison ignores server-name case.
- Successful rename and unmap remove equivalent aliases for that room's previous group and side, preserving aliases owned by other rooms or sides. A refused rename removes none.

## Boundaries

### Allowed Changes
- bridge-matrix.js
- tests/bridge-qualified-room-mapping.test.js
- specs/task-qualified-room-mapping.spec.md
- knowledge/observations/qualified-room-mapping.md
- docs/agent-knowledge.md
- docs/progress.md

### Forbidden
- Do not edit backend APIs, Matrix intake authentication, owner binding rules, runtime settings, or dependency manifests.

## Acceptance Criteria

Scenario: A fresh same-side name cannot bypass a migrated route
  Test: refuses a fresh same-side name after startup migration using real credential helpers
  Given a persisted bare route on a foreign registered appservice side
  When startup migration runs and a new trusted room receives that same name
  Then the original qualified route stays unchanged and the new room has no mapping
  And a side-qualified conflict is recorded without membership or binding reconciliation

Scenario: A conflicting rename preserves both prior routes
  Test: refused rename preserves both mapping directions and skips reconciliation
  Given two mapped rooms with different names on one registered side
  When the second room is renamed to the first room's name
  Then both map directions remain identical to the pre-rename state
  And a conflict is recorded without membership or binding reconciliation

Scenario: Room discovery refuses an occupied qualified key
  Test: tryMapRoom refuses a migrated same-side collision
  Given a migrated route and a new room with the same name and readable membership
  When tryMapRoom probes the new room using real credential helpers
  Then it returns null and preserves the migrated route with one conflict

Scenario: Explicit room binding refuses an occupied qualified key
  Test: bindRoom refuses a same-side collision and preserves the old route
  Given two mapped rooms on one registered side
  When bindRoom requests the occupied name for the second room
  Then both mapping directions remain unchanged with one conflict

Scenario: Distinct sides keep independent mappings
  Test: real credential helpers keep same-name rooms on different sides independent
  Given two registered sides with the same room name
  When the second room receives its name event
  Then each side-qualified key identifies its own room and no conflict is recorded

Scenario: Home-server mapping retains its bare key
  Test: home-server names remain bare even with a registered acting credential
  Given an own-server room and a registered credential for that server
  When the room receives a name event
  Then sideForRoom returns null and the mapping stays bare

Scenario: The direct primitive refuses before changing either map
  Test: mapRoom collision is atomic for an already mapped room
  Given two qualified routes on the same side
  When mapRoom attempts to rename one to the other's key
  Then it returns false and both map directions remain unchanged

Scenario: Historical mixed-case keys cannot bypass canonical side collision checks
  Test: mixed-case persisted room keys cannot be bypassed by canonical side IDs
  Given either a bare or already qualified persisted mapping whose room server contains uppercase letters
  When migration runs and a different lowercase-server room receives the same name through real credential helpers
  Then the existing mapping spelling is preserved and one same-side conflict is recorded
  And canonical roomForGroup lookup returns the original room
  And a repeated original-room name event preserves the same mapping

Scenario: Conflicting case-equivalent aliases fail closed
  Test: conflicting case-equivalent side aliases reject mapping and lookup
  Given two case-equivalent qualified keys that identify different rooms
  When lookup or mapping requests either side spelling
  Then lookup returns null and mapping returns false with ambiguity diagnostics
  And both mapping directions are unchanged

Scenario: Equivalent aliases retain one room without confusing group-name case
  Test: same-room side aliases stay usable while group names remain case-sensitive
  Given two side-case aliases for one room and a differently cased group name
  When lookup and mapping use the canonical side ID
  Then the aliases retain their existing keys and identify the same room
  And the differently cased group name maps independently

Scenario: Mixed-case own-server configuration keeps bare collision refusal
  Test: mixed-case home-server configuration retains bare collision protection
  Given MATRIX_SERVER_NAME uses uppercase and an own-server bare route exists
  When another own-server room receives that name
  Then sideForRoom returns null and the conflicting bare mapping is refused

Scenario: Successful rename removes the previous room aliases
  Test: successful rename removes only the prior same-room side aliases
  Given two case-equivalent side aliases for a room and routes belonging to other rooms and sides
  When that room is renamed to an unoccupied group
  Then the old aliases no longer resolve and the new group identifies the room
  And unrelated routes remain unchanged

Scenario: Unmap removes the previous room aliases
  Test: unmap removes same-room aliases without deleting another room or side
  Given case-equivalent aliases for the departing room plus unrelated routes
  When unmapRoom removes the room
  Then the old aliases for that room no longer resolve
  And another room sharing the canonical group-side identity remains mapped

Scenario: Dotless sides and at-sign group names clean up exactly
  Test: unmap removes case-equivalent aliases on a dotless side with an at-sign group name
  Test: rename removes case-equivalent aliases on a dotless side
  Given a room on a dotless registered side has case-equivalent qualified aliases
  When the room is renamed or unmapped
  Then all aliases for its exact group and side are removed
  And group names containing an at-sign retain their full name

Scenario: Dotless qualified mappings survive restart unchanged
  Test: reload preserves a dotless qualified side when the group name contains an at-sign
  Given a qualified mapping for a dotless side and a group name containing an at-sign
  When the bridge reloads its persisted mapping state
  Then startup migration does not append the side a second time
  And both mapping directions retain the original group name and room

## Out of Scope

- Live service restarts, deployment, or Matrix room changes.
- Replacing the mapping-key encoding or redesigning backend group identity.
- Command reply text, registration-token intake, or unknown-side migration recovery.
