spec: task
name: "Qualify Linux guardian death recovery through a protected cgroup"
inherits: project
satisfies: [REQ-RUST-MIGRATION-EXECUTION, REQ-THREAD-SCOPED-SESSIONS, REQ-THREE-LAYER-COMPLETION]
tags: [active, rust, linux, custody]
---

## Intent

Add an explicit host-only cgroup recovery boundary to the existing guardian
launcher without advertising complete POSIX crash containment.

## Constraints

### Must
- Establish membership before sending Prepare or Start to the trusted guardian.
- Validate exact cgroup filesystem, control descriptors, protected ancestors and host privileges.
- Retain independent kill and bounded empty-subtree observations after guardian loss.
- Preserve uncertain cleanup and keep complete crash containment unsupported.
- Require privileged host provisioning and separate real Linux fixture qualification.
- Label local parser and refusal tests as admission evidence only.

### Must Not
- Do not mount, create or change permissions on system cgroups.
- Do not infer signal authority from a PID or add a second workspace launcher.
- Do not settle canonical tasks or resource leases from process observations.
- Do not treat absent delegation, skipped fixtures or cross-compilation as containment proof.

## Boundaries

### Allowed Changes
- native/hagency-platform/**
- knowledge/decisions/adr-048-native-linux-crash-custody.md
- specs/task-rust-linux-crash-custody.spec.md
- docs/**

## Acceptance Criteria

Scenario: Invalid cgroup observations cannot authorize recovery
  Test: native_cgroup_admission_vectors
  Test Double: bounded kernel text and metadata vectors
  Given invalid event state host capabilities or mount observations
  When the admission parser evaluates those observations
  Then it refuses the boundary without treating the vectors as kernel containment evidence

Scenario: Existing POSIX launch keeps its crash guarantee refusal
  Test: native_guardian_admission
  Level: integration
  Test Double: actual native guardian with no provisioned cgroup
  Given no protected host cgroup capability
  When a launch requires complete crash containment
  Then POSIX refuses before workspace code starts

## Decisions

Real Linux cgroup execution is a separate opt-in fixture with mandatory host
provisioning. Missing provisioning is a refusal, not a passing containment test.

## Out of Scope

Simultaneous backend and guardian death, host privilege provisioning, live models,
actual sandbox qualification, server enablement, macOS containment and full M4.
