# Three-layer E2E repair plan

**Goal:** A GUI request reaches a HAFleet-managed agent, real inner execution, independent verification, task completion and the original Matrix thread without test-driver intervention.

**Architecture:** Preserve backend-owned sessions, capability fencing and task truth. The middle agent supervises the lower execution agent through Herdr/octoloop. Work continues on the existing repair branch and E2E runtime; local Docker Palpo only.

**Tech stack:** Node.js, strict TypeScript router, SQLite, Vitest, Matrix, Computer Use, local Claude/Codex and Herdr.

- [x] Inspect previous evidence, accepted session requirements and source boundaries.
- [x] Task lifecycle: write failing router and real stdio MCP tests; implement scoped task operations and transactional retry receipts; compile router; run exact selectors and backend authentication tests.
- [x] Organization: fix botless same-side membership synchronization, HTTP error reporting and appservice MXIDs with failing regressions first (independent worker owns bridge changes).
- [x] Inner execution: add a reusable middle-agent workflow and bounded fresh-result monitor with stale/failure tests (independent worker owns new helper/skill files).
- [x] Fix promoted title extraction with a backend integration regression.
- [x] Review combined diffs, run strict build/mirror/CI checks, parse/lint/lifecycle task contracts; record skips honestly. Final integrated regression: 336 passing tests; full `npm run verify:ci` passed (evidence 35).
- [x] Restart only isolated local E2E services as needed. Provision the real runner with the repaired capabilities and workflow, preserving E2E-only mempal isolation.
- [ ] Use Robrix Computer Use @ picker for a fresh task. Observe agent-authored decomposition, real inner work, monitoring, independent tests, structured task done and same-thread reply without intervening in the run.
- [x] Retest project-2 membership; record runtime/framework coverage and remaining failures in a new evidence report. Commit only reviewed source changes, do not push or stop the user's inner session.

Additional findings during the repaired live run:

- [x] API-driven Claude -> Herdr/octoscode -> independent verification -> structured task done -> original Matrix thread, without driver implementation/monitor intervention. GUI remains blocked by Computer Use `cgWindowNotFound` and is not counted as passing.
- [x] Project 2 convergence: initial removal/addition produced leave/join, but a delayed Matrix-to-roster SSE echo kicked the agent again. Repaired observation/command separation and stale membership handling; 31 samples over 60 seconds stayed joined in Matrix and in the backend roster, with no later kick in event history (evidence 32, 36).
- [x] Provisioned project documentation now reflects actual copy/symlink bindings; add/remove refreshes the managed block while preserving notes.
- [x] Deterministically reproduce and fix signal-at-PID-publication cleanup race; retain original intermittent CI evidence and diagnostic limits.
- [x] Codex native MCP elicitation: reproduce the stalled first real run, implement the supported adapter with the existing narrow control-plane exception, then recover and independently retest. Preserve the first failed run separately.

Acceptance requires separate evidence for inner output, independent checks, dispatch state, task state and Matrix delivery. The test driver cannot write the implementation or result artifact, kill a waiting monitor, or mutate a task to make the run pass.

Final local service acceptance: Claude A and Codex R2 each produced real lower commits, independent monitor acceptance, explicit task done, completed dispatch and one matching original-thread reply. R1's native-protocol stall and later execution-limit timeout remain failed attempts; R2 includes formal recovery and 12 one-time owner approvals. Full CI: 502/502; integrated: 336/336. Source locally committed, no push. The GUI checkbox intentionally remains open: final Computer Use attempt still returned cgWindowNotFound. No fresh GUI or untested lower-backend coverage is inferred from API runs.
