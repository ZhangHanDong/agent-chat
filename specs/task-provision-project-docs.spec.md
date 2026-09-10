spec: task
name: "Project mappings in provisioned bootstrap documentation"
inherits: project
satisfies: [REQ-PROVISION-PROJECT-DOCS]
tags: [provisioning, projects, regression]
---

## Intent

Give provisioned agents exact project edit paths and copy/symlink semantics
when their bootstrap reads docs/projects.md.

## Constraints

### Must
- Derive the document from existing manifest bindings without changing their authority.
- Preserve manual content outside the managed mapping block.
- Execute deterministic tests only in temporary directories.

### Must Not
- Do not modify live E2E runtime, credentials, or global agent settings.
- Do not replace source project content or change project materialization behavior.

## Decisions

- Share one managed-document writer between provisioning and project removal.
- Store exact mapping values in a JSON code block with explicit workdir path semantics.
- Replace the known legacy placeholder and update only a marked mapping block on refresh.
- [JS-only] Run exact Vitest selectors separately from agent-spec lifecycle.

## Boundaries

### Allowed Changes
- lib/agent-project-docs.js
- scripts/provision-v1-agent-home.js
- scripts/hagency-project.js
- tests/provision-project-docs.test.js
- tests/api-agent-provision.test.js
- knowledge/requirements/req-provision-project-docs.md
- specs/task-provision-project-docs.spec.md

## Acceptance Criteria

Scenario: Provisioned project paths describe their real editing behavior
  Test: provisioned projects document copy and symlink edit paths
  Given a source project and a temporary agent home
  When the real provisioning script materializes copy and symlink bindings
  Then projects.md names the actual managed edit directory, origin and mode

Scenario: No-project and old placeholder homes remain explicit
  Test: refreshes the legacy projects placeholder and reports no bound project
  Given a home containing the old projects placeholder
  When provisioning runs without a project
  Then the document names workdir/projects and contains an empty mapping

Scenario: Refresh does not overwrite manual notes or duplicate mappings
  Test: preserves manual project notes while refreshing one managed block
  Given manually authored project notes
  When provisioning adds a binding and refreshes it twice
  Then the notes remain intact and exactly one current mapping block exists

Scenario: Removed projects do not remain in bootstrap mappings
  Test: project add and remove keep bootstrap mappings current
  Given a provisioned home without a project
  When the project CLI adds and removes a binding
  Then projects.md reflects each manifest and the source project is preserved

Scenario: Incomplete document markers do not authorize overwriting notes
  Test: refuses incomplete mapping markers without overwriting manual content
  Given an interrupted manual edit left an incomplete managed block
  When provisioning refreshes the document
  Then it fails with a marker error and preserves the document bytes

Scenario: Operator provisioning exposes the selected project to bootstrap
  Test: API provisioning writes the selected project mapping for bootstrap
  Given a temporary backend runtime and an operator credential
  When the provisioning API receives a project path
  Then the returned workdir contains projects.md with the real symlink binding

## Out of Scope

- Retrofitting live agent homes or restarting services.
- Changing agent identity, project copy/symlink rules, or task state.
