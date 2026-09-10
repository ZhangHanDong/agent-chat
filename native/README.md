# Native Hagency migration

This worktree contains native foundation and selected-resource domain checkpoints. It is **not a
replacement for the deployed Hagency application**. Resource allocation, Agents,
Palpo transport, the console API and Matrix chat still run in the existing JS/TS
implementation. Native capability responses explicitly mark these unavailable.

The current developer checkpoint includes domain schema 15: scoped tasks,
internal groups, durable graphs, verified-input task activation, owner approvals
and notice/final-reply send custody, with exact negative Matrix transport fencing. Independent custody schema 2 preserves outbound work and publication
receipts across machine-token rotation; hagency-palpo adds bounded outbound HTTPS
with independent polling and publication. The runtime crate provides a bounded
Codex one-turn session connected to guardian-owned Unix pipes and Windows
overlapped pipes under atomic Job Object custody for offline fixtures. The native CLI and MCP helper maintain an assigned task through the scoped API.
The opt-in permissions coordinator consumes durable owner authority before an
exact typed Codex response; upstream application remains explicitly unproven.
The new hagency-matrix library collects authenticated account and full room state
with encrypted SDK custody. Event admission, key publication and sends remain
gated; the service does not yet construct this adapter. Service Agent execution
and actual Matrix delivery remain disabled.
The sections below record the successive checkpoints.

Build and run from this worktree, using a new state directory:

```sh
cargo build --locked --release -p hagency
cargo run --locked -p hagency -- init --state-dir native/.state
cargo run --locked -p hagency -- serve --state-dir native/.state
```

The same Cargo commands work in PowerShell. The service defaults to
`127.0.0.1:13300`, requires loopback and never reads `.env`. Init creates an
owner-private `operator.token` and fresh custody/domain databases; it refuses nonempty
state and never replaces an existing token. Keep the token in its protected file.
Only one process may own a state directory. Use Ctrl-C for a drained shutdown.

- `GET /health`: process health and explicit foundation stage.
- `GET /api/native/v1/capabilities`: authenticated capability availability.
- `POST /api/native/v1/custody`: authenticated **fixture** custody. Requires exact
  Host and Bearer token; browser Origin/forwarding headers are rejected. The body
  contains `binding`, `generation`, `id`, `lane`, `kind`, and object `payload`.
  A 202 receipt means durable storage only. It cannot approve or run an Agent.
- Existing production routes deliberately remain absent until their native
  implementations meet the corresponding contracts. Do not point the live console
  at this service.

Operator-only development resource endpoints under `/api/native/v1`:

| Method/path | Behavior |
| --- | --- |
| `POST resources` | Create/edit a resource; creation defaults to publication, an omitted publication choice on edit preserves withdrawal |
| `GET resource-configurations` | Paged operator configuration, including withdrawn resources |
| `GET resources` | Paged catalog projection; omits internal preset and seat IDs |
| `GET resources/{id}/budget` | Selected pool/shared-seat commitments; unknown quota remains null |
| `GET/POST seats` | Paged quota declarations or save a declaration; no credentials are exposed |
| `GET engagements` | Paged request/allocation projection without private owner-room evidence |
| `GET roles` | Derived eligibility with explicit publication choices and cross-family requirements |
| `POST roles/{role}/publication` | Save `{ "published": false }` to withdraw a role, or true to restore it |

List endpoints accept `after` (last returned ID) and `limit` (1–100). These routes
share the operator bearer and exact-host/origin checks. They are not the existing
console API. Requests, approvals and effect receipts cannot be submitted through
fixture HTTP routes; the development service does not launch runners or connect
the authenticated Matrix collector yet.

