---
kind: requirement
id: REQ-THREE-LAYER-COMPLETION
title: "Complete supervised inner work through the current HAFleet task"
status: Accepted
liveness: auto
tags: [tasks, sessions, mcp, orchestration]
---

## Problem

The macOS E2E completed real Herdr/octoscode work and returned a Matrix reply,
but its HAFleet task remained in_progress because the disposable runner could
not call task lifecycle tools. Temporary monitoring also missed an in-place ACK.

## Requirements

[REQ-THREE-LAYER-ROLES] Robrix2 and HAFleet own organization and authenticated room routing. HAFleet-managed agents decompose, arrange, monitor and verify work. Herdr and octoloop run the selected lower-level agent; their terminal state is not HAFleet task authority.

[REQ-THREE-LAYER-TASK-SCOPE] A started runner may read and mutate its active bound task only through its complete current capability. A coordinator may read tasks created from its own session. No capability, another session's task, stale capability, or a parked/unstarted runner must authorize task mutation.

[REQ-THREE-LAYER-COMPLETION] Task comments, heartbeat, blocked/resume and done transitions must use the existing durable task store and state machine. Model final text and dispatch completion must not mark a task done. Replaying an identical mutation call must not duplicate its effects; changed content under the same call id must fail.

[REQ-THREE-LAYER-MONITOR] The middle agent must verify a fresh inner result and independently run acceptance checks before explicitly completing the task; stale artifacts, failure, or timeout must not become success.

## Source Trace

- Operator request 2026-09-06: fix E2E findings and autonomously retest the three-layer Robrix2/HAFleet/managed-agent/Herdr-octoloop flow.
- docs/E2E-RUNBOOK-macos.md
- knowledge/requirements/req-thread-scoped-agent-sessions.md
