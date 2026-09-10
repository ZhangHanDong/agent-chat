---
kind: decision
id: ADR-028
status: Accepted
title: Native state ownership and migration recovery boundaries
---

Implements the operator's REQ-RUST-MIGRATION-EXECUTION. Baseline is
`5dbef22dc5ad4e0bb1a886538406ec91a5893f9b`; production continues using JS/TS.
Fresh native state is the default. No old router, JSON or SDK store is imported.

## Owners and commit boundaries

| Command | Owner | One atomic commit | Replay identity | Crash recovery |
| --- | --- | --- | --- | --- |
| Receive transport delivery | Registration-bound custody repository | Binding generation, complete payload, content digest, receipt | registration + lane + delivery ID, digest must match | Before commit: no ACK. After commit: same receipt; still unprocessed |
| Admit project request (M2/M5) | Domain service, `domain.sqlite3` | Authenticated intake evidence, request, domain inbox marker | registration + request ID + canonical authenticated fields | Transport retries admission; domain returns original outcome; no second request |
| Approve selected resource (M2) | Domain service | Current authority checks, pool/shared-seat reservation, fulfillment phase, provisioning intent in domain outbox | engagement ID + approval command ID + binding generation | Resume durable provisioning intent; never reserve twice |
| Provision identity (M4/M5) | Domain service coordinates runtime/Matrix adapters | Intent before external action; observed identity/effect receipt after action | stable Agent identity + provisioning operation | Inspect ambiguous account/process creation; do not launch again on timeout |
| Create/claim task dispatch (M3) | Domain service, same database as core allocations | Task mutation, dispatch lease/fence, scoped input, outbox intent | task/session/dispatch/attempt identities | Expired authority cannot resume; uncertain effects require inspection |
| Approve tool operation (M6) | Domain service | Owner/device/project/task/fence checks, one-use consumption or scoped grant, decision outbox | approval ID + current binding/fence | Retry original verdict; no generic reusable grant |
| Settle dispatch and send result (M3/M6) | Domain service | Authorized canonical task transition, usage observation, reply outbox | dispatch + delivery destination + result ID | Matrix retry uses stable transaction ID; runtime exit is not task completion |
| Rotate private credential or crypto device (M5/M6) | Credential/crypto adapter plus domain rotation saga | Each owner commits its own generation/intent; never a cross-DB pseudo-transaction | rotation ID + old/new generation | Remain unavailable until both acknowledgements reconcile; never rewind crypto ratchets |

The foundation implements transport custody. The M2 domain checkpoint additionally
implements project-defined request admission, reservation/decision/outbox commits
and explicit effect reconciliation using fixture-verified observations. Actual
Matrix transport and provisioning adapters remain absent. Core business state and
canonical router/task state share **one authoritative domain database**
with one transactional writer. Separate repositories are module boundaries,
not a license to split atomic invariants across independent SQLite files.
Transport custody and Matrix SDK crypto remain independently owned stores.
Cross-owner operations use durable inbox/outbox handoffs; ACK is not admission.

The native development API accepts operator-provided fixture envelopes. It does
not claim those envelopes are authenticated Matrix observations, and therefore
cannot approve, provision or execute Agents. M5 supplies and validates real
registration-bound provenance before crossing into domain admission.

`domain.sqlite3` uses a distinct application ID, `domain.lock`, WAL/FULL commits
and the same private file policy. Its dedicated worker has 16 queued commands by
default, a 64 KiB input limit, 8 MiB byte budget and two-second response deadline.
Queries page at 100 records. New identities are bounded to 1,024 registrations,
2,048 resources/seats and 10,000 requests; capacity never deletes pending work.
Decision/effect rows are indexed and updated individually, without lifetime-store
cloning. Completed audit retention/compaction remains an M8 release gate; this
checkpoint is not a continuous-operation retention claim.

Native project bindings pin the full owner, private room and project room to a
registration generation. Rotation fences old admission, approval and effect claims;
it does not erase allocations. Rebinding/rotation reconciliation remains closed
until the authenticated transport/credential saga exists. Local explicit revocation
can still persist its fence and pending cleanup. An old-generation cleanup must
not be reported completed merely because the registration changed.

