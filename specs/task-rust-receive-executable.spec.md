spec: task
name: "Exercise actual encrypted intake through native MCP into the original runtime workspace"
inherits: project
satisfies: [REQ-RUST-MIGRATION-EXECUTION, REQ-THREAD-SCOPED-SESSIONS, REQ-MATRIX-DM-PRIVACY]
tags: [active, rust, matrix, attachments, executable]
---

## Intent

Implement the root-accepted nine-path executable acceptance partition of ADR105.
Use the actual native server, a separately owned offline SDK sender, authenticated
local TLS, the real selected inbox and native MCP. An offline protocol peer reads
the result through the runtime's actual original workspace. This is development
workflow acceptance, not installed Codex sandbox or production migration parity.

## Constraints

### Must
- Provision only legitimate canonical session task resource and workspace configuration before native serve starts.
- Enroll fresh service crypto through actual authenticated requests and independently generate incoming signed Olm and Megolm encrypted events.
- Drive the actual one-attempt Collector intake inbox selection host claim Started registration and native MCP discovery and receive workflow.
- Assert generated relative path actual size and hash against bytes read inside the original launched runtime workspace.
- Preserve direct privacy and addressed-group context selection with exact original event identities.
- Count actual authenticated media GETs and distinguish replay source failure retirement caller loss and original custody after restart.
- Keep finite fixture watchdogs bounded responses safe original-child diagnostics and actual test counts.

### Must Not
- Do not open or seed the service SDK store manufacture a Started binding set attachment visibility or inject a raw runner capability.
- Do not substitute canned tool results domain-only checks or source-file assertions for the actual executable result.
- Do not treat unavailable platform qualification missing tests or unknown outcomes as passing.
- Do not change dependency versions live services existing fixture semantics or production trust and sandbox policy.

## Boundaries

### Allowed Changes
- native/hagency/tests/received_files.rs
- native/hagency/tests/received_files/fixture.rs
- native/hagency/tests/received_files/recovery.rs
- native/hagency/tests/fixtures/receive_mcp_peer.rs
- native/hagency/Cargo.toml
- specs/task-rust-receive-executable.spec.md
- knowledge/decisions/adr-105-native-receive-file-workflow.md
- docs/progress.md
- docs/agent-knowledge.md

### Forbidden
- No original outgoing fixture source service sink domain Matrix SDK runtime or operator state edits belong to this partition.

## Acceptance Criteria

Scenario: Actual native MCP receives the selected encrypted attachment
  Test: native_receive_executable
  Given fresh service state and an independently signed encrypted DM or addressed group attachment
  When native intake selects the original inbox and the launched runtime invokes actual MCP discovery and receive
  Then one authenticated media GET produces a generated path whose actual workspace bytes size and hash match the sender
  And selected context tool markers and canonical task status preserve their original meanings

Scenario: Exact Ready replay revalidates original bytes and refuses later mutation
  Test: native_receive_replay_bounds
  Given a successful original receive in the still-running original runtime
  When native MCP repeats the exact event and then the retained destination changes
  Then the intact original replays without another GET and changed bytes refuse without overwrite

Scenario: Incomplete transport cannot produce a received path
  Test: native_receive_uncertainty
  Given an actual admitted receive whose authenticated media response is incomplete
  When the original transport deadline or framing check refuses the response
  Then native MCP exposes no successful path and no local Ready record or replacement GET appears

Scenario: Restart does not restore an original received path owner
  Test: native_receive_restart
  Given actual received cache facts and the original process is gone
  When a fresh native service opens the same state and inherited original context asks for the file
  Then no historical fact restores a Started binding path response download or file write

## Out of Scope

Installed Codex sandbox qualification live Matrix compatibility cache cleanup and
production activation remain separate. These executable tests do not replace
platform-specific positive filesystem evidence or every ADR105 lifecycle fault.
