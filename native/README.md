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
identity derivation match38 identity vectors. Native qualification currently uses
provider-supplied eligible roles; framework detection, cross-family qualification,
global role withdrawals, legacy role-only allocations, safe generation-rotation
reconciliation and continuous retention remain open implementation work. See the
[checkpoint review](../docs/reviews/2026-09-10-native-domain-checkpoint.md).
