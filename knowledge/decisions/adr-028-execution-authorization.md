---
kind: decision
id: ADR-028
title: "Contributor-controlled YOLO and backend-owned scoped grants"
status: Accepted
tags: [runtime, approval, security]
---

Default Codex execution remains workspace-write/on-request, or read-only without
a workspace lease. A contributor may explicitly set YOLO on a Codex resource as
a default for future Agents, or on an existing Agent. Only a writable leased
dispatch may use danger-full-access/never. Read-only coordination dispatches keep
their lease-imposed confinement. This is the operator-authorized exception to
ADR-003/ADR-005's mandatory interactive execution approval; default policy and
control-plane authentication are unchanged.

Task and persistent grants belong to Hagency's approval store, written atomically
with the authenticated owner verdict. They bind Agent incarnation, project,
owner/binding generation, runtime environment, workspace, and an explicit scope.
Task grants additionally bind the canonical task and stop matching at completion.
Network scopes require Codex's structured network approval context; never infer
a domain from prose or shell text. Command scopes match the exact command and
execution context; no home-grown shell prefix parser. Explicit permission
profiles must be well formed; unknown scopes and file-change callbacks without
enough detail retain once/deny only.

Scope metadata comes from the host-owned runner, not agent-supplied HTTP fields.
Every native request still passes fenced park/resume and server authorization.
Matching grants are applied as per-request native decisions rather than writing
untracked Codex policy files or granting a broad native session cache. This keeps
revocation effective for subsequent requests and avoids grants leaking into the
next task. Revocation cannot undo an already authorized operation or remove a
permission already held by the current native turn; UI must state that boundary.
Owner changes/removal/deactivation invalidate saved grants; re-adding an owner
does not resurrect them. No public room receives scope details or controls.

Verified reference: Codex 0.153.4 generated app-server JSON schema and
https://learn.chatgpt.com/docs/app-server#approvals (2026-09-08). The installed
schema differs from the documentation in optional experimental fields, so
unsupported or unfamiliar data must not widen a grant.

## September 9 review closure

The console receives an explicit grant management projection, excluding private
approval-room IDs, source event/request IDs, and internal workspace fields. Keep
the human-readable exact permission description so operators can understand and
revoke the actual rule. Public Agent summaries omit execution policy; authenticated
policy endpoints remain authoritative. Created canonical tasks count as live;
unknown statuses never authorize a task grant.

Rollback snapshots copy maps and the mutable request/grant records rather than
deep-cloning historical payloads. Terminal request receipts are retained through
seven days after expiry and pruned on subsequent creation. A pruned request cannot
be replayed as an authorization. Independent persistent grants retain their full
binding/incarnation authority and continue to be explicitly revocable.
