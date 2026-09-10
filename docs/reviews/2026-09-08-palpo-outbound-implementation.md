# Palpo outbound implementation and Mini1 acceptance

Implemented the accepted `REQ-PALPO-OUTBOUND` in isolated Hagency and Palpo
worktrees and deployed it on September 8, 2026 (September 9 UTC). This completes
the transport change described in the earlier architectural review; it is not
a claim that every Hagency feature or historical UI check passes.

## What is running

| Component | Current address or source |
|---|---|
| Palpo browser and outbound machine API | `https://crew.ominix.io:19444` |
| Matrix client API, including Robrix homeserver | `https://crew.ominix.io:19443` |
| Local Hagency console | `http://127.0.0.1:13202` |
| Hagency backend | Local loopback `18194` |
| Hagency backend, bridge and console source | `/Users/yuechen/home/hagency-outbound-20260908` |
| Server-side Matrix relay | `http://palpo-web-admin-hfux-closure-20260906:8090/api/relay/v2/hf_82042a93a7734deeab65e02226608831` |

The contributor bridge has no inbound Appservice listener. The owned
`com.hagency.mini1-tunnel` launch agent is disabled and stopped: laptop ports
18010/18080/18195 are closed, and Mini1 reverse port 19094 refuses connections.
Administrative SSH access remains available; it does not carry fleet traffic.
Mini1's own loopback 18080 remains the web container's reverse-proxy backend.

Use the public Palpo URL above. During migration the former laptop portal
`http://127.0.0.1:18080` returned an immediate `403 host_forbidden`; after tunnel
removal that laptop address is unavailable. Independent checks did not reproduce
the reported timeout against the public portal. This is evidence about the
observed endpoint behavior, not attribution of every earlier timeout.

Hagency implementation commit: `57d56da`, based on integrated `fa20a7e`, with
the cross-Agent thread admission fix `a57ac7e`. Palpo protocol source is
`9040bbcb` with earlier `ae9e4b58`, `8ac507d2` and URL-CAS `537a1bc3`.
The live Rust binary uses the minimal URL-CAS backport `b77a71ec` on the existing
live authentication baseline; this deployment did not substitute the broader
mainline Rust integration. Exact images and rollback instructions are in Palpo's
deployment acceptance record.

Follow-up Hagency commit `4953baf` preserves private-chat devices when the
configured homeserver address moves from a tunnel to the public endpoint.

## Behavior and authority

Hagency publishes resources, heartbeats and observed request results, and
long-polls separate durable work and Matrix lanes. Palpo serves stored state
without contacting a contributor callback. Matrix Appservice transactions are
persisted by the colocated Palpo relay before acknowledgment. Hagency persists
its own inbox before ACK and retains an identical, sequenced outbox update until
its receipt is confirmed. ACK is custody, not approval or fulfillment.

Machine credentials are independent of browser sessions and Matrix credentials.
Every delivery is bound to a fleet, registration, generation, lane, lease and
content digest. Machine rotation preserves unprocessed work under the stable
Matrix registration and invalidates old authority. The exact current-generation
Matrix event receipt establishes the initial connection; heartbeats alone cannot.
After verification, background heartbeats maintain online status without owner
browser renewal. Per-request observed and received timestamps expire separately;
late delivery and fresh heartbeats cannot refresh an old ready observation.

Original source-event, contributor approval, private owner room, namespace,
target membership and quota checks still apply. Three existing active
engagement records, identities, bindings and allocations survived the migration.
An older source-bound request named `edision` was replayed into a pending
engagement; it has neither an Agent nor allocated tokens. It was not approved
automatically. Two older unavailable requests retry independently and do not
block publication for the three active requests.

The bridge refresh is serialized, replacement workers stop before their
successors start, slow request reconciliation cannot block heartbeats, and
status publication rotates through batches. Capacity exhaustion is explicit;
completed deduplication records are retained. Monitor and expand queue capacity
using the documented Palpo procedure. Automatic tombstone compaction is not
implemented.

## Verification

All paths below refer to the checkout actually edited. Evidence directory:
`/Users/yuechen/Library/Caches/palpo-admin-e2e/2026-09-06`.

| Check | Actual result |
|---|---|
| Hagency full suite at `57d56da` | 282 files, 4174 passed, one platform skip |
| Follow-up DM migration and outbound regressions at `4953baf` | Four exact files, 37 passed |
| Hagency production console | Next webpack build passed |
| New onboarding Chromium regression | Two imports, zero reverse callback checks, zero page errors |
| Hagency syntax, ESLint, architecture and spec bindings | Passed; 456 selectors before the DM scenario, 457 after it |
| Palpo Node and browser fixtures | 57 tests and three Chromium suites passed |
| Rust URL-CAS | Three PostgreSQL tests passed on macOS; three CAS plus the existing dynamic-AS auth test passed on the Linux live backport |
| Cross-repo actual HTTP fixture | Seven stages, 36 requests, three restarts, one idempotent admission; no Hagency listener or reverse callback |
| Real Mini1 browser connection | Admin migration, owner download, Hagency file import, automatic heartbeat and exact Matrix relay receipt passed |
| After removing all owned forwards | Public APIs and both browser pages passed; advancing heartbeat and three active, usable, verified requests in two rounds |

