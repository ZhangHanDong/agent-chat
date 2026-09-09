spec: task
name: "Integrate current upstream and Matrix workflows"
inherits: project
satisfies: [REQ-UPSTREAM-INTEGRATION, REQ-EXECUTION-AUTHORIZATION]
tags: [active, integration, matrix]
---

## Intent

Merge current upstream with committed workflow changes without losing either
branch's task, approval, Matrix or dashboard behavior.

## Constraints

- Preserve fail-closed authentication and sandbox defaults.
- Upgrade both divergent database schema lineages without data loss.
- Keep routine task coordination usable and native approvals precisely scoped.
- Keep generated router output and remote MCP code synchronized.
- Use isolated deterministic tests; do not alter the live deployment.

## Boundaries

### Allowed Changes
- backend-v2.js
- bridge-matrix.js
- lib/**
- remote/lib/**
- router/**
- mockup/**
- tests/**
- scripts/architecture-boundaries.json
- scripts/run-suite-tests.mjs
- ./package.json
- specs/**
- knowledge/requirements/req-upstream-integration.md
- docs/**

### Forbidden
- Live credentials, original concurrent worktrees, root agent entry files.

## Acceptance Criteria

Scenario: Divergent deployed schemas converge
  Test: upgrades both version nine lineages without losing approval or task data
  Given deployed databases from either integration parent
  When the combined RouterStore opens and reopens them
  Then task operations, approval identity and authorization epochs coexist

Scenario: Scoped native approvals remain strict
  Test: approval scopes preserve exact command and structured permissions without inferring domains
  Given native approval callbacks
  When authorization scope is derived
  Then the exact trusted native scope remains bound to the current dispatch

Scenario: Agent credentials cannot grant execution rights
  Test: execution policy and grant management reject agent credentials and preserve defaults
  Given sandbox defaults and an Agent credential
  When that credential attempts to enable YOLO or manage grants
  Then the request is rejected and only contributor authority can change execution policy

Scenario: Suite process boundaries retain failures
  Test: sharded suite retains failure when a child crashes or omits its report
  Given the bounded full-suite process runner
  When a child fails crashes or omits its report but the merge succeeds
  Then the suite fails and still records every shard without narrowing CI coverage

## Out of Scope

- Pushing branches, changing the live deployment, or merging the Mini1 backport twice.