Native schema2 adds explicit role publication with an ordered SQL migration.
Fresh schema creation and all needed upgrades share one transaction; a failed
migration preserves the previous version and rows. Downgrades and foreign stores
remain refused. Resource role caches are never authority: eligibility is computed
from the existing embedded role-capacity policy and current provider/reasoning
fields. Review counts active allocated model families on the same registration;
unprovisioned configurations and another registration cannot satisfy that guard.

## Latency and storage

SQLite commands run on a dedicated thread. Defaults: 16 queued commands, 16 MiB
of serialized queued payload, 4 MiB per delivery, eight HTTP body/command slots,
64 connections, two-second body/command deadlines. An admitted command that loses
its response returns `outcome_unknown`; the caller reconciles with the same ID.
No external effect is replayed by this worker. Shutdown drains prior commands and
releases the database before acknowledging shutdown.

Custody retains at most 1,024 unprocessed records and 16 MiB of payload. Reaching
capacity rejects new IDs; identical retries still retrieve their original receipt.
No pending record is deleted to make space. M5 must add acknowledged completion,
tombstone retention and bounded pruning before continuous transport is enabled.
JSON parsing/validation remains bounded foreground CPU work; it is not described
as an unlimited or cost-free operation.

Future usage collection gets a **separate** worker and timestamped snapshot.
HTTP reads never scan runtime history. Snapshot states include unavailable,
fresh and stale with last collection time; unknown token usage stays unknown.
Before M7 completion, a populated 10,000-file fixture must show approval,
heartbeat and health p95 below 250 ms locally while collection is running, with
an explicit hardware record and memory ceiling. This workload gate is still open.
The foundation saturation test proves custody-worker separation only.

## Platform and dependency choices

Rust edition 2024, pinned toolchain 1.95.0, Salvo 0.96.0 (requires Rust 1.94).
SQLite 0.37 is selected to share the native SQLite library required by
matrix-sdk-sqlite 0.18; two incompatible `libsqlite3-sys` versions cannot be linked
into one eventual executable. Cargo.lock pins transitive dependencies. Browser
JS and Node-based build/test tooling remain development dependencies.

Unix state uses owner-only directories/files, ownership and hardlink checks,
exclusive file locking and durable commits. Windows uses native owner-SID DACLs,
reparse/hardlink rejection and file locks. Windows FFI is isolated in one module;
the rest of the store denies unsafe Rust and core/API forbid it.
Cross-compilation is not evidence of Windows execution or of sandbox support.

An offline SDK proof creates fresh encrypted state, exchanges its generated
cross-signing material through a fixture key-query response, reopens the device,
and decrypts under `CrossSigned` trust. It rejects wrong device IDs and encryption
keys. This is not a connected Palpo test, NAPI crypto import, multi-user trust
proof, device recovery flow or production authorization implementation.

## Early gates and dependencies

Before native Agent launch becomes available, execute a headless fixture runner
on native Windows and both Unix families: assigned ownership before work,
child/grandchild cancellation, parent crash, PID reuse and effective sandbox
verification. Windows Job Objects alone are not a sandbox. Unproven runner/platform
combinations remain unavailable. The current foundation executes no Agent.

M7 API/UI shell work can start after M2/M3, but integrated M7 acceptance also
requires M5 transport/crypto and M6 approvals/files. M8/M9 remain closed until
those workflows and platform proofs pass. There is no authorization for a live
cutover in this checkpoint.

Windows crash recovery also validates SQLite auxiliary files inherited from the
private state directory. Elevated Windows processes can assign those files the
Builtin Administrators owner SID. Only for these literal journal/WAL/SHM paths,
that privileged owner is accepted alongside the service SID; every access ACE
must still name only the service SID, and reparse/hardlink checks remain enforced.
Credentials, database and ownership-lock files retain exact owner-SID validation.
Administrator/root privileges are outside protection against ordinary local users.
The private-file regression also rejects public-read ACLs for journal files.
