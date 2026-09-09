---
kind: requirement
id: REQ-DASHBOARD-RUNNER-PROJECTION
title: "Distinguish persistent agent availability from disposable runner activity"
status: Accepted
liveness: auto
tags: [dashboard, runner, regression]
---

## Requirements

[REQ-DASHBOARD-RUNNER-PROJECTION] A local persistent Claude/Codex agent served by ADR-011 must expose an explicit allowlisted on-demand runner projection. Runner availability is configuration and routing readiness, not process liveness. Active dispatch counts derive from the full durable ledger; completed, cancelled and outcome_unknown historical dispatches do not constitute active processes or block the agent globally. Query errors and unknown states fail closed.

Explicit legacy tmux/ACP transport, configured panes, unsupported frameworks, remote agents and missing stable identities must not be upgraded to ready by inference. Manual stops, missing workspace or credential and unrelated offline reasons must remain unavailable. Tmux sweeps must not invent missing panes or ghost alerts for an on-demand runner. Existing POST /api/messages warning eligibility remains unchanged; its routing eligibility also includes agents with a legacy transport declaration.

Declared runtime-profile models may be displayed as configuration; absent models remain null with provider-default provenance. No global model configuration is read. Metering may use an on-demand agent's managed workdir as a transcript search key without claiming a live or historically observed workspace. Missing transcripts remain unavailable.

## Source Trace

- Operator-authorized 2026-09-06 local Dashboard E2E repair; completed e2e-codex runner displayed tmux-missing:auto.
- ADR-011 and REQ-THREAD-SCOPED-SESSIONS.
