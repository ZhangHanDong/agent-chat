# Repository audit — 2026-09-05

Latest update: the operator subsequently requested closing the findings. The fixes
and their evidence are recorded in the
[closure report](reviews/2026-09-05-review-closure.md), on
`fix/spec-review-closure`. Full Vitest passed **226 files / 3,783 tests**, with one
platform skip. Console fixtures passed **110 static/rendered and 39 browser
checks**; the final runtime passed **5/5 real-model continuity conversations**.
The CI wrapper passed; the final readiness persistence change passed its 18-test
closure suite. Agent-spec boundary verification passed with 21 lifecycle skips
because its verifier does not execute Vitest.
Claude Code Fable supplied two further independent static reviews, preserved
alongside the closure report. The full deployed workflow, external Agent
Operations release evidence and conflicting approval-channel decision remain open.

The text below records the preceding audit, before implementation.

This is an observation report, not canonical control-plane task state. The source
checkout has no provisioned `./task-writer` or agent-home project manifest.

Requested work: pull the latest HAFleet and assess completion against the planned
specification. `git pull --ff-only` advanced `master` from `0b1193d` to
`75ca1ecbf8c4623359094f000fa4968693f4a27e` in `/Users/yuechen/home/hagency`.
The checkout was initially clean. No implementation or test source was changed.

**Verdict: the project cannot be signed off as fully complete against its current
contracts.** Much is implemented and tested, but a reproduced behavior contradicts
the latest contract, acceptance coverage is incomplete, and release evidence is
still outstanding. This audit does not assign a completion percentage: passing
test counts are not a measure of fulfilled requirements.

## Findings

1. **Transport-provenance errors can be acknowledged instead of retried.**
   [The side-provenance contract](../specs/task-side-provenance.spec.md) (lines 54,
   114–125) requires missing, invalid, or inconsistent adapter provenance to produce
   retryable `invalid_transport_provenance`, HTTP 500, and no completed transaction,
   edge acknowledgement, or sync cursor advance. However,
   [lib/side-provenance.js](../lib/side-provenance.js) (lines 60–78) classifies an
   invalid mode, mismatched side, or mismatched registration as terminal
   `provenance_mismatch`. [bridge-matrix.js](../bridge-matrix.js) (lines 4401–4436)
   consumes that terminal result, allowing the receiver to remember the transaction
   and return 200. A local HTTP probe through the real listener, router, and bridge
   ingress, with a controlled internal provenance fault after authentication,
   reproduced 200 on both delivery and replay for all three inconsistent-context
   cases. Missing provenance correctly returned 500. Every case made zero typed
   business calls and zero event claims; the defect is acknowledgement/retry
   behavior, not demonstrated unauthorized execution. An internal wiring fault can
   therefore discard work that the contract requires retaining for retry.

2. **The side-provenance tests do not prove the promised scenario matrix.**
   The contract's binding instructions (line 57) require each of its 24 named
   scenarios through actual push, edge, and sync adapters. The test named
   `side_provenance_missing_or_inconsistent_context_keeps_batch_retryable` explicitly
   expects inconsistent provenance to succeed without throwing, contrary to its
   acceptance text ([tests/side-provenance.test.js](../tests/side-provenance.test.js),
   lines 165–201). The later `r5_all_spec_titles_across_edge_and_sync` test (lines
   1304–1365) loops over all 24 labels but uses the same valid-room, valid-credential,
   successful-message fixture each time; the label only changes the event ID. It
   does not inject the corresponding negative condition or multi-instance setup.
   These green checks cannot establish the required negative-case coverage.

3. **Executable contract bindings and requirement links have drifted.**
   Of 157 declared `Test:`/`Filter:` selectors, 13 match no registered test title.
   Some corresponding behavior exists under different names, so this is not a
   claim that all 13 behaviors are missing. Nevertheless, those exact acceptance
   bindings select no evidence. The sync-intake contract also declares
   `satisfies: REQ-AGENT-OPS-MATRIX-INTAKE`, for which no defining knowledge artifact
   or requirement statement was found. The checked-in traceability baseline is
   historical and cannot establish current coverage.

