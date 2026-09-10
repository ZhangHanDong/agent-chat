# Native Hagency migration

This worktree contains the first executable migration checkpoint. It is **not a
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
owner-private `operator.token` and a fresh custody database; it refuses nonempty
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

Checks:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --all-targets --locked
node native/scripts/canonical-vectors.mjs --check
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
