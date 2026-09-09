# Project names and revocation feedback

The subsequent operator-requested [final-allocation retirement change](2026-09-09-agent-matrix-retirement.md)
supersedes the room-only revoke behavior recorded below for outbound Palpo Agents.
Edison has since been deactivated and removed from its remaining rooms.

The operator reported a failed revoke and asked about a project displayed as
`!JDnsWYWgimwnmX8QTc:hfux-closure-20260906.test`.

Edison's engagement `en_mtsfvnyd_16ee86` was already ended with reason
`revoked from the console`. Its original contribution binding was absent and
Matrix confirmed departure from the original project room. Its Matrix account
still exists in other invited rooms. Allocation revocation does not deactivate
a human Matrix account or delete the Agent identity.

The requested room's actual Palpo and Matrix name is **Signup approval E2E 0909**,
owned by the ordinary signup test account. The operator's `ymote` account created
**octos-one**. HAFleet lacked all project metadata for the connected side, and the
Projects page rendered the room ID as its primary label.

## Changes

- Verified fleet requests read the target Matrix room name and forward it
  separately from immutable request context. Backend metadata preserves existing
  room associations and refuses to move a project through a name update.
- Projects and Engagements resolve names by exact room ID. The Projects page keeps
  the ID below the name. Five existing project names were independently checked
  against Matrix and backfilled through the normal metadata API.
- Revoke persists the decision and pending room departure before calling Matrix.
  Failed, complete and retained-for-another-allocation outcomes survive refresh.
  Explicit retries recheck bindings and preserve the revocation time and amount.
  Concurrent retries share one operation. Pending/rejected requests cannot use it.
- After a lost revoke response, the console reads authoritative state once, never
  automatically repeating the write. The page refreshes after failures, disables
  duplicate clicks, names the ended Agent and offers room-departure retries.

## Verification

144 distinct Vitest tests across nine files passed: `console-live-ux`,
`fleet-protocol`, `api-engagement-room-admission`, `engagement-store`,
`engagement-binding`, `palpo-agent-definitions`, `dashboard-console`,
`dashboard-refresh`, `matrix-direct-chat`. Final metadata protection was rechecked
with all nine Palpo definition tests. Production webpack console build, scoped
ESLint, syntax and diff checks passed. Spec bindings: 464, none missing.

Playwright passed the production-build fixture for project labels, lost revoke
response, failed departure and explicit retry. Every browser write was intercepted:
no live allocation was revoked. Live read-only checks confirmed project labels,
Edison ended and the Unicode Agent still active. Initial live selectors wrongly
expected an Agent display name and then matched duplicate navigation/staffing
links; the final selector targets the active allocation row. Final page errors:0.
One live usage read still returned502; other final page assertions passed.

Native agent-spec boundary verification passed; five Node behavioral scenarios
remain **Skip**, not pass. Its requirement trace also reports missing lifecycle
results for other mapped contribution scenarios. The native lifecycle remains
non-passing. Lint has two substring warnings about “cleanup” and a rule-grouping
suggestion. Exact Vitest results are separate evidence.

## Deployment and remaining limits

All63 dispatches were completed before graceful restart. Backend23654,
bridge23655 and console23656 now run the actual edited source tree
`/Users/yuechen/home/hagency-outbound-20260908`. Console build:
`.next-console-recovery-20260909`. All ten live engagement decisions, amounts,
Agents and ended timestamps matched the pre-deployment snapshot. No Palpo source
or container change, no commit/push. No task-writer is provisioned in this checkout,
so no canonical task transition was fabricated.

Evidence and protected rollback snapshots are in
`/Users/yuechen/Library/Caches/palpo-admin-e2e/2026-09-06/console-recovery-20260909/`.
`private-before.json`, `source-before/` and `project-sides-before.json` preserve the
prior configuration/source/metadata. The prior console build remains `.next`.
Preserve later operator activity when restoring state.

This fixes revoke response recovery, not every service timeout. Intermittent502s
for unrelated console reads were observed, including usage in the final browser
run. Their specific cause remains unestablished. Historical ended records without
departure results remain history; no successful departure was invented for them.