4. **Release completion remains unproven.**
   [The accepted thread-session requirement](../knowledge/requirements/req-thread-scoped-agent-sessions.md)
   requires a five-run, three-turn real-model continuity probe with at least four
   successes. [docs/THREAD-SESSIONS.md](THREAD-SESSIONS.md) (lines 3–10, 62–71)
   records a local canary but explicitly says this probe has not run and blocks
   non-local release. No superseding result was found in the reviewed repository.
   The [Agent Operations manifest](../specs/fixtures/agent-ops-client-v1/manifest.json)
   still has `release_status: "development"` and `source_commit: null`; its passing
   integrity check is not evidence of a released client contract.

5. **Local full regression verification is not clean.**
   `tests/api-engagement-room-admission.test.js` failed during fixture setup:
   `POST /api/framework-presets` expected 200 and received 404, before the selected
   room-withdrawal assertion ran. The exact test passed on an isolated rerun; the
   cause remains unresolved. `tests/hafleet-up-selfcheck.test.js` failed and failed
   again in isolation because lines 57, 59, and 76 hardcode `/usr/bin/tmux`, which
   does not exist on this Mac; the installed executable is `/opt/homebrew/bin/tmux`.
   The one skipped full-suite test is the non-macOS refusal case in
   `tests/install-macos.test.js`, skipped on macOS.

## Verification

The root dependencies were installed from the pulled lockfile using `npm ci`.
The ignored `remote-dist/` snapshot was initially stale and was rebuilt with
`npm run build:remote`; its subsequent checks passed. This was a generated-artifact
refresh, not a source fix. Local runtime: Node v24.10.0, npm 11.6.0, macOS.

