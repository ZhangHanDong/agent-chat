# Upstream integration, 2026-09-08

Integrated workflow commit `c380959` with upstream `origin/master` at `4fb9749`
on `integration/matrix-workflows-20260908`, in an isolated worktree. The original
checkout's concurrent website planning files and the live HAFleet runtime were
preserved. No branch was pushed and this HAFleet integration was not deployed.

## Resolutions

- Preserve resource-first onboarding and project-side Agent definition, including
  YOLO defaults and scoped permission management, alongside upstream dashboard
  refresh, usage provenance and on-demand runner projections. Config's remaining
  local New Agent entry now links to engagement requests.
- Preserve native MCP request/item correlation and capability-scoped task
  operations alongside exact execution grants, activity updates, file delivery
  and process-tree termination. The remote MCP implementation remains identical.
- Combine bounded sync-gap recovery and botless outbox startup with managed
  fleet identities, invited-room membership and group/DM routing. The bridge
  supplies SDK constructors to direct-chat handling so SDK imports remain inside
  the existing dependency boundary.
- Reconcile the two incompatible migration-9 histories by checking actual
  columns and tables transactionally. Upstream task-operation receipts and the
  workflow approval identity, conversation data and task authorization epoch
  coexist; migration marker 12 records convergence. A real SQLite regression
  opens both parent layouts, preserves existing records and checks repeat opens.
- Update integration fixtures to use current authenticated reads, native MCP
  metadata, direct-agent roster/work receipts and the resource-first redirect.
  Product authorization was not relaxed to satisfy fixtures.

## Validation

- Full `npm run test:ci`: **279 files passed; 4,151 tests passed, 1 skipped,
  0 failed**. The skip is the existing non-macOS installer refusal scenario on
  this macOS host. Final JSON is `test-results.json`; console evidence is
  `/tmp/hafleet-integration-sharded-final.log`.
- Four direct-chat, invited-room and botless startup files were also checked
  after the SDK dependency-boundary adjustment: **9 tests passed**.
- Router build/type/artifact checks, JavaScript syntax, undefined identifiers,
  CLI contract, dependency isolation, remote build/sync/package smoke, Agent
  Operations contract and architecture ownership checks passed. Executable spec
  bindings: **447 selectors, no missing selectors**.
- Next production build passed with webpack. The default Turbopack attempt
  rejected this isolated worktree's external dependency symlink; this environment
  limitation is preserved separately in its log.
- Headless Chromium verified English/Chinese resource publication, project-side
  Agent approval, YOLO defaults/save/reload and exact permission-rule revocation.
  These browser checks use controlled API fixtures, not live Matrix acceptance.
- Native agent-spec 1.4 parsed/linted the Task Contract and passed its explicit
  path boundary check. Its four Node/Vitest acceptance scenarios remain **Skip**;
  the real Vitest results above are separate evidence, not a lifecycle pass.

The first monolithic full run exhausted its 4 GiB heap after 150 files, consistent
with the documented cache-busting backend-fixture retention. The active file
passed separately with a 1 GiB heap. The full runner now uses four deterministic,
sequential processes at the same 4 GiB ceiling and merges native Vitest reports.
Failure/crash/missing-report tests ensure it cannot turn an incomplete suite
green. It performs no automatic retries or exclusions. The first sharded run
retained a stale botless fixture failure; after correcting that fixture, the
complete suite passed. The underlying module-retention debt remains documented.

## Related repositories

Robrix integration `d5523276` combines `88ebf221` with upstream `e28e118e`:
711 library tests passed, 4 ignored, and the native fast-profile build passed.
Palpo integration `874427c5` combines the admin work and mainline dynamic AS
authentication with upstream `c96c8e33`; its Mini1 backport was not merged twice.
See each repository's integration report for evidence and limitations.

The separately requested Palpo owner-renewal and status-timeout repairs were
integrated as `b8b6bc80` and `0736f991` and deployed only to the dedicated Mini1
web container. They do not change the direction of the HAFleet callback or remove
the existing reverse connection. A requested outbound-protocol review is separate.
