---
kind: decision
id: ADR-021
title: "Sandboxed runners report task lifecycle through scoped MCP tools"
status: Accepted
tags: [runtime, tasks, approvals, security]
---

## Context

The live Codex runner requested owner approval for shell invocations of
`./task-writer heartbeat` and `./task-writer done`: those commands need HTTP
access to the control plane from a network-disabled sandbox. The provisioned
home recommends the wrapper, while the dispatch prompt offered either transport.
The existing MCP heartbeat tool also used a legacy route forbidden to ephemeral
dispatches. Routine coordination therefore depended on a coding permission.

## Decision

Ephemeral runners use the managed stdio MCP task tools for lifecycle reporting.
`update_task_execution` reaches the dispatch-scoped endpoint for heartbeat and
waiting metadata; `transition_task` already reaches it for wait/resume/done.
Codex receives this transport rule through its supported developer instructions,
including the mapping from home-wrapper operations. The rebuilt task prompt
names the exact task and requires a confirmed explicit completion after checks.
The home entry files and the standalone CLI wrapper remain compatible and are
not rewritten to repair a running dispatch.

The real Codex probe also found that App Server's default MCP confirmation
policy asks before `get_task`. Its launch-only MCP configuration therefore
explicitly authorizes the six exact task tools (`list_tasks`, `get_task`,
`accept_task`, `transition_task`, `comment_task`, `update_task_execution`) using
the supported per-tool `approval_mode="approve"` setting. There is no server-wide
approval override and no trust-state mutation. The managed MCP server is required
at startup so a missing channel fails visibly. Actual emitted elicitations still
use the owner protocol; the adapter does not infer a verdict from message text.
The option is documented in the [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and verified separately against the locally installed runtime.

The MCP server performs authenticated HTTP outside the command sandbox. This
does not grant shell networking: the backend validates the agent token, dispatch,
runner, fence, lease and exact writable task on each request. It accepts only
heartbeat and waiting fields for execution updates, never status, identity or
arbitrary endpoint/command parameters. A parent cannot update its child's state.
Stale or incomplete authority fails closed. Missing tools or update failures
must be reported, without a shell-network workaround or invented completion.

Native command, file, permission and MCP elicitation requests retain the actual
owner flow. No shell spelling, wrapper path or command text is auto-approved.
The existing trusted task-tool classification does not extend to attachments,
other MCP servers, or arbitrary operations. Workspace-write/read-only policy and
networkAccess=false remain unchanged. This fixes routine lifecycle transport;
it does not implement broader per-engagement network or filesystem grants.

ADR-027 subsequently permits three exact workspace/current-conversation file
delivery and receive tools. The legacy general attachment endpoints remain excluded.

## Evidence

Bounded tests and the opt-in real-runtime probe are recorded in
`docs/reviews/2026-09-07-task-maintenance-approval.md`. Automated tests use local
fixtures only; live model evidence is recorded separately.
