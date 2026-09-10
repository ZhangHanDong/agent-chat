# Readable Matrix names and runner activity

The project definition already stored `displayName: edison`; fulfillment never
synchronized the Matrix profile. The host runner also received native tool events
but forwarded only final answers. A typing indicator could expire while work
continued. ADR-026 and task-visible-runner-activity now govern both corrections.

The bridge initializes generated profile names with readback, preserves custom
profiles, and checks the provisioned identity and App Service namespace. Edison
was repaired on Mini1 and read back as `edison`; its MXID was preserved.

Codex item events are bound to their actual thread and turn; Claude stream events
are observed in the owned subprocess. Only fixed tool categories and counts reach
the durable activity projection. Fenced capabilities and router state govern
updates, approvals and terminal state. There is no new network or sandbox grant.
Unclaimed stale projections are superseded; claimed transaction snapshots remain
immutable for retries. Receipts retain the first Matrix event as the edit anchor.
Each dispatch edits its own status, preserving thread relations and encrypted DM
transport. Known Agent status events are excluded from live and backfilled context.

Validation: 146 existing regression tests and six new activity/profile tests pass;
nine additional conversation/identity tests pass (161 distinct tests, 14 suites).
Build, router boundary, generated output, scoped ESLint, architecture boundaries
and spec binding checks pass. Native agent-spec 1.4.0 parse/lint succeeds with
quality 1.0. Its lifecycle boundary scenario passes; five BDD scenarios are skipped
because the native verifier does not cover the Node steps. These are explicitly
non-passing native results; exact Vitest selectors supply separate test evidence.

Deployment waited for the operator's existing Edison execution to finish, then
backed up the complete runtime and private configuration and restarted backend
95185 and bridge 95205. No Palpo container, public proxy, namespace, permission or
credential was changed. No worktree reset, commit or push was performed.

Live Mini1 evidence: three real Codex dispatches completed (one fresh DM without
mentions and a shared thread addressing both Edison and coding). All three had
exactly one status anchor, updates before their final reply, running-time updates,
and terminal status. All 19 status sends/edits were acknowledged; no active
dispatch remained after the tests. Public profile readback and browser rendering
show `edison`. Native Robrix2 was not driven by this test.

Private artifacts are under
`/Users/yuechen/Library/Caches/palpo-admin-e2e/2026-09-06/`:
`agent-profile-repair-0908.json`, `runner-activity-live-0908.json`,
`runner-activity-deployment-0908.json`, `runner-activity-browser-0908.json`,
`runner-activity-test-summary-0908.json`, and the `runner-activity-*.png` captures.
The rollback snapshot is `activity-backup-20260908-095130/`. Files containing
runtime/account material stay outside the repository and are not committed.
