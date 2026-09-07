---
kind: requirement
id: REQ-BOTLESS-GROUP-MEMBERSHIP
title: "Synchronize group membership through the room's Matrix credential"
status: Accepted
liveness: auto
tags: [matrix, appservice, membership]
---

## Problem

The authorized local Palpo E2E exposed group membership synchronization calling
a null bot client and sending invites and kicks to the default homeserver with
an absent bot token. HTTP refusals were logged as successful invitations, and
removing an appservice agent targeted a human-shaped MXID.

## Requirements

[REQ-BGM-SIDE] Group membership changes MUST select one unambiguous mapped room
and its own acting credential. Missing side credentials or unknown membership
MUST stop the change without using a different side or default bot credential.

[REQ-BGM-IDENTITY] Appservice agents MUST be invited and joined through the
room's side with namespace and fleet roster validation; removals MUST target
the same complete agent MXID. Complete human MXIDs MUST remain unchanged, and
an unresolved bare human name on a foreign side MUST be refused.

[REQ-BGM-RESULT] HTTP refusals for invite, join, and kick MUST produce a failure
result and warning, without a success claim for the refused operation. Existing
same-server bot and per-agent token membership changes MUST remain supported.

## Acceptance Basis

The operator authorized fixing the botless E2E bugs and continuing local E2E.
This requirement applies ADR-016's existing same-side reachability decision;
it grants no new Matrix trust, ownership, or runner authority.
