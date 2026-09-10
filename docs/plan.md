# Native migration working plan

This is coordination, not canonical runtime task state. There is no provisioned
`task-writer` in this source checkout. User instruction: execute the Rust migration
in a clean worktree. Branch `feat/rust-migration`; baseline `5dbef22`.

1. M0/M1 first checkpoint: native Salvo process, protected fresh state, custody,
   recovery, bounded work, shared protocol vectors and offline encrypted SDK proof.
2. Verify native CI on Windows, macOS and Linux, plus existing build-tool coverage.
3. Continue M0's complete dynamic endpoint/helper classification, supported runtime
   versions and measured device budgets. Run early process-tree/sandbox proofs.
4. Next implementation contract: M2 selected-resource/shared-seat budgets, project
   authority, content-bound admission, transactional reservation and fulfillment
   outbox in the single domain database defined by ADR-028.
5. Continue M3–M9 in the migration plan; keep production deployments independent
   until every cutover gate is met. A foundation build is not full migration parity.
