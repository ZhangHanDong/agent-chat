# September review closure

The confirmed implementation findings have local fixes and regression evidence
on `fix/spec-review-closure`, based on `75ca1ecbf8c4623359094f000fa4968693f4a27e`.
**Full project sign-off remains open:** deployed Mini/Palpo workflow evidence,
released Agent Operations client interoperability, and the conflicting approval
channel decision are still outstanding.

The [original review](2026-09-05-spec-gap-review.md) remains unchanged as historical
evidence. This report describes the resulting implementation, rather than
reinterpreting the earlier failures as passes.

## Finding disposition

| Finding | Disposition and evidence |
| --- | --- |
| F1: Codex releases resources before exit | Fixed. Successful settlement waits for confirmed guardian cleanup and closed communication channels. The delayed-shutdown test holds the workspace lease while the runtime can still write. |
| F2: ordinary runtime descendants survive | Fixed for the owned process group. Normal exit also terminates descendants, including children with independent stdio. Bounded cleanup failure produces `outcome_unknown` and quarantines the workspace. Escaped children holding a pipe exercise that failure path; arbitrary daemonization outside the owned process group is not certified. |
| F3: wrong-side and retired selection | Fixed in implicit/explicit engagement selection, pool selection and thread-session retirement checks. Incomplete provisioned agents remain excluded after cancellation. |
| F4: unknown seat periods auto-approve | Fixed. Unknown or incomparable quota periods require approval; zero is a valid exhausted quota. |
| F5: redaction merges API-key seats | Fixed. Seat identity comes from raw credential records before DTO redaction. Distinct keys remain separate without appearing in responses. |
| F6: missing owner commits active success | Fixed. Missing ownership leaves the request pending without allocation. A configured project side cannot use the provider bootstrap owner; its borrower binding or an explicit operator verdict owner is required. |
| F7: replay charged twice | Fixed. Canonical request replay precedes selection and budget admission, including padded room IDs. Changed-body reuse remains a conflict. |
| F8: provenance faults acknowledged | Fixed. Invalid internal mode/side/registration metadata remains retryable, with no transaction completion or sync cursor advance. |
| F9: body selects transport | Fixed. Push, edge and sync supply transport metadata outside the event body. |
| F10: resource request only produces a hint | Implemented for local Claude/Codex resources on appservice and registration-token sides. Approval durably reserves capacity, provisions a real home, obtains the identity, binds its borrower, joins, and launches or makes the agent ready for thread dispatch before new-resource activation. Retry and cancellation tests cover partial setup. Runtime launching is substituted in deterministic provisioning tests; actual multi-agent project work still needs the live gate below. |
| F11: repeated labels stand in for adapter coverage | Fixed. The 24 acceptance scenarios run through actual push, edge and sync adapters, including negative cases. The 99-test provenance file includes multi-instance cases and actual bridge-to-approval-store owner verdict checks. External homeservers remain fixtures. |
| F12: stale acceptance selectors | Fixed. Nine retained selectors were rebound to executable assertions. Four obsolete portal scenarios were withdrawn according to the operator's already-recorded portal retirement, documented in ADR-017. All 174 active selectors resolve. Withdrawn scenarios are not counted as passing. |
| F13: verification/release evidence | Partially closed. Full Vitest, console fixtures and real-model continuity pass. Agent-spec's native Vitest execution and external release/client gates remain explicitly non-passing or unexecuted. See the record below. |
| F14: duplicate inbound credentials select first | Fixed. Anything other than one matching registration returns 403 before dispatch. |
| F15: submit token claims room authority | Fixed. Submit-only callers cannot auto-join, read room whitelist status, or probe side budgets. An authenticated Matrix bridge or operator supplies room authority. |
| F16: requester receives private setup details | Fixed with explicit public DTOs and generic external refusals. Owner MXIDs/DM rooms, environment remedies and internal budget/spend context stay on operator surfaces. |
| F17: deleting one side resolves another's alerts | Fixed. Select exact side identity keys before mutation; budget alerts use exact-key resolution. A prefix-neighbor regression preserves `palpo.test2` when removing `palpo.test`. |
| F18: credential removed before room cleanup | Fixed for known memberships. Removal waits for fulfillment/bridge work, leaves rooms, revokes owned registration-token user tokens, then retires records and removes the side. Persistence/transport failures retain recovery state. Explicit abandonment of unreachable credentials produces an audited partial result. Issuer-managed appservice registrations require issuer-side revocation. |

Further cross-review corrections include the string/object Matrix identity
migration, exact recorded representative MXIDs, reservation accounting before
an agent record exists, cancellation after an in-flight join, rollback on failed
retirement/removal persistence, and consistent cross-family review capacity,
offer, preview and admission results.

## Independent Claude Code Fable review

