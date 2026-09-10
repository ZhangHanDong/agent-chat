# Pending Agent definitions and approval budgets

The operator submitted edison on a fresh medium Resource, but an exhausted
project-side allocation caused request_refused before Hagency recorded it. Palpo
retained the immutable request/event for retry, leaving no provider approval row.

The authenticated fleet protocol always requires manual review. Its request now
enters pending without reserving tokens or creating an Agent. The verdict and
fulfillment paths still refuse approval with missing/insufficient project-side
budget, resource capacity or seat quota. Legacy intake that may automatically
accept keeps its original budget gate. ADR-025 records this boundary.

Validation: the new regression failed on the original behavior, then passed with
60 related tests. It checks a new Resource while the first Agent commits the
entire side budget, idempotent pending intake, missing allocation, refused approval
without state changes, and approval after an explicit test-only budget increase.
Syntax, scoped lint, architecture and297 selector bindings pass. Native lifecycle
reports seven unsupported behavioral skips and is not passing.

Backend18194 was deployed as PID16597; other services were preserved. Real
Playwright retried the operator's original request
`e0bc1093-7333-4bf5-8bdf-ce62a0067400`. Its original Matrix event and Agent definition
were retained. The201 acknowledgement initially tripped an incorrect200-only
verification assertion; subsequent inspection confirmed success without another
submission. Engagement `en_mtsfvnyd_16ee86` is pending for edison/integration,
100000 tokens and the medium Resource. The Hagency approval form displays it.

Live verification did not approve it, increase budget or create another runtime.
Both existing identities, three Resources and18 completed dispatches are unchanged.
The project-side allocation remains1M, committed1M, remaining0. Budget remains an
approval prerequisite; it is no longer a request-submission prerequisite.

Evidence under the private Palpo admin E2E cache dated2026-09-06:
`palpo-pending-live-result.json`, `palpo-pending-deployment.json`,
`palpo-edison-pending.png`, `hagency-edison-review.png`,
`palpo-pending-lifecycle.json`. Test logs: `/tmp/palpo-pending-*`.