Checks:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
node native/scripts/canonical-vectors.mjs --check
node native/scripts/allocation-vectors.mjs --check
node native/scripts/project-vectors.mjs --check
node native/scripts/qualification-vectors.mjs --check
node native/scripts/check-rust-spec-bindings.mjs
```

The binary test clears PATH, launches native HTTP, submits a request, kills the
process and verifies the original receipt after restart. The offline Matrix SDK
proof tests encrypted device persistence and strict cross-signing; it does not
contact a homeserver. The offline proof uses dev dependencies; hagency-matrix uses the SDK as a
production library dependency, but neither is linked into the current `hagency` binary. SQLite is bundled; other native library
requirements still need a final packaging audit.

Canonical vectors execute the pure encoder from the pinned existing JS source.
The native encoder currently accepts JSON-safe integer DTOs, strings, arrays,
objects and null. It rejects fractional/unsafe numbers and prototype properties;
it is not a general Matrix canonical JSON replacement. Matrix crypto uses its
SDK's own encoder.

[State boundaries and remaining gates](../knowledge/decisions/adr-028-native-state-ownership.md)
explain the transaction model, bounded work, platform requirements and recovery.
[Source inventory](fixtures/legacy-inventory.json) now records 138 explicitly classified
helpers, 199 Express routes plus 3 middleware registrations, 12 custom dispatcher
branches, CLI/MCP declarations and the Next proxy surface. Run
`node native/scripts/inventory.mjs --check` with development dependencies installed.
The [inventory review](../docs/reviews/2026-09-10-native-migration-inventory.md) records
source links, detector limits and remaining M0 gates. Every row remains
`parity-unverified`; source classification does not prove native implementation.

M2 now includes a single `domain.sqlite3` owner for project bindings, immutable
request identities, resource reservations, decisions and provisioning/retirement
intents. The core verifies adapter-supplied room observations (including exact
source content and the encrypted private owner room); those observation types
cannot be deserialized by HTTP. Actual authenticated observation collection is M5.
Full observations remain in private audit storage, never public projections.

Two simultaneous approvals recheck capacity inside one transaction. An outbox
write failure rolls the reservation back. Started effects become uncertain on
restart, retain their allocation, and cannot be claimed again until reconciled.
Revocation fences provisioning and records retirement separately; confirmed failed
retirement requires explicit retry. These are tested with fixture observations,
not actual Matrix account/process creation. No effect worker executes externally.

Resource budgets match29 JavaScript vectors; Unicode names, public IDs and runtime
identity derivation match38 identity vectors. Native qualification embeds the existing
`lib/role-capacity.json` and compares99 model profiles plus18 ranking cases against
JavaScript. Resource input specifies framework/model/provider/reasoning, and the
API rejects supplied role lists. Catalog roles are derived, explicit role withdrawal
persists, and cross-family review requires active Agents on the same registration.
Changing the model/provider/reasoning of an allocated pool is refused. Native schema2
adds role publication through an atomic migration; older role caches grant nothing.
Framework detection, legacy role-only allocations, safe generation-rotation
reconciliation and continuous retention remain open implementation work. See the
[checkpoint review](../docs/reviews/2026-09-10-native-domain-checkpoint.md).

The M3 kernel adds canonical tasks, sessions, dispatches, resource leases, mutation
receipts and task event outbox to the same database through schema migration 3.
Private runner capabilities use OS randomness and stored hashes, are fenced per
attempt, and require a current active allocation. Task mutations require a started
runner bound to that exact task. Coordinator reads include its own session's
creations, without authority to mutate another assignee. Task completion is explicit
and advances its authorization epoch; runtime output never marks a task done.

Dispatch input is frozen before launch. Parked dispatches retain their resource
leases. On restart or expiry, unstarted attempts may requeue; started work becomes
unknown, quarantines its session and marks writable resources dirty. Only a host
inspection command can create a distinct recovery instruction. Earlier queued
instructions are superseded, and late output is retained as rejected audit input.
An already completed task remains complete if only its result needs recovery.

Five new native tests cover all 25 JavaScript transition-policy pairs, capability
scope, transactional rollback/replay, restart/expiry and concurrent resource claims.
These are kernel tests using fixture allocations. Host session binding, inspection
and process ownership still require the real transport/runtime adapters; no HTTP
route exposes fixture authority or recovery. Mailbox/graph/delegation and reply
outbox delivery are still open M3 work. A task event outbox is not proof of Matrix
delivery. No native runner is launched by this checkpoint.

Schema 4 adds canonical conversation uniqueness and message/input ownership.
Each source event has one content-bound identity and an independent projection
for every eligible session. Fresh native state uses committed arrival sequence
for total ordering; the external timestamp is retained as source data. Inbox reads
are bounded and do not acknowledge messages. A dispatch claims selected admitted
input and freezes the inbox payload in the same transaction; ordinary work requires
at least one wake input. A runner can read only its own frozen inbox.

Completion acknowledges only that session's input. Unknown work retains its input
for inspected recovery; superseded unstarted work releases its input back to the
pending inbox. Quarantined sessions can still receive messages. Failed admission,
enqueue, processing and schema migration are covered by rollback tests. The
non-deserializable ingress command is a host adapter boundary; real Matrix event
authentication and mention/DM classification are still required from M5. This
checkpoint does not implement room history, group management or task delegation.

The private runner API is available at `/api/native/v1/runner` when the domain
store is configured. It requires the exact loopback Host, a bearer runner secret,
and `X-Hagency-Dispatch`, `X-Hagency-Runner`, `X-Hagency-Fence` headers. Duplicate
headers, URL credentials and browser/forwarded requests are refused. Operator
credentials do not authorize this surface; runner credentials do not authorize
resource management. Responses use `Cache-Control: no-store`.

| Route | Operation |
| --- | --- |
| `GET /tasks` | Page the bound task and this session's coordinator creations |
| `GET /tasks/{id}` | Read a visible task |
| `GET /tasks/{id}/comments` | Page comments for a visible task |
| `POST /tasks/{id}/operations` | Submit a call ID and typed task mutation |
| `POST /delegations` | Create a scoped task intent for a project Agent |
| `POST /conversations` | Create an internal conversation with current project participants |
| `GET /conversations/{id}` | Read a conversation from its exact creator/participant session |
| `POST /conversations/{id}/operations` | Change members or close an internal group as its current exact creator |
| `POST /peer-messages` | Send a scoped peer message to current internal recipients |
| `GET /peer-inbox` | Read the current dispatch's frozen peer input |
| `GET /inbox` | Page only the current dispatch's frozen input |
| `POST /final-replies` | Persist bounded final content for the exact canonical Done task epoch |
| `GET /final-replies/{id}` | Read a scoped metadata-only reply receipt |

A mutation body is `{"call_id":"heartbeat-1","operation":{"action":"execution","heartbeat":true}}`.
The domain writer obtains its own clock after body reading and queueing, then
rechecks current authority. There is no runtime-supplied clock, author or arbitrary
endpoint command. Claim/start/recovery, session admission and configuration remain
host operations. The `runner_task_api` capability describes this interface;
`agent_execution` remains false until real native runner adapters are available.

The native task helper uses that same API and domain writer:

```sh
hagency task get
hagency task --call-id heartbeat-1 heartbeat
hagency task --call-id wait-1 wait --reason "Waiting for source" --until 2030-01-01T00:00:00Z
hagency task --call-id resume-1 resume
hagency task --call-id done-1 done
```

The host must provision `HAGENCY_RUNNER_API_ADDR` (literal loopback socket),
`HAGENCY_RUNNER_CAPABILITY` (private scoped JSON) and `HAGENCY_TASK_ID` in the
runner's inherited environment. No operator-token fallback or credential file is
used. The launcher integration that provisions these values is still to implement.
`start` records a heartbeat of the host-started task; it never creates another
task. `comment --text` adds a canonical task comment. Every mutation requires an
explicit call ID, and the response is one JSON task result with its replay status.

The client has a five-second total deadline, a 16 KiB request/header-buffer bound,
32 response headers and a 64 KiB response limit. It follows no redirects, resolves
no arbitrary DNS and uses no environment proxy. Lost mutation responses stay
unknown: inspect the task or retry the identical command and call ID. Raw remote
error bodies and credentials never appear in its diagnostics. Local fixtures test
the executable and actual loopback API, including task scope, parking, idempotent
replay, malformed/oversized responses, stalled bodies and cancellation closure.

Pure reusable permission-scope derivation matches 64 JavaScript policy/path
vectors. Candidate scopes alone do not grant permission. Schema 13 stores private owner
verdicts and scoped grants; actual runtime application and effective sandbox
qualification remain required. Verified task-notice sends now commit Sending
before returning a frozen host snapshot. A lost response, lease expiry or restart
keeps possible sends Uncertain; only exact host inspection can resolve them.
Retired routes, task epochs and explicit cancellation never reactivate from a
late delivery or NotSent receipt. The actual Matrix adapter must still coordinate
current membership, encryption recipients and cancellation before IO.

Schema 5 connects task metadata, admitted source inputs, canonical conversation
binding and an acknowledgement outbox in one transaction. Tasks remain pending
until an exact current transport claim receives its content-bound room/server/
transaction receipt. The acknowledgement event is an activation anchor; the
conversation still uses the original source event as its thread root. Stable
Matrix transaction IDs survive retry/restart. Permanent failures require an
explicit host retry; inactive allocations cancel their unsent notices.

Delegation uses the started creator capability, same project allocation and
creator-owned source inputs. Runtime JSON cannot supply a transport receipt or
owner assertion. Child tasks retain independent input processing and do not
complete their parent. Taskless dispatches cannot bypass a pending task binding.

A completed task stays done while fresh human follow-up is queued or leased. At
start, the shared readiness predicate requires an attached, unprocessed wake
input from the original sender and thread, with receipt and origin timestamps
after completion. Other senders, non-message peer events and old input cannot
reopen it. Start atomically advances the task epoch and queues one continuation
notice. Previous capabilities remain fenced by dispatch ownership.

These are task orchestration and private API tests using fixture Matrix data.
The real M5 adapter must authenticate source identities, classify agent traffic,
verify current membership and apply DM/promotion privacy before constructing host
commands or delivering notices. This step does not claim transport delivery,
model execution, filesystem write authority or full M3 parity. Graph scheduling,
final replies and internal group/MCP surfaces remain subsequent migration work.

The pure graph planner preserves dependency propagation, conditional skips,
primitive JSON equality (including missing versus null), truthiness and stable
node order. It produces an uncommitted transition with dispatch candidates; the
caller must atomically bind those candidates to canonical tasks and durable
mailbox admission before storing them. Host observations are separate from graph
request definitions. Graphs permit at most 128 nodes; each result is at most
64 KiB UTF-8 and depth 64, retaining fractional values. Conditions that introduce
cycles are rejected before planning, including cycles hidden outside depends_on.

The existing JavaScript policy generates 156 condition vectors and ten graph
transition vectors; CI checks the fixture against that policy before Cargo tests.
Prototype methods are modeled only as inert comparison/truthiness values and
blocked path segments remain blocked. No JavaScript code is evaluated in Rust.
Durable graph storage, canonical observation authority, group/mailbox routing and
native graph execution are not implemented by this pure policy step.

Execution payload encoding now accepts finite fractional values and follows
JavaScript IEEE-754 Number semantics, including rounding beyond the safe integer
range. Enqueue stores that canonical representation and hashes those exact bytes,
so a retry cannot hash one numeric value while running another representation.
Authority DTO encoding remains a separate strict integer path; token counts,
generations and timestamps retain their explicit typed bounds. Prototype fields
and excessive nesting remain rejected. Identifiers remain strings.

The pinned [ryu-js 1.0.3 formatter](https://docs.rs/ryu-js/1.0.3/ryu_js/)
provides ECMAScript shortest formatting through its safe finite-number API.
It adds no default runtime dependencies; its Apache-2.0/BSL-1.0 license and Rust
1.71 minimum were checked. serde_json float_roundtrip preserves parsed doubles.
CI compares 271 deterministic numeric payload vectors against the unchanged JS
canonicalizer; store tests cover numeric content conflict and restart replay.

Schema 6 adds explicit internal conversation routes. Matrix bindings retain their
room/thread wire format; internal bindings carry kind=internal and a conversation
ID, with no room fields. Both share canonical tasks, runner attempts, leases and
restart recovery. Internal routes cannot receive Matrix input or use its inbox
API. Mixed/unknown wire shapes fail, and Matrix uniqueness is preserved through
migration. All session loads check current allocation and internal membership.

A started runner creates a bounded same-project conversation using a call ID,
label and participant engagement IDs. The creator Agent is included automatically.
Conversation identity, content receipt and every participant session commit in one
transaction. Access is limited to the exact creator session or the internal session
bound to that conversation; another Matrix session for the same Agent is refused.
Completed tasks cannot create conversations. Revocation invalidates the affected
participant's existing execution capability. Conversation creation does not deliver
messages. Schema 7 supplies durable peer delivery and exact-session input receipts;
schema 8 scopes inspected completed-result reports to the original task epoch.

Schema 9 adds internal group membership and closure. Submit a body such as
`{"call_id":"members-1","expected_revision":0,"action":{"kind":"members","participant_engagements":["engagement_id"]}}`
or `{"call_id":"close-1","expected_revision":1,"action":{"kind":"close"}}`.
Membership is the complete desired set plus the creator's engagement. Mutations
require a current started creator capability; stale revisions and changed retry
payloads fail. Receipts return the original operation response, while reads obtain
the current active group. Closed groups cannot be reopened.

Removed participants retain history and get fresh sessions if added again. Closure
also closes groups created by the retired sessions. Obsolete dispatches lose their
capabilities; started work retains leases and a durable host stop intent until the
host has inspected actual process termination and workspace effects. Settlement
never marks tasks done or acknowledges input. Pending stops count against runner
capacity and survive restart. The host methods are deliberately absent from the
runtime API. See [ADR-030](../knowledge/decisions/adr-030-native-conversation-retirement.md).
These transactions do not implement Matrix room membership or actual process
termination; native runner adapters and final delivery remain.

Schema 10 binds durable task graphs to canonical tasks and peer inputs. The private
runner API accepts `POST /graphs` with a call ID, conversation ID and bounded graph
definition. Assignees are exact current internal participant session IDs. Creation
commits all canonical node tasks; dependency planning admits only ready assignment
messages. Host execution must bind the assigned task and message together. Runtime
definitions cannot supply owner identity, workspace grants or inspection evidence.

The exact creator can list metadata with `GET /graphs`, read `GET /graphs/{id}`,
and submit `POST /graphs/{id}/cancel` with a call ID. Bound node runners submit
`POST /graphs/{id}/results` with call ID, node ID and a typed complete or failed
outcome. Success requires explicit canonical done state for that exact task epoch;
failure requires blocked state. Graph state never completes the parent task.
Command receipts and dependent assignments commit atomically. Inspected report
recovery can repeat the exact completed result without rerunning the node.

Results stay outside graph views and assignment payloads. Workers page their
pinned references through `GET /graphs/{id}/dependencies?after=0&limit=32`, then
read one with `POST /graphs/{id}/dependencies` and `{"node_id":"dependency"}`.
Only the creator may read other completed node results. Each result is at most
64 KiB; dependency pages are at most 32 references. Cancellation or scope retirement
fences execution while retaining uncertain process custody for host inspection.
Lease expiry and restart retain unknown readers' leases and concurrency slots;
inspection releases only that attempt's custody. The migration also restores
missing unknown leases left by earlier native versions. Retired assignment history
is retained without consuming live queue capacity or fabricating an acknowledgement.
See [ADR-031](../knowledge/decisions/adr-031-native-task-graph-custody.md). Model
execution, MCP graph tools, final reply delivery and production parity remain open.

Schema 11 freezes Matrix server, room, sender/device, owner, explicit privacy and
generations before a fresh session receives reply authority. Legacy sessions are
not upgraded from current room state. Full member snapshots and negative evidence
retire old sessions and pending replies; restored access needs a fresh session.
DM promotion also fences sessions with a null thread root.

Final content uses `{"call_id":"final-1","body":"Completed result"}`. Admission
requires the exact canonical Done epoch or an inspected report grant and creates
one immutable intent per task epoch. Host claim, send-start, observed delivery and
inspection are separate operations. Possible sends remain uncertain after restart
or cancellation. A later NotSent inspection cannot revive explicitly cancelled
output. Runtime receipts expose no route, private owner room or transport token.
See [ADR-033](../knowledge/decisions/adr-033-native-final-reply-custody.md) for the
remaining verified-ingress, taskless, room-admission and live-transport boundaries.

The `hagency-runtime` crate implements bounded Codex 0.153.4 JSONL protocol state
and an asynchronous driver for host-owned streams. A complete write and flush is
a transport receipt only. Cancellation, timeout, EOF and queue pressure close the
connection with unresolved progress; they prove no process cleanup or task result.
Protocol requests and events cannot grant approval. The crate remains unlinked
from Agent execution; typed session, sandbox and guardian integration are open.
See [ADR-032](../knowledge/decisions/adr-032-native-codex-protocol.md) and
[ADR-034](../knowledge/decisions/adr-034-native-codex-transport.md).

## Native MCP task maintenance

`hagency mcp` serves five task tools over stdio: get_task, accept_task,
transition_task, comment_task and update_task_execution. The host must supply
the same inherited HAGENCY_RUNNER_API_ADDR, HAGENCY_RUNNER_CAPABILITY and
HAGENCY_TASK_ID context as the native task CLI. Each call names that assigned
task; mutations additionally require a stable call_id, preserved for an exact
retry across MCP connections. State changes go through the existing scoped API.

This helper advertises MCP 2025-11-25 tools only. It bounds newline frames and
request IDs, serializes tool calls, and uses a private executable watchdog for
partial input and blocked output. Exit 74 means its IO deadline expired; it does
not prove that a submitted mutation failed. Inspect or repeat the exact call ID
and content through the canonical writer. The watchdog is not linked as a public
library service function. The pinned Rust MCP SDK is a test-only dependency.

Delegation, graphs, files, approvals, generated runner configuration and live
rollout are separate work; existing deployed MCP configuration is unchanged.


Schema 15 and [ADR-047](../knowledge/decisions/adr-047-native-matrix-transport.md)
add authenticated Matrix observation collection. Exact whoami account/device
matching precedes encrypted SDK bootstrap. Bounded HTTPS sync and full room state
feed the domain writer, which atomically fences stale sessions, grants and
possible notice/final sends after negative transport or shared-room evidence.
A stale failed request cannot retire a newer incarnation.

The collector owns SDK state, crypto and an explicitly encrypted sync journal.
An interrupted pending response is retained and requires inspection; completed
cursors are not assumed to prove SDK application. The current bounds are 16
host-pinned rooms and 64 completed sync receipts, with finite HTTP/storage/queue
budgets. Capacity exhaustion is visible. Room-set rotation, pending-sync recovery,
continuous retention, event provenance, key publication and encrypted sends remain
separate gates. No live device or service is connected by this checkpoint.
