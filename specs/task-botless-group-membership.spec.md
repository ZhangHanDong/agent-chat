spec: task
name: "Synchronize botless group membership on the room's side"
inherits: project
satisfies: [REQ-BGM-SIDE, REQ-BGM-IDENTITY, REQ-BGM-RESULT, ADR-016]
tags: [matrix, appservice, regression]
---

## Intent

Repair group member changes exposed by the local botless Palpo E2E. Use the
room's own credential and complete Matrix identities, and report refused
operations as failures.

## Constraints

### Must
- Refuse ambiguous room mappings, missing side credentials, and unreadable membership before mutations.
- Keep appservice agent joins behind namespace and fleet roster validation.
- Preserve complete human and agent MXIDs when inviting or removing members.
- Report HTTP invite, join, and kick failures without claiming the refused operation succeeded.

### Must Not
- Do not send a foreign room operation using the default bot credential.
- Do not contact live services from deterministic tests.

## Decisions

- Reuse representative membership, invite, and agent join helpers for project sides.
- Keep the existing bot and per-agent token path for same-server rooms, inviting before joining.
- [JS-only] Execute the real bridge handler and HTTP helpers against an in-process fake Matrix server.

## Boundaries

### Allowed Changes
- bridge-matrix.js
- tests/bridge-group-membership-sync.test.js
- specs/task-botless-group-membership.spec.md
- knowledge/requirements/req-botless-group-membership.md
- .agent-spec/runs/**

### Forbidden
- Do not change Matrix trust, owner provenance, runtime services, or backend protocols.

## Acceptance Criteria

Scenario: Botless additions and removals use their project side
  Test: botless group membership invites joins and kicks on its own side
  Given a mapped side room and a null bot client
  When an appservice agent and a human are added and another agent removed
  Then the side representative invites and kicks complete MXIDs
  And the registered agent joins only after the invitation

Scenario: A credential on another side cannot replace the room credential
  Test: group membership uses room side despite an agent token on another side
  Given an agent has a token on side A and the group room belongs to side B
  When the agent is added to the group
  Then side B invites and joins through its appservice and side A receives zero requests

Scenario: Same-server token agents retain working membership changes
  Test: group membership token path invites before joining and preserves discovered MXID
  Given a bot and an agent token on the room's home server
  When the agent is added then removed
  Then the bot invites and kicks the discovered complete MXID and the agent token joins after invitation

Scenario: Unknown or incomplete authority is refused
  Test: group membership refuses missing side authority before sending requests
  Given an unknown foreign side or an incomplete acting credential
  When a group membership change arrives
  Then zero HTTP requests are sent and the update rejects

Scenario: Ambiguous room mapping is refused
  Test: group membership refuses ambiguous group rooms before sending requests
  Given two sides map rooms with the same group name
  When an unqualified membership update arrives
  Then zero HTTP requests are sent and the update rejects

Scenario: Unreadable membership stops mutations
  Test: group membership refuses unreadable membership without mutations
  Given the Matrix membership endpoint answers HTTP 403
  When a group membership update arrives
  Then the update rejects and zero mutation requests are sent

Scenario: Refused writes are failures
  Test: group membership reports HTTP failures without success claims
  Given a Matrix invite, join, or kick endpoint answers HTTP 403
  When a group membership change invokes that endpoint
  Then its result reports failure and a warning identifies the operation
  And no success log claims the refused operation succeeded

Scenario: Unknown side human identities are refused
  Test: group membership refuses unknown bare human identities on a side
  Given a bare human name has no observed complete MXID on the room's side
  When the human is added
  Then no invitation is sent and the member result reports failure

Scenario: Appservice joins reject unregistered or out-of-namespace agents
  Test: group membership refuses agents without namespace and roster authorization
  Given an agent fails the appservice namespace or fleet roster check
  When the agent is added
  Then zero Matrix mutation requests are sent and the member result reports failure

Scenario: A stale roster refreshes from backend agent records
  Test: group membership recognizes newly registered runtime agents from backend lookup
  Given the local roster lacks a newly registered Claude or Codex agent
  When the backend agent endpoint returns its named agent record for a bare name or complete agent MXID
  Then the roster gains that agent and the side invites and joins its complete agent MXID

Scenario: Nonexistent full agent identities are refused
  Test: group membership refuses nonexistent full agent MXIDs without human substitution
  Given a complete agent MXID has no roster entry and the backend agent endpoint returns HTTP 404
  When a membership update adds or removes that identity
  Then the member result reports failure and zero Matrix mutations are sent

## Out of Scope

- Changing SSE payloads, automatic retry scheduling, or group persistence.
- Live Palpo and UI E2E execution, which the coordinating agent performs separately.
