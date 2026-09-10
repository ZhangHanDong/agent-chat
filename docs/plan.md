# Native migration working plan

This is coordination, not canonical runtime task state. There is no provisioned
`task-writer` in this source checkout. User instruction: execute the Rust migration
in a clean worktree. Branch `feat/rust-migration`; baseline `5dbef22`.

1. M0/M1 first checkpoint: native Salvo process, protected fresh state, custody,
   recovery, bounded work, shared protocol vectors and offline encrypted SDK proof.
2. Verify native CI on Windows, macOS and Linux, plus existing build-tool coverage.
3. Continue M0's complete dynamic endpoint/helper classification, supported runtime
   versions and measured device budgets. Run early process-tree/sandbox proofs.
4. M2 selected-resource domain checkpoint now implements verified-observation
   admission, one-transaction reservations/outbox and uncertain-effect recovery.
   Model qualification, derived catalogs and scoped cross-family checks now use
   the shared policy. Complete legacy/project-side/rotation integration.
   The M3 task/dispatch kernel now shares the domain database: current capabilities,
   atomic mutation receipts, frozen payloads, resource leases and conservative
   restart recovery. Canonical session resolution, per-session message projections
   and atomic dispatch input claims are now implemented in schema 4. Continue the
   internal group/MCP surfaces, task dependencies and durable final replies.
   Schema 5 now provides canonical task metadata, input activation through a
   fenced notice outbox, scoped delegation and start-time human follow-up. The scoped runner HTTP API now exposes task reads,
   comments, mutations and frozen inbox through the bounded writer, using its
   execution-time clock. The pure graph planner now matches the existing dependency policy using
   JavaScript-derived vectors. Schema 6 now provides explicit internal routes and atomic scoped conversation
   admission. Add durable peer mailbox, group lifecycle and atomic graph/task
   linkage before graph execution.
   Real runner adapters still need the early platform ownership and sandbox proofs.
5. Continue M3–M9 in the migration plan; keep production deployments independent
   until every cutover gate is met. A foundation build is not full migration parity.
