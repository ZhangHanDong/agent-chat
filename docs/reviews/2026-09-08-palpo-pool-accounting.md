# Selected-pool allocation correction

The operator's Edison request selected the new medium Resource, but approval
used the older project-side allocation cap. Separately, resourceRemaining
subtracted every commitment sharing a model account from each individual pool's
ceiling. Raising the side cap repaired one attempt without fixing either model.

ADR-025 now funds authenticated project Agent definitions from their selected
pool, with separate enforcement of a declared shared-account quota. Legacy
role-only requests retain their side-allocation gates. Side budget reporting
separates legacy commitments from pool commitments without changing saved limits.
Reservations and active engagements use one commitment predicate in the store
and pool ledger; pending requests hold nothing. Retry excludes its existing
reservation, while concurrent approval rechecks capacity after owner verification.
The existing-Agent path also checks total pool commitments. Period mismatches
cannot bypass a declared account quota. Unknown account quota remains unknown.

The approval UI shows pool ceiling, other commitments, available allocation and
the shared-account limit independently. Pool accounting stays on operator APIs;
the public catalog still omits internal quotas, memberships and credentials.

Validation:221 checks pass in10 related Vitest suites; six compatibility suites
pass56 checks, including two overlapping pure-budget checks (275 distinct checks).
The new regression initially failed against the old implementation. English and
Chinese Playwright fixtures both pass, including actual approval submission to
the fixture. Isolated Next production build, syntax, scoped lint, architecture
and299 selector bindings pass. Native agent-spec lifecycle reports9 unsupported
behavioral skips,0 failures and remains non-passing; direct Vitest is the actual
behavioral evidence. An intermediate privacy source check caught a projection
helper reading a breakdown; aggregation was moved back into the store, retaining
the numeric-only runner projection. No private breakdown was exposed.

Deployed local backend18194 PID4587 and console13202 PID4681 using isolated
`.next-pool-budget-v11`. Bridge18195 PID20071 and Mini1 Palpo web-admin remain
unchanged. Private runtime/configuration and SQLite backups are under
`pool-budget-backup-1788859304` in the Palpo admin E2E cache.

Real Playwright readback at2026-09-08T09:23:57.898Z opens Edison's actual Hagency
approval form: medium,100M pool ceiling,0 committed,100M available,100k requested.
The shared account reports1M committed and an undeclared quota. Edison remains
pending en_mtsfvnyd_16ee86 without a runtime, allocated tokens or fulfillment.
No live verdict was submitted. Two existing identities, three Resources,
18 completed dispatches and the saved1.1M legacy side allocation are unchanged.
The verification helper required corrections to its evidence filename extension
and dispatch comparison (an undefined ID is omitted by JSON); these were read-only
verification errors, with no API mutations. Final browser check has zero writes
and zero page errors.

Private receipts: `palpo-pool-deployment.json`, `edison-selected-pool-fixed.json`,
`edison-selected-pool-fixed.png`, `palpo-pool-lifecycle.json` in
`/Users/yuechen/Library/Caches/palpo-admin-e2e/2026-09-06`.
No commit or push; unrelated worktree changes remain intact.