The cross-repo fixture uses actual transport, persistence, routing and protocol
implementations with isolated Matrix/approval/execution data. It covers lost
ACK and update responses, restart and offline request delivery. It is not a live
model or native Robrix test. The live connection proof used Mini1 Matrix and
real joined identities; it was verified at `2026-09-09T01:33:26.463Z` with
`expiresAt: null`. No-tunnel browser acceptance completed at
`2026-09-09T01:43:06.809Z`, independently corroborated by another Agent. It
passed again at `2026-09-09T01:48:27.443Z` after the private-device repair.

Primary evidence:

- `/tmp/hagency-outbound-full-final.log`, production build and focused-test logs.
- `/tmp/hagency-outbound-ui/result.json` and `outbound-cross-repo-20260909.json`.
- `outbound-live-connect.json` and the corresponding import/ready screenshots.
- `outbound-no-tunnel-verification.json`, `outbound-independent-no-tunnel.json`
  and both no-tunnel browser screenshots.
- `outbound-live-request-drift.json`, comparing the preserved active allocations
  against the stopped runtime backup.

An initial no-tunnel heartbeat assertion sampled only six seconds apart, shorter
than the configured fifteen-second publication interval. Its failure is retained.
Repeating with a twenty-second observation interval passed without changing the
service. Earlier implementation-test failures and their corrected reruns are
also retained rather than recast as successful first attempts.

## Remaining verification limits

Native agent-spec boundary verification passes, but its seven Node lifecycle
scenarios remain **Skip** because the installed native lifecycle verifier does
not execute Vitest. The lifecycle aggregate is not passing. Exact Vitest
selectors ran separately. Lint diagnostics and lifecycle output remain in
`/tmp/hagency-outbound-lifecycle-post-migration.json`. The earlier six-scenario
record remains in `/tmp/hagency-outbound-lifecycle-explicit.json`.
The first follow-up invocation incorrectly included the previously accepted
cross-Agent thread task's router changes. Its boundary failure is retained in
the `including-prior-task` log. Rechecking the outbound change set from
`a57ac7e` uses the existing boundaries without broadening them.

The general console `npm run verify` is not wholly passing: three existing
invariants concern a dynamic translation family, orphan dictionary keys and an
unlinked `/onboard` route. The baseline integration checker reproduced them.
The separate browser switch/layout check also reports an existing engagement
budget-cell wrapping failure. Their source/check styles were not changed by
outbound implementation; logs retain all four failures. New outbound browser
flows and the production build passed independently.

No new native Robrix encrypted conversation, model task or attachment transfer
is claimed by this transport acceptance. The earlier Edison/xiaobai queued
responses were independently delivered before the outbound migration.

## Private-chat endpoint migration

Post-cutover log inspection found that all three cached private-chat sessions
still named the old loopback Matrix address. Startup treated any URL change as
an identity mismatch, preventing encrypted clients from starting. Commit
`4953baf` verifies the original cached token at the explicitly configured new
endpoint with an eight-second timeout and redirects disabled. Both user ID and
device ID must match before it changes only `baseUrl`. Failed or malformed
responses leave the original cache intact and do not trigger a new login.

Nineteen direct-chat tests passed, including fourteen new preservation and
failure regressions. A coordinated bridge restart at `2026-09-09T01:47:19Z`
ran with all fifty historical dispatches completed. All three live cached
sessions then changed only their endpoint; tokens, devices and other session
fields remained identical to the protected backup. Public `whoami` verified
each original user/device, each sync file advanced after restart, and no private
chat startup warning appeared. Evidence: `outbound-direct-device-before.json`,
`outbound-direct-device-cutover.json`, `outbound-direct-device-after.json`.
The crypto directories were preserved rather than recreated. This establishes
live device recovery, not a newly executed native encrypted chat task.

Changing a homeserver URL while an already healthy private client is running
still requires a coordinated bridge restart; hot swapping an active crypto
client is outside this repair.

## Recovery and local work preservation

The live launch helper is `rig.py` in the evidence directory. Its source paths
now point to the outbound worktree, with public Matrix configuration and no
`HAGENCY_APPSERVICE_PORT`. The production console uses `.next`. Dependency
symlinks in that isolated checkout are untracked local runtime dependencies,
not committed project changes.

Protected local backups under `outbound-rollout-backup/` retain the previous
launch helper, private configuration, tunnel plist, process identities and
complete stopped Hagency runtime. Remote backups retain the previous containers,
stopped SQLite volume, PostgreSQL dump and Caddy configuration. A rollback must
coordinate Appservice URL, web data, Hagency credentials/runtime and routes as
one deployment; do not replace just one side with stale authority. Secrets and
downloaded configuration remain in protected operational files, outside Git.

The original `/Users/yuechen/home/hagency` checkout and its concurrent website
changes were left intact. This source checkout has no provisioned `task-writer`,
`docs/plan.md` or `docs/projects.md`; no canonical task status was invented.