Claude Code Fable performed the requested parallel review and two static
follow-ups. The [follow-up transcripts](2026-09-05-claude-fable-closure-review.md)
are preserved, with their scope limits. Fable executed no tests or live services.

The first follow-up's R1–R10 drove additional corrections. The second follow-up
identified N1–N6. N1 now waits for guardian `close`, which drains IPC before
examining cleanup confirmation. N2 returns an explicit pending bridge-admission
outcome. N3 has an operator-only, audited abandonment path for irrecoverable
credentials while transient failures continue to block removal. N4 retains an
unexpected minted identity's credential for recovery. N6 no longer places
operator spend context in an automatic borrower's refusal.

N5 describes the unavoidable non-transactional boundary between remote account
creation and local token persistence. The durable command records intent before
registration; `M_USER_IN_USE` is visible in the operator job list if the token was
lost in that crash window. That case requires homeserver administrator recovery
and remains pending. Password derivation and silent recreation are not used.
This is documented recovery behavior, not a claim of unattended crash recovery.

## Verification record

| Check | Result |
| --- | --- |
| Full `npm test` | **226 files passed; 3,783 tests passed, one skipped**, 346.05 seconds. The platform skip is not counted as a pass. |
| Active spec binding check | **174 selectors, zero missing**; also added to CI. |
| Latest focused runtime/provenance/admission run | **154 tests passed** across five files; later cleanup edge cases also passed, and are included in the full run. |
| Console fixture verification | **110 static/rendered checks and 39 browser checks passed**, against an isolated local fixture console. Browser checks use the repository's Puppeteer harness. |
| Real-model thread continuity | **5/5 passed** with Claude Code 2.1.247 / `claude-fable-5`; fresh CLI process per turn, database reopened before recall. [Prompts, results and runtime hashes](2026-09-05-thread-continuity.json). |
| Router build and ESLint | Passed. Tracked router JavaScript regenerated from TypeScript. |
| CI wrapper | **Passed**, including route ownership, syntax/lint, dependency boundaries, router type/build, remote package and kernel/CLI checks. Optional deployed multi-side and agent end-to-end checks skipped without an explicit runtime. |
| Agent-spec 1.4 | Contract quality **100%**; explicit relative change boundaries pass. **21 scenarios skipped** because this lifecycle does not execute Vitest. Strict lifecycle exits nonzero for these skips; it is not an acceptance pass. |

Agent-spec's change-scope path extraction required explicit relative `--change`
arguments, and root JSON boundary names required `./package.json` spelling to
be recognized. Neither workaround widens the permitted files. Native lifecycle
output and separately executed Vitest evidence remain distinct.

An earlier full run encountered ENOSPC in Vitest's transformed-module cache and
was discarded as an invalid validation run. A later run exposed fixture ownership
assumptions and the spend-explanation regression; those were corrected before the
clean full run. Prior intermittent socket/response failures did not recur in the
clean run; this does not establish a root-cause fix for every historical flake.

After the full run, the new Matrix work routes were added to the ownership
manifest and its five regression tests passed. CI then passed. A final readiness
persistence refinement prevents pruning old engagement history from disabling a
completed reusable agent; the 18-test closure suite was rerun against that change.

## Remaining sign-off inputs and limits

1. **Remote Mini / Palpo:** the SSH alias/hostname and Palpo base URL requested
   during implementation are still needed. Run a uniquely tagged, live flow:
   contribute/define → request and fulfill → model-produced artifact → delegate
   to a second agent → return and integrate the artifact → denial/crash/retry →
   withdrawal. Capture Playwright UI evidence alongside Matrix event IDs,
   dispatch/task transitions, process termination and artifact assertions.
2. **Approval channel:** the project/owner-approval contracts require private
   actionable controls, while ADR-016's later text puts them in the borrower
   project room. The pending operator choice is borrower private approval DM or
   borrower project room. Borrower ownership is now enforced; public actionable
   controls remain disabled until that conflict is settled.
3. **Agent Operations release:** the canonical manifest remains `development`.
   Actual released external client/Robrix interoperability was not established
   here. A schema check or fixture browser pass cannot satisfy that release gate.

[ADR-018](../../knowledge/decisions/adr-018-review-closure-recovery.md) documents
provisioning recovery, credential ownership, cleanup order and explicit partial
outcomes. Existing-agent legacy admission still reports its separate room result;
new-resource activation uses the full provisioning gate. No production service
was deployed or restarted for this closure work.

Detailed local logs are in
`/Users/yuechen/Library/Caches/hagency-closure/2026-09-05/`, including
`full-tests-final.log`, `verify-ci-final-2.log`, `console-verify-final.log`,
`spec-bindings-final.log`, `lifecycle-handoff.json`, and the real-model reports.
