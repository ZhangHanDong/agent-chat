# Automatic Palpo resource pool

The actual deployment had three saved Resources, none published, and only the
coding role published. Palpo therefore received an empty resource list. Its form
also filtered Resource by Role before a project could inspect the whole pool.

All three actual Resources were published at the operator's request. Palpo now
shows a deduplicated pool, with a Define Agent action on each card; Role is chosen
from that Resource's supported roles. The user then required automatic publication:
new Resource creation persists publication by default, and the callback derives
roles from qualifying published Resources without a separate manual offer.
Explicit resource/role withdrawals remain effective. Legacy records without a
publication choice preserve visibility. Unsupported configurations and the review
family gate are not bypassed. Catalog visibility never grants capacity or changes
legacy automatic acceptance policy.

Palpo's visible page reads its catalog every10 seconds and on return. The Palpo
backend uses the existing authenticated App Service callback to Hagency. Resource
edits and deletion appear on the next read; request drafts remain intact and
unavailable reads disable new submissions. A request still records a Matrix event,
whose sender, room binding and payload Hagency independently verifies. Model
credentials, runtime paths and other projects' Agent definitions stay private.

Validation:110 backend checks in9 files;33 Palpo Node checks; both Palpo browser
suites (including automatic withdrawal, focus refresh, draft retention and readiness
expiry); two bilingual Hagency browser workflows; production build and scoped lint;
architecture ownership and296 bound selectors. The source-authentication selector
bound by the active contract is checked separately. Native agent-spec lifecycle
reports six unsupported behavior skips, zero failures: this is non-passing and
is not a substitute for the direct Vitest results.

Actual Mini1 Playwright verification created a temporary Resource through the
Hagency web wizard. It appeared in an already-open Palpo after9311ms, without
publication calls or a manual refresh. Its four medium roles were selectable;
deletion removed it automatically and preserved the draft. Only this temporary
Resource was removed. Three actual Resources, both existing identities,
allocations and18 completed dispatches remain unchanged. No new actual request,
approval or quota was created. Connection verification is still expired and the
project-side1M allocation remains fully committed.

Deployment: local backend18194 PID40252, console13202 PID40253 using
`.next-resource-pool-v10`; bridge18195 PID20071 retained. Mini1 web-admin image
`palpo-web-admin:f67999ec23458a6a`. Matrix server, crypto state and operator clients
were not restarted. No commit or push.

Private evidence is under
`/Users/yuechen/Library/Caches/palpo-admin-e2e/2026-09-06`:
`palpo-auto-live-result.json`, `palpo-auto-pool-final.png`,
`palpo-auto-final-state.json`, `palpo-auto-deployment.json`,
`palpo-auto-pool-deploy.log` and `palpo-auto-lifecycle.json`.
Local test logs use `/tmp/palpo-auto-*` and `/tmp/hagency-auto-*`.
