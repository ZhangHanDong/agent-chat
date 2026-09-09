spec: task
name: "Repair Hono and Morgan advisory regressions"
inherits: project
satisfies: [REQ-DEPENDENCY-ADVISORY-REPAIR]
tags: [dependencies, security, ci]
---

## Intent

Restore the existing blocking dependency audit by upgrading the two affected
transitive packages to compatible patched releases. Preserve the runtime API,
approval boundaries, and existing debt policy.

## Constraints

- Do not add advisory identifiers to the baseline or allowlist, or weaken CI.
- Do not upgrade unrelated direct dependencies or change runtime authorization.
- Automated tests use local fixtures and must not contact live agent services.

## Decisions

- [JS-only] Raise the existing Hono override floor to 4.13.5 and add a Morgan
  override floor of 1.12.0, within the existing major versions. Regenerate only
  affected lockfile resolutions and required transitive changes with npm.
- The existing `npm run audit:baseline` command is the external advisory check;
  its registry access runs separately from fixture-based Vitest tests.
- Bound tests verify that the advisory gate remains blocking and the MCP/Matrix
  approval paths preserve their existing behavior. The installed Cargo-only
  lifecycle cannot execute Vitest; report those skips and actual commands separately.

## Boundaries

### Allowed Changes
- ./package.json
- ./package-lock.json
- knowledge/requirements/req-dependency-advisory-repair.md
- specs/task-dependency-advisory-repair.spec.md

### Forbidden
- Do not edit security/audit-baseline.json or scripts/audit-deps.sh.
- Do not mutate global settings, existing node_modules, or live E2E processes.

## Acceptance Criteria

Scenario: Reject new advisories without weakening the existing gate
  Test: the ratchet is wired into CI as a blocking step
  Given the existing CI advisory policy
  When its contract test reads the workflow
  Then the audit remains a required blocking step

Scenario: Keep debt recording distinct from approval
  Test: baseline explains that it records debt rather than approving it
  Given the existing advisory baseline
  When its contract test reads the recorded policy
  Then the baseline does not represent a safety approval

Scenario: Preserve capability-scoped MCP task routing
  Test: routes runner task tools through capability-scoped operations
  Given a local MCP task fixture
  When task operations pass through the installed SDK
  Then capability-scoped operations retain their existing bindings

Scenario: Preserve authenticated approval identity
  Test: structured verdict preserves authenticated Matrix sender and binding fields
  Given a structured owner verdict fixture
  When the Matrix approval adapter processes it
  Then the authenticated sender and request binding remain unchanged

Scenario: Clear the newly reported advisory regressions
  Test: manual_test_dependency_advisory_ratchet
  Given the repaired production lockfile
  When the operator runs npm run audit:baseline against current registry data
  Then no new advisory identifier remains outside the unchanged baseline

## Out of Scope

- Resolving all existing recorded security debt
- Changing the Matrix SDK or MCP transport architecture
- Changing the repository test timeout or concurrency defaults
