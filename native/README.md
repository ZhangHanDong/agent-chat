# Native Hagency migration

This worktree contains native foundation and selected-resource domain checkpoints. It is **not a
replacement for the deployed Hagency application**. Resource allocation, Agents,
Palpo transport, the console API and Matrix chat still run in the existing JS/TS
implementation. Native capability responses explicitly mark these unavailable.

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
fixture HTTP routes; there is no native runner or authenticated Matrix transport yet.

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
contact a homeserver. Crypto proof dependencies are dev dependencies and are not
linked into the current `hagency` binary. SQLite is bundled; other native library
requirements still need a final packaging audit.

Canonical vectors execute the pure encoder from the pinned existing JS source.
The native encoder currently accepts JSON-safe integer DTOs, strings, arrays,
objects and null. It rejects fractional/unsafe numbers and prototype properties;
it is not a general Matrix canonical JSON replacement. Matrix crypto uses its
SDK's own encoder.

[State boundaries and remaining gates](../knowledge/decisions/adr-028-native-state-ownership.md)
explain the transaction model, bounded work, platform requirements and recovery.
[Source inventory](fixtures/legacy-inventory.json) records 112 entry/helper candidates
and 201 literal routes from the pinned baseline; dynamic registration and helper
classification remain open M0 work. No inventory row is marked ported merely
because the native HTTP server starts.

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
| `GET /inbox` | Page only the current dispatch's frozen input |

A mutation body is `{"call_id":"heartbeat-1","operation":{"action":"execution","heartbeat":true}}`.
The domain writer obtains its own clock after body reading and queueing, then
rechecks current authority. There is no runtime-supplied clock, author or arbitrary
endpoint command. Claim/start/recovery, session admission and configuration remain
host operations. The `runner_task_api` capability describes this interface;
`agent_execution` remains false until real native runner adapters are available.

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
messages: durable peer mailbox, group lifecycle and graph-task linkage remain open.
