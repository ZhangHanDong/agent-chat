# Manual web onboarding recovery — 2026-09-06

`sunwukong-01` now completes onboarding through the local web form. Independent
inspection reports `online: true`, `healthy: true`, MCP present and a live Claude
tmux pane. Its selected `claude-opus-5` profile, contribution preset, agent identity,
home paths and agent-token fingerprint are unchanged.

## Cause

Provisioning succeeded. The backend then spawned `hagency up-v1` with the correct
deployment environment, but the launcher sourced the repository `.env` again.
That replaced the running instance's port and bearer token. The launch-profile
request went to the other loopback backend and received 401, while the intended
backend returned 200 and the existing runtime profile. The launcher exited before
starting Claude. A runtime dotenv file would previously have overridden the repo
file, but this instance is configured through process environment and has no such
file. Creating a duplicate dotenv is not the repair.

The console's `restarts=3` and continuing-supervisor/ACP-removal message were
hard-coded demonstration text. No measured restart count supported them. The
agent uses Claude/tmux; that ACP remedy did not apply. The console also accepted
the backend's optimistic `starting`/`online` flag as success before actual health.

## Repair and live result

Backend launches mark their environment already resolved. Both v1 and tmux entry
scripts retain it; standalone CLI launches still load repository defaults followed
by runtime dotenv. The backend keeps a launch-exit failure reason even if a session
sweep already marked the agent offline, while preserving an operator Stop fence.

The web form now requires two consecutive healthy backend observations, retains
the actual failure message and marks the step that failed. An existing offline
agent with the same framework and preset can use **Retry start**, preserving its
provisioned identity. Other 409 responses are not misclassified as already online.
English and Chinese messages both omit the invented restart count and ACP advice.

The dedicated test instance's session allowlist was extended only for the exact
operator-requested name. No same-name tmux session existed before retry. The real
web retry sent one `POST /agents/sunwukong-01/start` and no provision request.
The launcher fetched the correct profile, passed its normal approval readiness
checks, started Claude and connected MCP. The corrected health check completed.

The earlier live workflow exercised Matrix on-demand provisioning; it did not
certify this manual web launcher path. Its earlier results remain scoped to that
workflow. This recovery does not claim the agent has fulfilled a project request.

## Verification

- Four new assertions first failed: backend environment handoff, both real shell
  launchers' dotenv behavior, and preservation of launch failure after offline
  observation. The repaired focused run passes 36 tests across three files.
- Another 86 related tests pass across provisioning, approval readiness, launch
  policy, session ownership and tmux self-checks. Deterministic tests use owned
  fixtures and do not contact live model providers or Matrix servers.
- An isolated browser fixture confirms that optimistic starting does not pass,
  and the actual failure reason remains visible at the failed launch step.
- Production console build, shell syntax, scoped ESLint, whitespace checks and
  all 230 current specification selectors pass.
- Agent-spec 1.4 parse/lint completes. The bounded task lifecycle remains
  **non-passing**: one boundary pass and four skipped behavioral scenarios, with
  no failed/uncertain verdicts. Separate Vitest and browser results provide the
  execution evidence; skips are not passes.

Private receipts, original launch failure, browser captures, identity fingerprints
and deterministic logs are under the existing live-test cache's
`closure/sunwukong-onboarding/`. Operational values and credentials are not checked
into the repository. Changes remain uncommitted.

Contract: [manual onboarding recovery](../../specs/task-web-onboarding-recovery.spec.md).
Decision: [ADR-019](../../knowledge/decisions/adr-019-live-workflow-authority-and-termination-evidence.md).
