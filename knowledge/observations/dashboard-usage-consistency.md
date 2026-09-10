# Dashboard usage consistency — 2026-09-06

The authorized local Dashboard E2E reported three tasks across two agents, with
two completed tasks in the summary, while the task chart displayed no activity.
The project usage heading had no rows or explanation.

`fetchLive` deliberately empties legacy per-engagement `usage` after reading the
live usage endpoint, which supplies `usageLive` per agent. The page's table and
completion card used `usageLive`, but the chart grouped the empty legacy array
by project. An engagement or group membership does not establish which project
owns an agent's task; copying the agent total into each project duplicates work.

The task chart now uses the live per-agent rows, and its done summary is summed
from those chart rows. Missing project attribution has an explicit explanation;
existing fixture project rows are kept separate. Current allocation and the
allocation donut share one selection of active engagements. The previous donut
included ended engagements through `state !== 'pending'`, reproducing 51k beside
a 1k current commitment when a 50k ended engagement existed.

This repair implements the accepted requirements
`REQ-CONTRIBUTION-CONSOLE-BLANK`,
`REQ-CONTRIBUTION-CONSOLE-METERING-SCOPE`,
`REQ-CONTRIBUTION-CONSOLE-PROVENANCE`, and `REQ-PROJECT-BOARD-BOUNDARY` without
introducing project attribution or changing measurement collection.

Verification is bound by
`specs/task-dashboard-usage-consistency.spec.md`. Six Vitest tests render the
actual Usage page, charts and English dictionary with injected provider contexts:
live counts, duplicate project membership, missing attribution, ended and pending
allocation exclusion, ended-only allocation, and a measured zero task count.

- Red: six expected assertion failures reproduced on the pre-fix page, including
  empty task bars, project task counts replacing agent counts, and a 51k donut.
- Green: `npm test -- tests/dashboard-usage-consistency.test.js` passed all six
  tests after the page repair and coordinated translation changes, and again
  after adopting the shared `tests/helpers/dashboard-render.js` harness.
- `agent-spec parse` found six scenarios; `lint --min-score 0.7` reported 94%.
- Installed `agent-spec 1.4.0` lifecycle passed the explicit boundary check but
  skipped all six Node scenarios because no verifier covered their steps. The
  lifecycle is **not passing**; the executable behavioral evidence is the exact
  Vitest invocation above. Its run log is under
  `/tmp/hagency-dashboard-usage-agent-spec` for this local session.
- `git diff --check` passed. Production build and GUI recheck belong to the
  parent E2E task; this repair did not operate a browser or restart services.

The source checkout has no provisioned `task-writer`, `docs/plan.md`,
`docs/projects.md`, or managed `projects/` tree. No control-plane task state was
fabricated. Source paths are the operator-authorized repair target.
