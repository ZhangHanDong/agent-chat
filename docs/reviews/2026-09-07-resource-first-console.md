# Resource configuration replaces manual Agent creation

The operator confirmed that providers configure Resource capacity and approve
borrower requests; Hagency creates or selects the Agent as part of fulfillment.
A separate manual Create Agent workflow was therefore removed from the console.
ADR-022 and task-resource-first-console.spec.md record this product decision.

The sidebar and Resource page no longer link to the old creation wizard. The
`/onboard` route redirects to `/resources`. Resource configurations now appear
before Agent instances, and their sidebar count comes from resource records
instead of registered agents. Empty resource, Agent and seat states guide the
provider through configuration and request approval in English and Chinese.
An unused resource says it has no allocated Agent, rather than presenting missing
manual attachment as an error. The configuration wizard and its success message
describe the same flow. Existing Agent detail and management links are retained.

Verification:

- 31 Vitest tests pass in resource-first-console, console-live-ux,
  capability-fillable and api-provision-role-matching. The redirect test exercises
  Next's real redirect protocol; backend tests independently confirm capability
  and request admission before an Agent exists.
- 8 Playwright cases pass with controlled localhost API fixtures: both languages,
  empty/configured/allocated states and saved `/onboard` links. Requests other
  than GET are blocked by the fixture. Resource navigation, section order,
  configuration access, request links and retained Agent links are checked.
- Production build, translation parity, 278 spec selectors and whitespace checks
  pass. Agent-spec 1.4 reports 100% contract quality, but its Cargo-only lifecycle
  retains 3 unsupported behavioral skips and is **not passing**. Separate Vitest
  and browser results provide the behavioral evidence.

The dedicated local console13202 was gracefully restarted from PID26554 to90451
using `.next-resource-first-v5`; the rig's saved console_dist points to that build.
Backend18194, Matrix and Agent processes were not restarted. Read-only browser
verification against the deployed console confirms the old URL redirects,
creation links are absent, two actual Resource records are shown and the current
coding_126926a91ba1 Agent detail opens. Both existing Agent identities, preset
bindings and manualDown flags match the pre-deployment snapshot. No resource,
request, verdict or Agent was created or deleted for verification.

Private evidence under `palpo-admin-e2e/2026-09-06` includes
resource-first-tests.log, resource-first-browser.log, resource-first-build.log,
resource-first-contract.json, resource-first-lifecycle.json,
resource-first-deployment.json, resource-first-live.json and
resource-first-deployed.png. The temporary validation listener13203 was stopped.
No commit or push was performed.
