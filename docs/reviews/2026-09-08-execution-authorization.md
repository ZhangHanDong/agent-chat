# Explicit YOLO and scoped owner approvals

The contributor can select YOLO when creating a Codex resource, change the
resource default for future allocations, or set it for an existing Agent in its
Execution permissions section. Existing Agents remain sandboxed unless explicitly
changed. Settings take effect at the next runner start.

YOLO sets both native thread and turn policies to `never` / full access, only for
a dispatch with a writable workspace lease. Normal dispatches keep on-request
approval and their original sandbox. Unleased front-desk dispatches stay read-only.
This feature controls the backend-owned ephemeral Codex runner, not Claude or
legacy standalone CLI launchers.

Private Matrix cards offer once, task, always, and deny for supported precise
scopes. A structured native network callback grants the stated host/protocol;
otherwise a command grant covers the exact command, cwd and requested permissions.
Permission-profile grants cover the displayed native paths/network profile. No
domain or command prefix is inferred from prose. Unsupported scopes, file changes
without an exact supported scope, and MCP confirmation forms remain once/deny.

Grants persist in the approval store and bind the Agent incarnation, project,
owner binding generation, workspace, environment, and operation. Task grants also
bind a durable task execution epoch. SQLite migration 11 increments that epoch
when any transition completes a task; reopening the same canonical task cannot
revive an old task grant. Owner/binding changes and Agent recreation invalidate
old grants. Verdicts remain digest-bound, single-use and authenticated.

Hagency rechecks its own rules for every callback and sends an ordinary native
accept/turn grant, rather than writing Codex policy files or broadly accepting
the session. Revocation therefore affects subsequent requests; it cannot undo
completed operations or permissions already held in the current native turn.
Only contributor-authenticated configuration can enable YOLO or revoke rules.
Agent-supplied registration and approval metadata cannot create those privileges.

## Validation

- 154 tests passed across nine focused Hagency suites, including actual local
  fixture runners spanning multiple dispatches, API authority, resource-to-Agent
  inheritance, task reopening, revocation and existing attachment behavior.
- Robrix2: 35 approval/action tests passed; native executable built. The two
  scoped-card scenarios also passed native agent-spec lifecycle.
- Playwright: English and Chinese new-resource, resource-default, Agent-save /
  reload and rule-revocation flows passed. Built console deployed successfully.
- Syntax, ESLint, architecture ownership, router boundary/build reproducibility,
  spec bindings and diff whitespace checks passed. A preexisting test's missing
  `ReadableStream` import was made explicit for the ESLint check.
- Hagency agent-spec parse/lint passed, quality 1.0. Its native lifecycle reports
  boundary pass and five **skip** scenarios because it does not execute these
  Vitest bindings. This is not reported as a passing Hagency lifecycle.

## Mini1 and real Codex evidence

The local Hagency backend/bridge/console and Robrix2 Mini1 desktop were updated;
Palpo source and deployment were unchanged. All existing Agent YOLO settings
remain off. The test-only durable grant was revoked through the live webpage.

In Mini1's existing encrypted `octos-code-use · Private approvals` room, Robrix2
rendered all four buttons with the exact scope. Clicking **Always allow this
operation** produced an encrypted Matrix verdict, which Hagency consumed before
the harmless sentinel command ran. A fresh real Codex dispatch reused that rule
with no new owner verdict. After webpage revocation, the identical command again
parked for approval and did not modify the sentinel. Test cleanup denied that
pending request through the backend; that cleanup is not a native owner-button
test. The isolated real Codex YOLO probe executed outside its workspace with zero
approval callbacks. That probe did not test canonical task completion (no MCP
completion tool was attached).

One intermediate model turn selected a login shell (`zsh -lc`) instead of the
approved ordinary shell (`zsh -c`). It correctly required a new decision and was
cancelled. Subsequent polling timed out while that task was blocked; after an
operator resume and explicit follow-up, the exact original command reused the
rule successfully. Initial logs are preserved, not relabeled as passes.

Evidence root:
`~/Library/Caches/palpo-admin-e2e/2026-09-06/`

- `execution-auth-live/`: native card, saved/revoked rule screenshots, sentinel,
  isolated real YOLO report.
- `execution-auth-native-verdict.json`, `execution-auth-live-reuse-exact.json`,
  `execution-auth-live-revocation-confirmed.json`: real request/verdict/rule evidence.
- `execution-auth-validation/`: deterministic/browser/build/lifecycle logs.
- `execution-auth-backup-20260908-154315/`: pre-deployment runtime/config/binary.

No commits, pushes or PRs were created. The checkout's existing unrelated changes
were preserved. No task-writer is provisioned at this source root.
