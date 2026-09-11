spec: task
name: "Probe ordinary-token retained NTFS directory flush acknowledgements"
inherits: project
satisfies: [REQ-RUST-MIGRATION-EXECUTION]
tags: [active, rust, windows, probe]
---

## Intent

Measure one retained-object Windows NTFS directory flush candidate without
changing production media durability or enabling file upload.

## Constraints

### Must
- Run the actual qualification executable on Windows under an effective same-user token with administrator membership disabled no enabled privileges and no app-container token.
- Open only fixed relative dot beneath the retained directory and verify complete volume and 128-bit file identity plus existing private handle checks.
- Require actual local NTFS device classification and independent successful file and directory flush acknowledgements.
- Run real bounded snapshot encryption staging and exact process-restart restoration only after the candidate passes.
- Retain the original nonzero unknown or refusal verdict and bounded static diagnostic artifact.
- Limit each controller to one child at a time and two fixed child modes with finite wall waits and owned child cleanup.
- Keep at most four probe-owned directory or file handles concurrently and one existing bounded Store Workspace snapshot and result.
- Keep every synthetic input at most4096 bytes and the journal at most65536 bytes with one record and one held result.
- Confine unsafe FFI to audited example modules and keep production media-store unsafe code forbidden.

### Must Not
- Do not use remote paths raw volumes administrator privileges ambient directory reopening fallback or synthetic SyncEvidence.
- Do not change production synchronization timeout custody or upload eligibility.
- Do not call a negative Windows qualification a successful media workflow or claim hardware power-loss proof.
- Do not log paths tokens SIDs keys ciphertext descriptors or process handle values.

## Boundaries

### Allowed Changes
- native/hagency-media-store/examples/windows_directory_flush.rs
- native/hagency-media-store/examples/windows_directory_flush/handles.rs
- native/hagency-media-store/examples/windows_directory_flush/token.rs
- native/hagency-media-store/examples/windows_directory_flush/fixture.rs
- native/hagency-media-store/Cargo.toml
- native/hagency-media-store/src/lib.rs
- ./Cargo.lock
- .github/workflows/windows-media-probe.yml
- specs/task-rust-windows-directory-durability.spec.md
- knowledge/decisions/adr-103-windows-directory-durability-probe.md
- docs/progress.md
- docs/agent-knowledge.md

### Forbidden
- Production lib.rs changes are limited to an unsafe-code forbid attribute.
- Existing CI workflows production media synchronization and service profiles remain outside this task.

## Acceptance Criteria

Scenario: Only explicitly classified mounted device flags are admitted
  Test: native_windows_directory_profile_flags
  Given the exact mounted bit and optional named app-container traversal flag
  When the profile includes any other bit a wrong device or lacks mounted status
  Then classification refuses while both exact known profiles remain eligible for actual verification
  And this pure classification never supplies file or directory acknowledgement

Scenario: Ordinary-token retained local NTFS candidate qualifies or refuses explicitly
  Test: native_windows_directory_probe
  Given one fresh private local fixture and a restricted same-user token
  When the actual Windows example checks identity permissions filesystem and real flushes
  Then only complete acknowledgement qualifies and unsupported or unknown evidence exits nonzero
  And the original workflow result and static diagnostics remain available

Scenario: Qualified original ciphertext survives a separate process
  Test: native_windows_directory_probe
  Given an actually qualified candidate and original encrypted staged media
  When every first-process owner exits and the second child opens the exact original receipt
  Then exact ciphertext descriptor digest and checked plaintext match without reconstruction or network
  And the probe makes no power-loss or production-upload readiness claim

## Out of Scope

Production implementation service activation Matrix sending changing Windows
upload gates hardware durability generalized filesystem support and privileged
volume flushes. The bound Windows example test is an executable gate and cannot
pass through non-Windows cross-compilation or an unsupported return branch.
