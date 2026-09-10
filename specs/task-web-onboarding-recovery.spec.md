spec: task
name: "Preserve deployment identity and report actual web onboarding failure"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE, REQ-OWNER-UI-APPROVAL, ADR-019]
tags: [active, onboarding, runtime, console]
---

## Intent

Repair the operator's sunwukong-01 onboarding failure. Backend-spawned launchers
must retain that deployment's resolved environment, and the console must report
observed launch/health outcomes without invented restart counts or ACP remedies.

## Constraints

### Must
- Preserve the existing agent home, token and selected resource when retrying.
- Keep the standalone CLI's repository/runtime dotenv precedence.
- Require observed healthy state before reporting onboarding success.
- Keep failure messages persistent and tied to the phase that actually failed.
- Use only owned local fixtures in deterministic tests.

### Must Not
- Do not weaken authentication, runtime approval, sandbox or session ownership policy.
- Do not disclose tokens or provider credentials in logs or browser responses.
- Do not report process creation or optimistic starting state as healthy.

## Boundaries

### Allowed Changes
- backend-v2.js
- bin/hagency-up
- bin/hagency-up-v1
- mockup/app/onboard/page.jsx
- mockup/lib/console-workflow.js
- mockup/lib/i18n.js
- tests/api-agents.test.js
- tests/console-live-ux.test.js
- tests/launcher-env-handoff.test.js
- specs/**
- knowledge/decisions/adr-019-live-workflow-authority-and-termination-evidence.md
- docs/**

## Acceptance Criteria

Scenario: Backend launch retains its resolved deployment
  Test: backend v1 launcher uses its own authenticated loopback deployment despite repository dotenv
  Test: tmux launcher preserves the resolved backend environment
  Given a backend deployment supplied entirely through its process environment
  When its launcher encounters another deployment's repository dotenv
  Then launch configuration is fetched only from the originating authenticated backend
  And the following tmux launcher retains the same deployment identity

Scenario: Standalone CLI configuration remains supported
  Test: standalone launchers still load runtime dotenv after repository defaults
  Given a standalone launcher with repository and runtime dotenv files
  When no backend-resolved environment marker is supplied
  Then the runtime dotenv remains authoritative

Scenario: Observed launcher failure survives prior offline detection
  Test: launcher exit preserves its failure reason after the session sweep already marked it offline
  Given a launcher whose missing session has already been observed
  When that launcher exits unsuccessfully
  Then its failure remains visible rather than being discarded

Scenario: Console does not invent health or restart evidence
  Test: onboarding waits for actual health and preserves observed launch failures
  Given optimistic starting state or a real launch failure
  When the onboarding page interprets the observation
  Then starting is not healthy and failure is retained
  And no unmeasured restart count or unrelated ACP removal command is displayed
