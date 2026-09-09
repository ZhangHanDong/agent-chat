# Chinese Agent names — 2026-09-09

Palpo Web and HAFleet rejected project Agent names with an ASCII-only lowercase
validator. The web form also advertised that restriction. All three boundaries
now accept Unicode letters (including Chinese), marks and numbers, with the
existing underscore/hyphen separators and 64 UTF-16-unit bound. Both API sides
normalize to NFC for replay and same-project duplicate checks.

The requested display name remains Chinese. HAFleet derives ASCII-only runtime
and Matrix localpart stems with the existing fleet/project/request hash. Existing
ASCII identity derivation remains byte-for-byte compatible; no identities were
renamed. Authorization, capacity and manual approval are unchanged.

## Validation

- Palpo: all 67 Node tests pass; syntax checks pass. Tests cover Chinese names,
  canonical duplicate/replay behavior, invalid names and unchanged source binding.
- HAFleet: 23 tests pass across project-agent-definition, fleet-protocol,
  palpo-agent-definitions, resource-agent-definitions and resource-allocation-budget.
  The allocation fixture provisions 小白 and 孙悟空-01, preserves their display
  names, generates distinct safe Matrix/runtime identities, and exercises retries.
- Playwright fixture: approved ordinary user submits 小白-01 through the actual
  form and API. No browser errors.
- Live Playwright on https://crew.ominix.io:19444: existing test user submits
  中文验证-0909 into its existing project. HTTP201 first queues the request;
  the outbound worker delivers it and Palpo observes provider state pending.
- HAFleet independently reports engagement en_mtuclqk1_04c8a1 pending, exact
  Chinese definition preserved, no Agent identity or allocated tokens.
  Request ID: unicode-name-20260909. No live allocation or model task was approved.
- ESLint, diff checks and exact spec bindings pass. Agent-spec1.4 parse/lint pass;
  lifecycle with explicit paths passes the boundary check and skips10 Node
  scenarios. These skips are not a lifecycle pass. Initial worktree autodetection
  used incorrectly prefixed absolute paths; explicit relative changes correct
  that tool invocation without widening boundaries.
- The first live driver used an overexact label selector for the project select
  and timed out before submission. A stable field selector completed the flow.
  A separate final capture waits for the pending request card to finish rendering.

## Deployment and evidence

Palpo source: /Users/yuechen/home/palpo-account-approval-20260909.
Mini1 web image: palpo-web-admin:136171fcade9cd56.
The existing account-approval configuration and credentials were retained.
HAFleet source: /Users/yuechen/home/hagency-outbound-20260908. Backend and bridge
restarted after all63 existing dispatches were complete; they retained runtime
state and their outbound transport. Palpo Rust and Robrix needed no code changes.

Evidence: /Users/yuechen/Library/Caches/palpo-admin-e2e/2026-09-06/unicode-agent-names-20260909.
This contains live-browser-proof.json, hafleet-pending-proof.json, screenshots,
test/lifecycle logs, the previous HAFleet module and deployment rollback metadata.
Source changes are uncommitted; no merge or push was performed. The workspace
still has no provisioned task-writer, so no canonical task state was fabricated.
