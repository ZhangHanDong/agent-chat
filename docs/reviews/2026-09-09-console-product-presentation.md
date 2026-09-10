# Hagency console presentation cleanup

Implemented on `fix/console-product-copy`, based on master `e927e46`.

The operator requested removal of debugging information from the web app. The
provider console now uses concise English and Chinese product copy. Data-source
lists, raw usage errors, preset and seat identifiers, namespaces, outbound URLs
and credential paths are available through closed, keyboard-accessible details.
Partial failures and sample data stay visible per affected data slice.

Resource explanations appear once per page. Each resource has a closed execution
permission editor whose summary states the saved policy, including YOLO and the
absence of sandbox/approvals. Publication controls remain directly accessible.
Workforce no longer quotes PRD/ADR identifiers. Settings and onboarding omit
unnecessary implementation explanations. Unknown usage stays unknown, and the
runtime budget-enforcement limitation remains visible.

Visual verification also found an existing Resources toast-hook mismatch: it
rendered an empty red error and would throw when reporting a preset-binding
result. The page now uses the hook's actual tuple interface. Missing providers
no longer render a literal `null` before the reasoning label. Browser coverage
checks the exact binding payload and visible failure notification.

Stored names, IDs, authorization, allocation and backend behavior were unchanged.
Long Agent names are still displayed where those are the actual stored names;
this change does not infer or rewrite identities from their identifier strings.

## Verification

- 84 Vitest tests passed across nine console suites, including eight new
  presentation cases in English and Chinese.
- 16 controlled Playwright cases passed: presentation at desktop and phone
  widths in both languages; resource publication and project-defined approval;
  project-side visibility and failures; execution permissions and rule
  revocation; Palpo onboarding, failed saves and credential replacement.
  API writes were intercepted fixtures, never live mutations.
- Production Next build and `git diff --check` passed.
- Read-only browser checks passed on six live pages in separate browser
  contexts: Resources, Workforce, Engagements, Projects, Usage and Settings.
  The final deployed check encountered a usage timeout; this is recorded as
  unavailable data, not a successful usage check.
  A subsequent bilingual presentation check confirmed five resources, the saved
  permission summaries and no browser errors in both locales. Usage was live in
  those two samples; this does not erase the earlier intermittent timeout.
- With the same live data and 1440px viewport, Resources decreased from 3637px
  to 2273px tall, about 38%.

Verification limitations are explicit:

- The legacy `check-invariants.mjs` audit remains non-passing. Both the baseline
  source archive and this change report the same undeclared dynamic translation
  families, 90 unused translation keys, and an unlinked `/onboard` redirect.
  These were not suppressed or counted as passing.
- agent-spec 1.4.0 parse/lint succeeded, with 94% quality. Native lifecycle
  verification skipped all four Node scenarios because no native verifier
  covered their steps. Those skips are non-passing; exact Vitest and browser
  execution above supplies the independent behavioral evidence.
- An initial live check that navigated repeatedly in one browser context
  observed four HTTP 502 responses even though the settled pages showed live
  data. All six subsequent checks using separate contexts passed with no API
  errors. After deployment, `/api/usage` also exceeded the unchanged 8-second
  proxy timeout. Resources continued to display the five live configurations
  and explicitly marked usage unavailable. This UI cleanup does not claim to
  fix backend timeouts.

Evidence, screenshots and logs are local under
`/Users/yuechen/Library/Caches/hagency-console-cleanup/2026-09-09/`.

## Local deployment

The web UI at `http://127.0.0.1:13202` now runs from this source checkout's
`mockup/` with `HAGENCY_CONSOLE_DIST_DIR=.next-console-cleanup-build`.
Console PID is 46398. Previous console PID 7240 used the older outbound checkout.
The backend remains PID 7238 on loopback port 18194; Agent and Matrix processes
were not restarted. Five resource configurations and the protected project and
engagement responses were compared before switching the console.

Use the existing deployed backend credential when restarting this console.
The default backend on port 8090 is a separate instance; the root environment
file alone does not identify this console's deployment. Launch credentials are
kept outside Git and are not included in this report.

This report records validation before commit and merge. Pre-existing coordination
changes in `docs/` were preserved.
