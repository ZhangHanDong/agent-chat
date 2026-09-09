---
kind: requirement
id: REQ-MATRIX-MEMBERSHIP-OBSERVATION
title: "Keep Matrix membership observations distinct from membership commands"
status: Accepted
liveness: auto
tags: [matrix, membership, provenance]
---

## Problem

The authorized local Palpo E2E removed and restored e2e-claude. After the
restored Matrix join, the bridge consumed the delayed leave event, updated the
backend roster, and reflected that update through SSE as a second kick.
The immediate join snapshot passed while the eventual membership was wrong.

## Requirements

[REQ-MMO-ORIGIN] An authenticated Matrix membership observation MUST update
the backend roster and notify SSE consumers with its Matrix origin preserved.
The bridge MUST NOT execute that observation as a new Matrix membership command.
Ordinary API membership commands MUST retain their Matrix effects.

[REQ-MMO-CURRENT] On join, leave, or ban observations, the bridge MUST read the
current room membership through the room's authorized credential before updating
the roster. A delayed leave MUST NOT remove an agent who is currently joined,
and a delayed join MUST NOT restore an agent who is currently absent.

[REQ-MMO-UNKNOWN] Unreadable current membership MUST cause a retryable failure
without changing the roster or Matrix membership. Matrix-origin updates MUST
require configured bridge credentials; request text alone is not provenance.

## Acceptance Basis

The operator authorized repairing the confirmed Matrix-to-roster reflection
race after read-only diagnosis. The current Matrix leave event was sent by the
representative at 2026-09-06T03:38:05.217Z, after the restored join at
03:38:02.642Z and before e2e-codex joined at 03:53:19.997Z.
This applies ADR-016 and changes no Matrix trust or ownership authority.
