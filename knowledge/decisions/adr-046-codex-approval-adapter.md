# ADR-046: Typed Codex approval coordination before native cutover

- Status: Accepted for offline implementation; live native approval cutover remains gated
- Date: 2026-09-10
- Requirements: REQ-OWNER-UI-APPROVAL, REQ-EXECUTION-AUTHORIZATION, REQ-RUST-MIGRATION-EXECUTION
- Related: ADR-032/034 native protocol/session, ADR-039 execution scopes, ADR-043 durable owner approvals

## Decision

Keep `hagency-runtime` independent of the domain database. The new
`hagency-permissions` crate owns one validated Codex `SessionDriver`, its current
host capability, and the schema13 `DomainStore` approval API. No HTTP setter or
runtime JSON field can select the host connection, Hagency identity, owner room,
workspace lease, or verdict.

The host explicitly attaches the coordinator after thread/turn startup. The
coordinator derives exact upstream thread/turn and cwd/read-only settings from
that session; the host supplies opaque context/connection/workspace-resource IDs.
The repository then proves the current full Matrix/private-owner binding,
canonical task epoch, dispatch fence and workspace lease. Writable contexts need
an exclusive clean lease; read-only contexts cannot become writable through an
upstream claim. Multi-environment and YOLO configuration remain refused.

The default `SessionDriver` and `OwnedSession` behavior continues to reject every
server request. Opt-in admits only bounded pinned request types. It emits a
private parsed event, then the coordinator asks the single repository writer to
persist the request and park its dispatch. Owner verdicts remain a separate
authenticated private-room host observation, including all schema13 revocation
and shared-room fences. Runtime requests never synthesize owner decisions.

`apply` consumes the exact durable decision before constructing/sending any
response bytes. The application descriptor is checked against the owned
connection/request/thread/turn/item. Runtime's typed response object has no
Deserialize or arbitrary-result constructor. The connection checks the complete
original method/params and exact JSON-RPC ID and permits one response, retaining
the pending scope until upstream resolution. Numeric and string IDs are distinct.
Schema13 cannot represent negative numeric IDs; the coordinator refuses those
without string coercion. Requests are bounded to 64 KiB, at most 16 retained
coordinator approvals per turn, and existing connection/event/deadline bounds.

## Pinned request-specific responses

Local `codex-cli 0.153.4` generated schemas were inspected offline with
`codex app-server generate-json-schema --experimental`. The official release tag
`rust-v0.153.4` resolves to commit
`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`.

| Request | Once allow | Deny |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | `{"decision":"accept"}` | `{"decision":"decline"}` |
| `item/fileChange/requestApproval` | `{"decision":"accept"}` | `{"decision":"decline"}` |
| `item/permissions/requestApproval` | exact requested supported profile with `"scope":"turn"` | empty profile with `"scope":"turn"` |

An owner “once” verdict for a permission-profile request authorizes that explicit
turn-scoped profile once; it does not claim each subsequent command will ask
again. Task/always choices remain Hagency's scoped durable rules, never Codex
`acceptForSession`, session profiles, exec-policy amendments, or network-policy
amendments. Command requests offering no exact accept/decline pair, writeStdin,
file grantRoot, filesystem special/glob/deny entries, malformed/future fields,
and unsupported methods fail closed. Literal file paths are shape-checked by the
runtime; reusable scope normalization stays exclusively in core/store.

File and explicit permission requests can precede `item/started`. Their exact
callback item is bound as upstream correlation data without inventing an active
item or converting that value to host task/session identity. The pinned
[request creation paths](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/bespoke_event_handling.rs#L640)
show why requiring every item to have started would reject valid requests.

## Resolution is not application acknowledgment

This is established from source, not inferred from schema names. For command,
file, and permission callbacks, Codex awaits the response channel, sends
`serverRequest/resolved`, and only then parses the selected typed response and
submits the core operation. Errors, callback drops and turn-transition
cancellation also traverse this resolution path. See the pinned
[file/command handlers](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/bespoke_event_handling.rs#L2011),
[permission handler](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/bespoke_event_handling.rs#L1885),
[cancellation path](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/outgoing_message.rs#L185),
and [resolution emission](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L848).

Consequently flush leaves Applying. Observed resolution records Uncertain; it
never records Applied or resumes a parked dispatch. Failed writes and explicit
close also record Uncertain. Dropping a started async operation closes the owned
session. If a database response or async uncertainty observation is lost,
Applying survives and becomes Uncertain on repository reopen; neither state can
be consumed again. Resolution before a decision closes the session so a later
owner approval cannot answer the cancelled callback. Stable duplicate owner
verdicts remain repository receipts, not permission to resend bytes.

No model text, item completion, turn completion, generic callback termination,
or empty stdin queue supplies the missing proof. Before live native approvals,
a host inspector or upstream protocol extension must bind the exact request and
selected decision/profile to a core acknowledgment **after actual application**,
with cancellation distinguished from application. Merely moving notification
after `submit` would still only prove operation queue admission. This offline
slice intentionally provides no fake Applied escape hatch. Existing schema13
host inspection API remains the authority boundary for future validated evidence.

## Verification and limits

Regression fixtures use real SQLite/domain authority plus bounded duplex streams.
A writer inspects durable Applying on the first response-byte attempt. Tests
cover request-specific mappings, exact IDs/body/threads, default refusal,
revoked grants, read-only scope, failed transactions, duplicate application,
multiple pending approvals, resolution before/after decision, write failure,
future cancellation and restart. These prove domain/protocol sequencing; they do
not prove a live Codex permission was applied or an OS sandbox was enforced.

No Matrix cards/sends, automatic process attachment, live model, runner cutover,
new taskless path, or operational grant compaction is enabled. Requests racing
startup before the validated turn response remain refused. This is a bounded
integration seam, not completed native approval feature parity.
