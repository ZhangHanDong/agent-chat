# Repository audit knowledge

- **Latest state, 2026-09-05:** the requested fixes are on
  `fix/spec-review-closure`. Read the
  [closure report](reviews/2026-09-05-review-closure.md) before the historical
  audit below. Full Vitest passed 3,783 tests, the console fixture checks passed,
  and real-model continuity passed 5/5. Remote Mini/Palpo end-to-end evidence,
  released Agent Operations client interoperability, and the approval-channel
  conflict remain open sign-off items.
- [ADR-018](../knowledge/decisions/adr-018-review-closure-recovery.md) defines the
  durable engagement reservation, bridge-owned registration credentials, cleanup
  retry/abandonment rules, and provider-owner bootstrap restriction. Matrix work
  results are inspectable through operator-only `GET /api/matrix-work`.
- `agent-spec` 1.4 is installed for this task under the closure cache's `tools/bin`.
  Native lifecycle does not execute Vitest: retain its skipped verdicts and use
  separate Vitest evidence. Explicit relative change paths and `./package.json`
  boundary spelling avoid observed path-extraction limitations.
- Four old portal selectors were withdrawn under the operator's already-recorded
  retirement, rather than recreated. See ADR-017. All 174 remaining active
  selectors resolve through `npm run check:spec-bindings`.

- `/Users/yuechen/home/hagency` is the HAFleet source Git checkout, with origin
  `https://github.com/hagency-org/HAFleet.git`; it is not a provisioned agent-home
  `workdir/projects/` copy. Its root AGENTS.md/CLAUDE.md symlink to workspace templates.
  At the 2026-09-05 audit, `./task-writer`, `docs/projects.md`, and `docs/plan.md`
  were absent. Do not fabricate a control-plane task wrapper or treat these audit
  notes as canonical task state.
- The audit at `75ca1ecbf8c4623359094f000fa4968693f4a27e` is recorded in
  [progress.md](progress.md), with reproducible findings and test evidence. No
  implementation or test source was changed by that audit.
- Green named tests are insufficient evidence of side-provenance contract
  completion at this revision: inconsistent provenance is terminal in code but
  retryable in the spec, and the 24-label edge/sync loop repeats a success fixture.
  Inspect conditions and assertions, not just title matches.
- Exact contract-title reconciliation found 13 unresolved selectors out of 157.
  Several are renamed or combined tests; do not infer 13 missing features from
  that count. The sync-intake spec also references an undefined
  `REQ-AGENT-OPS-MATRIX-INTAKE`.
- A stale ignored `remote-dist/` after pulling is repaired by the normal
  `npm run build:remote` command before checking the generated package. It does
  not by itself establish a source defect.
- The full local suite at this revision failed twice: one fixture-setup 404 that
  passed in isolation, and a reproducible Linux-specific `/usr/bin/tmux` path in
  `tests/hafleet-up-selfcheck.test.js`. macOS tmux here is under `/opt/homebrew/bin`.
- Older planning prose contains superseded and conflicting status claims. Use
  accepted artifacts and current code; do not count the withdrawn PDU scheduler
  and pricing work, or the non-normative Octos/remote runner roadmap, as missing
  current-contract implementation.
- The extended review is in
  [reviews/2026-09-05-spec-gap-review.md](reviews/2026-09-05-spec-gap-review.md).
  Isolated probes at the same revision demonstrated post-settlement runner writes,
  selection of agents from the wrong side or after retirement, auto-join with an
  unknown seat period, merging of distinct API-key seats after DTO redaction,
  successful active engagement state despite missing owner binding, and request-id
  replay failure after side budget exhaustion. These are review findings, not fixes.
- ADR-016 decision 4 remains an unfinished accepted capability: a qualifying
  resource with no existing agent yields only a provisioning hint; approval cannot
  fulfill that request. Do not confuse manual agent creation with on-demand
  resource-to-engagement fulfillment.
- The user requested an independent Claude Code Fable cross-review. It was launched
  on the same revision with read-only Read/Grep/Glob tools, without service access
  or repository mutation. Its output must be cross-checked before adopting findings.
  That review is now complete and preserved in
  [reviews/2026-09-05-claude-fable-review.md](reviews/2026-09-05-claude-fable-review.md);
  the consolidated report records which claims were reproduced, qualified or not adopted.
