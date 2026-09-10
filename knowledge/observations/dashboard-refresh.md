# Dashboard refresh and unavailable deletion — 2026-09-06

The local Dashboard review found that DataProvider fetched only on mount and
explicit mutations. Its root-layout lifetime spans route navigation, so runner
availability and activity could remain at the initial snapshot. Configuration
preset deletion also emitted a success toast in fixture or unavailable mode
without issuing a write.

The authorized repair adds a 15-second automatic refresh while the document is
visible and an immediate refresh on visible window focus or restored visibility.
An in-flight request counter suppresses automatic overlap, including when an
older superseded request remains pending. Explicit refresh still starts a newer
generation, and the existing generation comparison rejects older results.
Cleanup removes the interval and both listeners and invalidates pending responses.
The explicit `?data=fixture` branch still returns fixture state without live reads.

Preset deletion now renders disabled without live preset provenance. Its handler
also returns without writing or reporting success if invoked directly in that
state. The live write path remains the existing request followed by refresh.

The bound contract is `specs/task-dashboard-refresh.spec.md`, linked to accepted
provenance, unknown-data and refresh requirements. Its eight tests execute the
actual DataProvider effect and Config callback with injected hooks and API
results; fake timers and EventTarget events control elapsed time and visibility.
The disabled Config control is also checked through the shared React SSR renderer.

- Red run: 7 failed / 1 passed. Expected failures covered missing polling,
  restoration listeners, overlap recovery, supersession setup, cleanup setup,
  enabled non-live deletion, and its false success toast. Existing fixture query
  behavior passed before the repair.
- Green run: `npm test -- tests/dashboard-refresh.test.js` passed 8/8.
- Integrated Dashboard regressions passed 45/45 across refresh, console,
  agent-detail, runner-UI and usage tests. `git diff --check` passed.
- `agent-spec parse` found eight scenarios; `lint --min-score 0.7` reported 100%.
- Installed agent-spec 1.4.0 lifecycle passed its explicit boundary check and
  skipped eight Node scenarios. Lifecycle is not passing; exact Vitest runs
  above provide the executable behavior evidence. Local run logs are under
  `/tmp/hagency-dashboard-refresh-agent-spec`.
- No new translations, helper modules, UI operations, services, builds or commits
  were needed. Final production build and GUI checks belong to the parent task.
