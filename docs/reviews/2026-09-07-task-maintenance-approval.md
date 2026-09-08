# Routine task maintenance without owner approval

The operator requested repair of the recurring heartbeat/done approval cards.
The native Codex sandbox correctly blocked the shell wrapper's HTTP access to
HAFleet. The integration incorrectly depended on that shell transport for routine
task state: its prompt offered the wrapper, home instructions required it, and
the MCP heartbeat tool still called a legacy endpoint forbidden to ephemeral
dispatches. There was also an independent App Server MCP confirmation default.

## Change

- `update_task_execution` now uses the dispatch-scoped task endpoint. Its explicit
  field projection permits heartbeat and waiting metadata only; status changes
  still use the existing state machine through `transition_task`.
- Codex receives a developer instruction mapping the old wrapper operations to
  the managed MCP tools. The dispatch prompt requires confirmed explicit done
  after checks. Entry files and standalone wrapper behavior are unchanged.
- The launch config marks this MCP server required and authorizes exactly six
  task tools: list/get/accept/transition/comment/update execution. No server-wide
  exemption, shell-command matching, global network permission or stored hook
  trust edit was added. Supported options were checked against the installed
  Codex0.153.4 schema and the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
- Agent token, dispatch capability, runner, fence and exact task write scope are
  still checked on every request. Native approval requests, including actual MCP
  elicitations, still require an owner decision. A turn returning successfully
  cannot complete the task by itself.

## Verification

Five focused regressions initially failed. After repair, all92 tests across
ephemeral-session-tools, router-runner, router-backend, mcp-permission-channel,
api-tasks and mcp-namespace-drift pass with zero skips. They exercise the actual
stdio MCP server and HTTP backend, foreign/stale/forged authority, field
projection, waiting/resume/done, shell approval preservation and task state
remaining open without explicit completion. Strict router compilation and
generated-output comparison, router boundary,275 bound spec selectors, remote
package synchronization and whitespace checks pass.

The separate opt-in real-runtime probe uses the actual HAFleet backend and Codex
in an isolated local fixture. It retains the old home instructions to reproduce
the transport conflict. The first run failed honestly: Codex requested approval
for `get_task`, before the tool could reach the backend. No owner verdict was
fabricated. This led to the exact per-tool launch configuration above.

The second real run (23:53:21Z–23:54:35Z) passes. Codex wrote a CommonJS sum module
and three positive/negative/zero tests, ran them, reported its heartbeat through
the scoped execution operation, and explicitly transitioned its canonical task
to done. Independent rerun confirms3/3 tests. There were zero native approval
requests and zero backend approval records; the shell wrapper was never invoked.
Both the normal workspace sandbox and networkAccess=false remained configured.
This is real Codex/task-tool evidence, not a new Palpo/Robrix resource-allocation
workflow or proof of arbitrary network/filesystem grant support.

Agent-spec1.4 parses/lints the contract at100% quality. Its Cargo-only lifecycle
retains5 unsupported behavioral skips and is **not passing**; Vitest provides the
separate behavioral evidence. ADR-021 and task-scoped-task-maintenance.spec.md
record the scope and security decision.

## Deployment

At23:55Z, a fresh router read and read-only SQLite check both showed no leased,
started or parked runners. A consistent private database backup was saved.
Only the owned local HAFleet backend18194 was gracefully restarted, PID52844
→53826, with the existing rig environment. New dispatches use the repaired MCP
server and launch policy. Mini1 Palpo, its web admin, bridge18195, console13202,
Robrix and the separate manual runtime were left running.

The post-deployment API confirms the user's existing Agent remains available,
all five dispatches remain completed, and the original Python follow-up task is
still done at23:38:00.660Z. No user message was replayed and no resource request
or permission verdict was submitted for this repair.

Evidence is saved privately under `palpo-admin-e2e/2026-09-06`:
`task-maintenance-before.log`, `task-maintenance-tests.log`,
`task-maintenance-contract.json`, `task-maintenance-lifecycle.json`,
`task-maintenance-live-1/report.json`, `task-maintenance-live-2/report.json`,
`task-maintenance-predeploy.json` and `task-maintenance-deployed.json`.
The probe is reproducible through `scripts/probe-task-maintenance.mjs --live`
with a new absolute output directory. No commit or push was performed.

## Create Agent versus requesting an Agent

The local console's `/onboard` form provisions an agent home/token, chooses its
installed framework and optional preset/project, starts it, and waits for real
health. It creates an operator-owned agent instance. A Palpo project request asks
the provider for a role and allocation; acceptance can use an eligible instance
or provision one from a matching preset. The existing octos-code-use engagement
already provisioned coding_126926a91ba1, so the operator does not need to create a
second instance manually for that project.
