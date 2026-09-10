spec: task
name: "Install complete inner-loop skill resources"
inherits: project
satisfies: [REQ-INNER-LOOP-MONITOR, ADR-016]
tags: [skills, installation, regression]
---

## Intent

Install the inner-loop skill together with its relative monitor script for
Claude and Codex. Preserve user content and existing skill aliases, and correct
the stale malformed-history test to assert the existing visible failure.

## Constraints

### Must
- Keep SKILL.md and scripts/monitor.mjs reachable from each installed inner-loop skill directory.
- Preserve existing hagency and agent-message links and back up replaced local content.
- Make check mode read-only and return a nonzero exit for incorrect links or missing resources.
- Remove only the owned inner-loop link during uninstall and preserve unrelated user content.
- Assert malformed Matrix history returns known false, an empty chunk, and a visible failure reason.

### Must Not
- Do not install into the operator's actual home or start services in tests.
- Do not change Matrix history implementation or runtime/backend protocols.

## Decisions

- Link the complete new skill directory; keep existing skill file links and aliases.
- [JS-only] Use Vitest with isolated temporary HOME and fixture checkout paths, and run the real shell entrypoints.
- Validate required resources before sync or installer skill writes; retain distinct backups when a backup name already exists.
- Limit uninstall cleanup to symlinks pointing at this checkout's inner-loop directory.
- Correct the existing malformed-history expectation without changing production code.

## Boundaries

### Allowed Changes
- bin/hagency-sync-skills
- ./install-full.sh
- ./uninstall.sh
- tests/install-scripts.test.js
- tests/skill-sync.test.js
- tests/matrix-representative.test.js
- specs/task-inner-loop-skill-install.spec.md
- .agent-spec/runs/**

### Forbidden
- Runtime services, global agent settings, backend and router source files.

## Acceptance Criteria

Scenario: Sync installs complete resources for both clients
  Test: skill sync links complete inner-loop resources for Claude and Codex
  Given an isolated home and checkout containing the two required skill resources
  When the real sync entrypoint runs then check mode runs
  Then each client can read the skill and its relative monitor script
  And check mode exits zero without changing files

Scenario: Existing user content survives synchronization
  Test: skill sync preserves local content and existing backups
  Given local skill content and an existing backup
  When the real sync entrypoint replaces the skill content twice
  Then both replaced versions and the existing backup remain readable

Scenario: Check mode refuses incomplete installs without mutation
  Test: skill check refuses missing resources and wrong links without mutation
  Given a missing installed link, wrong target, or missing source monitor script
  When check mode runs
  Then it exits nonzero and creates or replaces zero files

Scenario: Full installer provisions resources and preserves aliases
  Test: install-full bootstraps env, systemd units, CLI links, and skill links without starting services
  Given temporary home, bin, env, and systemd paths
  When the full installer runs with no-start and prerequisite and package installation skipped
  Then both clients can read the inner-loop skill and its relative script
  And existing hagency and agent-message links still resolve to the hagency template

Scenario: Installer preserves a local inner-loop skill
  Test: full installer preserves existing inner-loop skill content in a backup
  Given a local inner-loop skill directory and existing backup
  When the full installer provisions the new skill link
  Then the previous local files and backup remain readable

Scenario: Uninstall removes only links owned by this checkout
  Test: uninstall removes only its owned inner-loop links
  Given one owned link and one unrelated user skill directory
  When the real uninstaller runs against isolated paths
  Then the owned link is absent and the unrelated directory remains unchanged

Scenario: Malformed history remains an explicit failure
  Test: a malformed body yields an explicit unreadable history result
  Given a Matrix history response contains a non-array chunk
  When the existing history reader parses it
  Then known is false, chunk is empty, end is null, and reason states malformed messages page

## Out of Scope

- Authoring the skill and monitor, validating its algorithm, or changing runner task semantics.
- Publishing, global installation, or starting backend and Matrix services.
