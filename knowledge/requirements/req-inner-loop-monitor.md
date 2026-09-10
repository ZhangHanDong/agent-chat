---
kind: requirement
id: REQ-INNER-LOOP-MONITOR
title: "Middle agents own inner execution and independent verification"
status: Accepted
liveness: auto
tags: [agents, herdr, verification]
---

## Problem

An Hagency-managed agent delegated implementation through Herdr and octoloop,
but its ad hoc watcher missed an ACK replaced in place and a different terminal
completion label. A fresh-nonce recheck succeeded. Future delegated work needs
a reusable, bounded workflow with evidence stronger than terminal text.

## Requirements

[REQ-INNER-LOOP-MONITOR] The Hagency-managed middle agent MUST retain task
decomposition, backend choice, verification and task reporting. It MAY use
Herdr and octoloop to run a lower execution agent. This does not change which
frameworks the Hagency thread-session runner itself supports.

The workflow MUST prepare a fresh job id and nonce before dispatch, bind the
result to an explicit session and observed agent identity, validate result
content and repository state, and run a verification command chosen by the
middle agent before dispatch. It MUST report verified work separately from
runtime status and never use translated labels, line counts or an inner
agent's claimed tests as proof of success.

The monitor MUST bound waits and child commands, retain failure evidence,
and reject stale results, changed identities, changed repository content,
failed verification and explicit blocked or failed results. It MUST NOT
execute commands supplied by an inner result or mutate Hagency task state.

## Scenarios

Scenario: Fresh work is independently verified
  Given a prepared job and matching completed result
  When the declared verifier passes with unchanged repository and identity
  Then the monitor reports verified work and the separately observed runtime status

Scenario: Stale or concurrently modified work fails verification
  Given an old nonce, changed repository, or replaced execution agent
  When the monitor checks the job
  Then it reports failure without claiming completion

## Dependencies

- ADR-011: backend-owned runner lifecycle remains authoritative.

## Source Trace

- Operator-approved 2026-09-06 Hagency, Herdr and octoloop execution architecture.
- Local E2E initial monitor failure and autonomous fresh-nonce recheck.

## Open Questions

None.
