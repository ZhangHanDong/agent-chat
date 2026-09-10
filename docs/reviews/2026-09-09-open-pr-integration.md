# Integrate Hagency PRs 154, 155, 156 and 158

The operator requested repairing the four open PRs that conflicted with local
master 212de5f after review closure and PR 157. Work runs in the isolated
integration/open-pr-fixes-20260909 worktree with its own root and console npm
dependencies. Original PR commits are retained; no published history is rewritten.

| PR | Integration resolution | Focused validation |
| --- | --- | --- |
| 154 | Replace the duplicated listener implementation with the awaited IPv4 helper, keeping seeded-runtime isolation, real listener ownership and idempotent close completion. | 88 tests in seven files pass. |
| 155 | Carry structured Claude error results alongside tool activity and heartbeat processing. Keep cancellation and confirmed descendant cleanup as completion gates; retain the authorized resume pump. Rebuild generated runner output. | 30 runner/resume/process tests plus four activity tests pass. |
| 156 | Keep dispatch activity independent of legacy terminal telemetry and execution eligibility. Use projection eligibility for stopped agents, retain the private execution-policy exclusion, and apply the disposable-runtime overlay only to on-demand agents. | 97 tests in ten files pass. |
| 158 | Use the canonical credential-map side ID while retaining representative identity. Preserve approval rollback, reusable authorization and authority digests alongside the trusted router-origin field. Keep both private approval-card and public thread-notice tests. Rebuild router output. | 191 tests in nine files pass. |

PR 156's mechanical merge was first tested and reproduced six failures: the
old runtime overlay replaced hybrid terminal telemetry, and the execution
eligibility check hid stopped-agent ledger activity or dereferenced null.
Both causes are fixed without weakening the hybrid assertions. The existing
disposable-runner projection case now uses the fixture's actual on-demand agent;
all queued, started and parked assertions remain. Legacy terminal behavior is
covered independently by the PR's hybrid cases.

The existing task contracts govern each functional subset. Native agent-spec
parses/lints them and passes their explicit path boundaries, but cannot execute
their Node scenarios. Those skips remain non-passing native lifecycle results:
PR 154 has five; PR 155 has 49 and ten; PR 156 has nine and eight; PR 158 has 15
and four. These whole-contract counts exceed the selected focused scenarios;
the actual Vitest commands and full-suite results are recorded separately.

## Final verification

- `npm test`: 290 files pass, 4,268 tests pass and one platform-dependent test
  skips. All four shards and the merged report completed; no failures or
  unhandled errors. The skip is the non-macOS installer rejection scenario on
  this macOS host.
- `npm run verify:ci`: passes, including 508 kernel/CLI tests in 46 files,
  dependency and architecture isolation, generated-router checks, remote
  packaging smoke and all 523 executable specification bindings.
- `cd mockup && npm run build`: default Next.js Turbopack production build
  passes using this worktree's own dependencies.
- Playwright against that production build on an isolated loopback port:
  English and Chinese both pass resource/agent YOLO persistence and grant
  revocation. Running, parked, queued and unknown dispatch status pass on
  resources, workforce, config and agent detail pages. Hybrid terminals remain
  visible, the running badge is green, stopped agents retain observed dispatch
  activity, and on-demand agents neither show nor request a persistent pane.
  Screenshots were inspected. API responses are browser fixtures, so this is
  UI acceptance, not a live Matrix or LLM end-to-end run.
- `git diff --check` passes. The source tree tested at ea0e1e1 is unchanged
  after integrating the GitHub merge receipts at f8c82c4.

Raw focused, full-suite, CI, build, native lifecycle and browser logs, screenshots
and merge receipts are retained outside Git under
~/Library/Caches/hagency-review-closure/2026-09-09/open-pr-fixes/.

## Merge outcome

All four original PR heads had successful GitHub CI. They were merged using
their exact head commit as a precondition, without rewriting contributor
branches:

| PR | Local conflict resolution | GitHub merge |
| --- | --- | --- |
| 154 | 2be09e4 | 23866c2 |
| 155 | 2e82029 | 8e29f74 |
| 156 | e3f30dd | a78e122 |
| 158 | ea0e1e1 | 0ab52fe |

Hagency has no remaining open PRs at this check. GitHub master is 0ab52fe;
its new post-merge CI run 34423003557 is still running at the time of this
record. Local conflict resolutions preserve the newer local review/workflow
history, which remains unpublished. Original PR merges on GitHub do not imply
that those additional local commits have been pushed.

The primary workspace's independent website coordination changes are preserved
outside these commits. No live Hagency, Palpo, Robrix or LLM service is changed
or used as an acceptance fixture by this integration.
