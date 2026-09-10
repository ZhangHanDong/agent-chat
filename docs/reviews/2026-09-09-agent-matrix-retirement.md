# Final-allocation Matrix Agent retirement

The operator explicitly requested that revoking Edison also remove its App
Service access and all room memberships. The earlier room-only revoke left
Edison's identity usable in four additional rooms. That earlier behavior is
superseded for the final allocation of an outbound Palpo-managed Agent.

## Implemented behavior

Hagency persists an admission fence, disables the Agent's contribution bindings,
and invokes its existing managed-runtime stop operation. It then initiates an
outbound retirement request to Palpo with the current fleet credential and
generation. Another active allocation or pending reservation prevents whole
Agent retirement; revoking one allocation must not stop another project's work.

Palpo requires a known request, its exact fulfilled MXID, the configured server,
and actual Matrix App Service ownership. A namespace match alone is insufficient.
The administrator credential stays on Palpo. The server deactivates the exact
account with `erase: false`, checks that joined rooms are empty, and verifies
that App Service authentication is refused. All management records for that
same MXID become retired. Historical request-derived management IDs are retained.
Late status publications cannot make the retired request usable again.

This retires an individual account. The shared registration and namespace remain
installed for the representative and other Agents. Account ownership and audit
records remain; retirement does not erase chat events or local work files.
Hagency removes the retired Agent from its available bridge roster. Failures
stay fenced, are visible, and can be retried with the same identity and original
revocation timestamp. Local and remote observations must both succeed before
the console reports completion.

## Live acceptance on Mini1

Playwright clicked **Remove from Matrix** on Edison's previously ended engagement
`en_mtsfvnyd_16ee86` in the deployed Hagency console. The response and rendered
row confirmed completion. No other allocation was revoked and no chat/model
task was sent by this acceptance.

- Edison: `pa_edison_b93c487ea36f8c32`.
- Matrix user: `@hf_82042a93a7734deeab65e02226608831_agent_pa_edison_b93c487ea36f8c32:hfux-closure-20260906.test`.
- Matrix account deactivated; all four remaining room memberships removed.
- App Service authentication: HTTP403. Authenticated App Service user discovery:
  HTTP404. Representative authentication and discovery: HTTP200.
- Both legacy management records for Edison are retired, with local stop
  confirmed. No available Hagency roster entry or active contribution remains.
- All four other identities registered under this same App Service remain
  non-deactivated. Six live Hagency allocations remain active.
- One actual historical message per removed room was re-read by its original
  Matrix event ID. All four retained their immutable event fields unchanged.
- Original engagement `endedAt = 1788975032812` is unchanged after retry.

Initial verification exposed two management keys for the same MXID: a fulfilled
request key and a runtime-derived key. The final correction retires all exact
MXID aliases and preserves existing history links. It was tested, deployed and
reconciled by retrying only Edison's existing revoke. An initial relay diagnostic
used a loopback URL with a Host override and was rejected with403; the corrected
probe uses the actual configured relay origin and returns404 for Edison and200
for the representative. Both observations are retained.

## Verification and deployment

165 distinct Hagency Vitest tests passed across ten files: `palpo-agent-definitions`,
`palpo-agent-retirement`, `bridge-credential-durability`, `api-agent-stop`,
`api-engagement-room-admission`, `engagement-store`, `engagement-binding`,
`console-live-ux`, `matrix-direct-backend`, and `matrix-direct-chat`.
The final Palpo Web Node suite passed all71 tests, including HTTP scope rejection,
alias retirement, partial remote failure, unchanged history and stale publication
protection. Console production build, scoped ESLint, syntax and diff checks pass.
All468 exact spec bindings resolve.

Native agent-spec1.4 parsed/linted the task and passed the change boundary check.
Its four Node behavioral scenarios remain **Skip**, so the native lifecycle is
non-passing. Its requirement trace also reports absent lifecycle results for
other mapped contribution scenarios. The Vitest/Node results above are separate
execution evidence; skipped native scenarios are not counted as passing.

Local source is `/Users/yuechen/home/hagency-outbound-20260908`; backend7238,
bridge7239 and console7240 run it, with console build
`.next-agent-retirement-20260909`. All63 existing dispatches were completed before
the initial restart. Palpo Web source is
`/Users/yuechen/home/palpo-account-approval-20260909`; final Mini1 image is
`palpo-web-admin:177462cdd1d6be2d`. Account-approval configuration and the persistent
volume were preserved. Palpo's Rust homeserver was neither changed nor restarted.
No commit or push was made. These source checkouts have no provisioned task-writer;
no canonical task transition was fabricated.

Protected live evidence is under
`/Users/yuechen/Library/Caches/palpo-admin-e2e/2026-09-06/agent-retirement-20260909/`,
including `matrix-final-proof.json`, `relay-final-proof.json`,
`local-final-proof.json`, `alias-reconciliation.json` and `history-proof.json`.
Browser evidence is `/tmp/hagency-edison-retirement-browser.json` and the
corresponding before/after PNGs. Local test logs use the
`/tmp/hagency-agent-retirement-` and `/tmp/palpo-agent-retirement-` prefixes.
The server backup is
`/Users/cloud/palpo-web-admin/backups/before-agent-retirement-1788980055/`.
Rollback must preserve later state and the retirement; restoring old source is
not authorization to reactivate Edison or restore stale database contents.

Two unrelated console usage reads returned502 during browser acceptance. This
task does not establish a fix for general service timeouts. Manual Palpo-only
administrator retirement still cannot attest local runtime stop without a
Hagency acknowledgement; the automatic path implemented here starts in Hagency.