| Check | Result |
|---|---|
| Latest-commit GitHub CI | Lint and full-test jobs passed on Node 22.22.0: [run 33992646874](https://github.com/hagency-org/HAFleet/actions/runs/33992646874) |
| Full local `npm test`, with JSON reporter | 223 files: 221 passed, 2 failed; 3,702 tests passed, 2 failed, 1 skipped; 351.07 seconds |
| Separate Vitest run using the literal contract selectors as escaped name filters | 149 tests passed; 13 selectors matched no title. The 3,556 filtered/skipped tests are not passing evidence from this run |
| Syntax, ESLint undefined-identifier check, CLI contract | Passed |
| Architecture and dependency boundaries | Passed |
| Router typecheck, import boundary, generated build check | Passed |
| Remote source snapshot, source sync, generated package smoke | Passed after rebuilding ignored `remote-dist/` |
| Agent Operations artifact integrity | Passed, explicitly in development status |
| Contribution console `npm run verify` | 110 rendered/static checks and 39 browser checks passed against a temporary localhost fixture-mode console; this does not prove live backend integration |
| `npm run verify:ci` wrapper | Could not start: GNU `timeout`/`gtimeout` absent. Available static/build gates were run directly; no claim that the local wrapper passed |
| `agent-spec parse`, lint, lifecycle | Not run: `agent-spec` unavailable on PATH and absent from checked installation locations. The repository also documents the older Cargo-only lifecycle limitation for Node |
| Live Matrix/model/federation and deployment release checks | Not run; external behavior is not certified by the local fixture tests |

The temporary console was stopped after verification. Logs, JSON test reports,
the binding audit, and the local provenance-probe output are retained under
`/Users/yuechen/Library/Caches/hafleet-audit/2026-09-05/`.

### Contract binding inventory

“Resolved” means the selector matched an executed test title; it does not mean
the test proves every clause of its scenario, as finding 2 demonstrates.

| Contract | Resolved selectors | Declared selectors |
|---|---:|---:|
| Project baseline | 4 | 4 |
| Agent Operations client access | 18 | 18 |
| Appservice sync intake | 8 | 8 |
| Matrix DM privacy | 6 | 6 |
| Matrix thread continuity | 10 | 10 |
| Owner UI approval | 17 | 21 |
| Project board | 10 | 18 |
| Side provenance | 24 | 24 |
| Thread-scoped agent sessions | 47 | 48 |
| Total | 144 | 157 |

Unresolved selectors:

- Owner UI approval: `project room retains independent room-agent approval bindings`;
  `stale crypto store is archived before the token device starts syncing`;
  `launchers_keep_sandbox_defaults_and_wire_only_supported_adapters`;
  `repairs_identical_duplicate_sections_before_codex_parses_the_file`.
- Project board: `project_board_redacts_runtime_secrets_and_paths`;
  `project_board_groups_tasks_by_status`; `project_board_includes_related_task_graph`;
  `project_board_marks_stale_agent_task`; `project_page_renders_board_surfaces`;
  `project_board_proxy_is_read_only`; `project_page_coalesces_refresh`;
  `project_agents_link_to_the_monitor_and_monitor_has_complete_navigation`.
- Thread-scoped sessions: `runner workspace configuration requires operator authority`.

Scope interpretation: accepted `knowledge/` artifacts and the nine current specs
were the baseline. The console integration plan records P0–P4 as implemented.
The older PDU PRD is partly withdrawn and still contains unresolved scope questions;
withdrawn scheduler/pricing work was not counted as missing functionality. The
Octos/remote thread-runner expansion is explicitly a non-normative future roadmap,
so its exclusions were not treated as current implementation defects.

To reach sign-off, first align provenance retry behavior and its real adapter
tests with the accepted contract, repair or formally retire stale acceptance
bindings and resolve the dangling requirement link, address regression reliability
and the portable tmux lookup, then collect the required lifecycle and release
evidence. This audit did not implement those follow-up changes.

## Extended code review

The operator next requested a comprehensive review before live end-to-end testing,
and explicitly requested Claude Code Fable as an independent parallel reviewer.
The detailed findings, accepted-scope distinctions, coverage matrix and proposed
sign-off sequence are in
[the extended report](reviews/2026-09-05-spec-gap-review.md).

The local review added temporary backend API fixtures and real RouterStore/runner
process fixtures. Confirmed effects include leases released while processes can
still write; surviving runtime descendants; incorrect side/retired-agent selection;
unknown seat periods permitting auto-join; independent API keys merging into one
seat; active success despite a missing owner binding; and replay refused after the
original request consumes a side's allocation. A fresh-fleet request with a valid
resource preset still cannot provision its serving agent on approval. An HTTP push
probe also demonstrated that submitted body.mode controls the intake-mode metadata.
These probes used local fixtures and cleaned up their stores, sockets and processes.

Same-revision broad test/build evidence above was reused. No application or test
implementation was edited, and no live Matrix, remote mini, or real task-executing
model workflow was run. Claude Code was separately launched as the requested
reviewer with model claude-fable-5 and read-only file tools; it has no authority to
change the repo or contact project services. Review evidence is under
`/Users/yuechen/Library/Caches/hafleet-review/2026-09-05/`.

Claude Code Fable completed its independent static review successfully. Its original
output is preserved in [the Fable review](reviews/2026-09-05-claude-fable-review.md).
The consolidated report reconciles its findings rather than treating its conclusion
as test evidence. Additional fixtures reproduced ambiguous-token first-match
dispatch, requester-token room claims gaining whitelist admission, private owner/
configuration details in requester responses, and deletion of one side resolving
another side's identity alert. The side-removal membership-cleanup omission was
confirmed by source tracing. Accepted approval-channel documents still conflict;
cross-family review coherence and representative identity composition are documented
with their practical limits. The review is complete; implementation and live
remote-mini/Palpo/model testing remain separate follow-up work.
