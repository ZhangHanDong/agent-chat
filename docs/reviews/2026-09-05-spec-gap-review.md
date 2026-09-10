# Hagency specification gap review — 2026-09-05

**Verdict: not complete against the accepted plan; not ready for full workflow sign-off.**

Reviewed source: `75ca1ecbf8c4623359094f000fa4968693f4a27e` on `master`, after the requested fast-forward pull from `0b1193d`. This is a review, not an implementation change. The baseline is the nine current files under `specs/`, their accepted requirements and decisions under `knowledge/`, and the accepted contribution-console/project-side design. Superseded status prose was checked against code. Withdrawn pricing/PDU scheduling and explicitly future Octos/remote thread runners are excluded.

Severity: P1 means a defect or missing capability that blocks a core promised workflow or correctness boundary; P2 means a narrower correctness or acceptance-evidence gap. No P0 was established. “Reproduced” below means isolated local fixtures, not deployed Palpo or real model execution.

## Confirmed implementation defects

### F1 — P1: A completed Codex dispatch releases its workspace while its runtime can still write

**Code:** [runner.ts](../../router/src/runner.ts), lines 633–641; [store.ts](../../router/src/store.ts), settlement and resource-lease release.

`runCodexDispatch` commits `settleAndRelease` as soon as it receives `turn/completed`, then calls `terminateChild` and returns without awaiting process exit. A runtime handling SIGTERM can continue using its workspace after the exclusive lease has been removed. A second dispatch can acquire that directory during shutdown.

**Reproduced:** an actual RouterStore dispatch and deterministic App Server fixture returned `completed` with zero resource leases while the runtime was alive. The fixture wrote a file 250 ms after SIGTERM, after settlement. This is not a model-quality issue.

**Requirement:** `REQ-TSS-WORKSPACE-LEASE` and `REQ-TSS-RUNNER-LIFETIME` ([accepted requirements](../../knowledge/requirements/req-thread-scoped-agent-sessions.md), lines 83–85). Terminate and await the owned runtime tree before releasing its execution resources; uncertain termination must preserve quarantine.

### F2 — P1: The guardian can leave runtime descendants alive after completion

**Code:** [runner-guardian.ts](../../router/src/runner-guardian.ts), lines 31–47 and 59–63.

The guardian exits when the immediate runtime closes. It clears its kill timer, and its signal function refuses to signal the process group once the immediate child has exited. A model runtime that started a background subprocess with independent stdio can therefore leave that subprocess running. Process-group creation alone does not enforce the promised lifetime.

**Reproduced:** a deterministic Claude fixture spawned an ordinary child in its runtime process group, returned a successful result, and exited. `runClaudeDispatch` returned `completed`; the lease count was zero; the descendant remained alive and continued writing. The review killed its own fixture process afterward.

**Requirement:** `REQ-TSS-RUNNER-LIFETIME` and `REQ-TSS-WORKSPACE-LEASE`. Keep ownership through descendant cleanup, including normal runtime exit and backend loss, and await cleanup before treating the workspace as available.

### F3 — P1: Agent selection ignores the requested project side and retirement

**Code:** [backend-v2.js](../../backend-v2.js), lines 12818–12834, 13553–13561, and 9879–9889.

`agentForRole(role)` chooses from all agent records by model tier and remaining ceiling. It receives no requested side and filters neither `projectSide` nor `retiredAt`. Explicit agent selection has the same omission. Room admission subsequently applies the correct side-roster check, after the engagement has already become active and committed tokens.

**Reproduced:** with equally qualified `wrong` and `right` agents belonging to different sides, a request for the right side chose `wrong`. The production roster predicate rejected `wrong` and admitted `right`, yet the verdict recorded the engagement as active. Separately, deleting a side returned `retiredAgents: ["a"]`; a later request still selected `a`, and approval made that engagement active again.

**Requirement:** [ADR-016](../../knowledge/decisions/adr-016-project-sides-as-matrix-reachability-unit.md), decision 4 permits reuse on the **same** project side; decision 7 requires retired identities to be unavailable for dispatch. Resolve the target side before selection, filter eligibility consistently for automatic and explicit selection, and validate before committing an active engagement.

### F4 — P1: Unknown seat periods permit automatic approval

**Code:** [backend-v2.js](../../backend-v2.js), lines 12847–12861 and 12916–12928.

`seatRemainingFor` uses `quotaTokens` without checking its period. `remainingFor` treats a numeric result as comparable to the agent's ceiling. Consequently a quota without a known accounting period can satisfy automatic admission, although the contract requires operator approval for that uncertainty.

**Reproduced:** declare a seat quota of 5,000,000 with `period: null`, publish a coding offer, whitelist the room, and request 1,000 tokens. The API returns an `active` engagement with `autoJoined: true`.

**Requirement:** `REQ-CONTRIBUTION-CONSOLE-UNKNOWN-LIMIT` and `REQ-CONTRIBUTION-CONSOLE-CEILING-SEAT` ([requirements](../../knowledge/requirements/req-contribution-console.md), lines 90–93 and 110–114). Carry known/unknown period information into admission; do not compare incompatible or unknown periods.

### F5 — P1: API-key seats are merged after secret redaction

**Code:** [backend-v2.js](../../backend-v2.js), lines 6589, 14258–14266, 14292–14293 and 12848–12858; [seat-store.js](../../lib/seat-store.js), lines 112–128.

The seat identity helper distinguishes actual API keys, but the backend calls it with serialized agent records. Serialization replaces every stored key with `true`; the helper then uses the same `key:redacted` identity for all keys on that server and credential home. Independent credit pools share declarations and commitment limits. The unit helper's correct behavior on raw records does not protect the API path.

**Reproduced:** two Claude agents with distinct fixture API keys produced one `/api/seats` row containing both agents and `keyScope: "key:redacted"`.

**Requirement:** `REQ-CONTRIBUTION-CONSOLE-CEILING-SEAT` and the accepted credential-pool accounting model. Derive the opaque seat identity from trusted raw credentials before producing a redacted DTO; use that identity consistently for display, declaration, and admission without exposing keys.

### F6 — P1: Missing owner binding still produces a successful active engagement

**Code:** [backend-v2.js](../../backend-v2.js), lines 13360–13389 and 13703–13745; [engagement-store.js](../../lib/engagement-store.js), lines 587–594.

The verdict commits the active state and allocation before attempting the owner binding. If owner resolution fails, the endpoint still returns HTTP 200 and `ok: true`. The response includes a binding error and records it, but those diagnostics do not undo the successful engagement state or its token commitment.

**Reproduced:** with no room binding or configured owner, approval returned `ok: true`, `state: "active"`, `allocatedTokens: 1000`, and `binding.bound: false`.

**Requirement:** `REQ-CONTRIBUTION-CONSOLE-BIND` ([requirements](../../knowledge/requirements/req-contribution-console.md), lines 106–108): an unresolved owner must not report success. Resolve/validate the binding before activation, or use an explicit failed/pending fulfillment state with recoverable accounting. Existing [binding tests](../../tests/engagement-binding.test.js), lines 118–151, check the nested diagnostic but not the contradictory success/state fields.

### F7 — P2: Budget admission runs before request-id replay resolution

**Code:** [backend-v2.js](../../backend-v2.js), lines 13619–13642; [engagement-store.js](../../lib/engagement-store.js), lines 461–481.

An already accepted request is checked as a new allocation before the store can return its idempotent result. If the first request consumed the remaining side allocation, retrying it reports `over_allocation` and can raise a misleading budget alarm. A lost response can therefore become an apparent refusal even though work is already active.

**Reproduced:** a whitelisted request with a fixed `requestId` allocated all 1,000 available side tokens and returned HTTP 200/active. Sending the identical body again returned HTTP 409/`over_allocation` instead of that engagement.

**Requirement:** `REQ-CONTRIBUTION-CONSOLE-IDEMPOTENT` ([requirements](../../knowledge/requirements/req-contribution-console.md), lines 95–101). Resolve and validate existing request IDs before admission checks for a new commitment; preserve conflict detection for changed bodies.

### F8 — P1: Inconsistent internal provenance is discarded instead of retried

**Code:** [side-provenance.js](../../lib/side-provenance.js), lines 60–78; [bridge-matrix.js](../../bridge-matrix.js), lines 4401–4436; [appservice-receiver.js](../../lib/appservice-receiver.js), lines 268–281.

Invalid mode, mismatched collector side, and mismatched registration are terminal `provenance_mismatch` results. The bridge consumes these results, allowing the transaction receiver to remember completion and return 200. The active contract explicitly classifies these internal faults as retryable `invalid_transport_provenance`.

**Reproduced:** the real local HTTP listener, router, and bridge ingress returned 200 on delivery and replay for each controlled inconsistent-provenance fault. Missing provenance correctly returned 500. All cases performed zero typed business actions and zero event claims: the demonstrated defect is lost retryability, not unauthorized execution.

**Requirement:** [side-provenance task](../../specs/task-side-provenance.spec.md), lines 54 and 114–125. Keep these receipts retryable with no transaction completion, edge success acknowledgment, or sync cursor advance.

### F9 — P2: Push provenance mode is controlled by the transaction body

**Code:** [appservice-receiver.js](../../lib/appservice-receiver.js), line 268; [bridge-matrix.js](../../bridge-matrix.js), lines 5177–5190.

The HTTP listener forwards the submitted transaction body. The receiver copies `body.mode` into callback metadata, and production bridge wiring uses it to construct provenance. Thus a push request can identify itself as edge or sync. Authentication still selects the registration, and mode is diagnostic rather than event identity, so this is not evidence of cross-side authorization bypass.

**Reproduced:** three authenticated requests through the real push listener yielded modes `push`, `sync`, and `edge` according to the JSON body.

**Requirement:** [side-provenance task](../../specs/task-side-provenance.spec.md), line 24: provenance must come from the authenticated router entry and bridge-owned adapter. Carry transport metadata separately from the submitted body; the push listener should supply its own mode.

## Unfinished accepted capability

### F10 — P1: Resource definition does not yet fulfill demand by creating an agent

**Code:** [backend-v2.js](../../backend-v2.js), lines 13590–13603 and 13703–13716; [engagement-store.js](../../lib/engagement-store.js), lines 563–565.

When no existing agent qualifies, the request route computes a `provisionHint`, stores `agent: null`, and leaves fulfillment to manual action. Approving the engagement does not select/provision an agent from the hinted resource; it only checks the already stored agent's ceiling.

**Reproduced:** with a qualifying preset and no agents, request creation returned a hint naming that preset. Approval returned HTTP 409/`no_ceiling`. This blocks the requested “contribute a resource → accept demand → agent fulfills it” flow on a fresh fleet.

**Requirement:** [ADR-016](../../knowledge/decisions/adr-016-project-sides-as-matrix-reachability-unit.md), decision 4, lines 407–428. The ADR explicitly records this direction as partially built and its initial build stage excluded automatic minting. This is unfinished accepted scope, not a claim that an earlier, smaller milestone promised completion. Connect acceptance to resource selection, side admission, identity/instance provisioning, binding and startup, with durable recovery for partial failure.

## Acceptance and release evidence gaps

### F11 — P1 acceptance gap: The provenance scenario matrix is not established by its passing tests

[tests/side-provenance.test.js](../../tests/side-provenance.test.js), lines 165–201, explicitly expects inconsistent provenance to resolve successfully despite the opposite scenario text. Lines 1304–1365 loop through 24 acceptance labels using the same successful valid-room fixture; changing the label/event ID does not exercise each scenario's negative condition or two-instance setup.

The [contract](../../specs/task-side-provenance.spec.md), line 57, requires those actual conditions through push, edge, and sync. Existing separate negative tests provide some coverage, but the repeated positive fixture is not evidence of the complete promised matrix. Repair the contradictory assertion and build the actual per-adapter cases; retain production registration selection, relation validation, ownership decisions, and deduplication in those tests.

### F12 — P2 acceptance gap: Thirteen exact selectors have no matching test title

The literal `Test:`/`Filter:` audit found 157 declared selectors and 144 matching registered test titles. The exact-selector run executed 149 passing tests; its other 3,556 tests were filtered/skipped, not passes. Several missing titles correspond to renamed/combined tests, so this does **not** mean 13 features are absent.

| Contract | Matching selectors | Declared selectors |
| --- | ---: | ---: |
| Project | 4 | 4 |
| Agent Operations client access | 18 | 18 |
| Appservice sync intake | 8 | 8 |
| Matrix DM privacy | 6 | 6 |
| Matrix thread continuity | 10 | 10 |
| Owner UI approval | 17 | 21 |
| Project board | 10 | 18 |
| Side provenance | 24 | 24 |
| Thread-scoped agent sessions | 47 | 48 |
| **Total** | **144** | **157** |

The missing titles are listed in [the initial audit record](../progress.md). The sync-intake task also references `REQ-AGENT-OPS-MATRIX-INTAKE`, for which no defining accepted requirement was found. Repair these bindings/links or explicitly revise the accepted contracts; zero selected tests are not passing acceptance.

### F13 — Release gates remain open

- **Real model continuity:** [THREAD-SESSIONS.md](../THREAD-SESSIONS.md), lines 3–10 and 62–71, records the required five-run, three-turn probe as outstanding. The accepted gate requires at least four successes. A local canary or prompt-assembly fixture does not replace it.
- **Agent Operations release:** [manifest.json](../../specs/fixtures/agent-ops-client-v1/manifest.json) remains `release_status: "development"` with `source_commit: null`. Integrity checking passed for that development artifact; no released Robrix2 contract was established.
- **Spec lifecycle:** `agent-spec` was unavailable in the reviewed environment. Parse/lint/lifecycle output was not produced. The documented Cargo-only lifecycle limitation for this Node/Vitest workspace also must not be represented as a passing scenario run.
- **Regression reliability/portability:** the full local suite had two failures. One room-admission fixture setup returned an unexpected 404 and passed when rerun alone; its root cause remains unresolved. The self-check test reproducibly hardcodes `/usr/bin/tmux`, absent on this Mac where tmux is `/opt/homebrew/bin/tmux` ([test](../../tests/hagency-up-selfcheck.test.js), lines 57, 59, 76).

## Independent Claude Code Fable cross-review

The requested parallel review completed successfully using Claude Code 2.1.247 and model `claude-fable-5`, with Read/Grep/Glob only and no MCP servers. It independently reviewed this revision without reading this report or the initial audit notes. Its [original static review](2026-09-05-claude-fable-review.md) is preserved separately, including its limitations. It sampled runner internals; the primary review's actual runner probes supply the evidence for F1–F2.

The two reviews independently overlap on request-id replay (F7), retirement eligibility (F3), body-controlled intake mode (F9), and the provenance spec/assertion disagreement (F8/F11). Fable treated that last issue primarily as a contract conflict; the consolidated review treats the explicit current task requirement as normative and the reproduced 200 response as noncompliance. The additional findings below were checked against source, with separate isolated reproductions where indicated.

### F14 — P1: An appservice token matching multiple registrations still dispatches

**Code:** [appservice-receiver.js](../../lib/appservice-receiver.js), lines 360–386 and 404–408. `setSides` accepts duplicate tokens across distinct sides. The authentication loop retains the first matching entry and never refuses ambiguity.

**Reproduced after Fable's finding:** two side entries with the same fixture token returned HTTP 200 and called the first side's callback. This violates the [side-provenance contract](../../specs/task-side-provenance.spec.md), lines 48 and 103–112, which requires HTTP 403 before dispatch when a token matches multiple authoritative registrations. Downstream representative/room checks remain relevant, so this probe does not establish arbitrary-room execution. Refuse ambiguous selection before assigning any registration provenance. The existing named test at [side-provenance.test.js](../../tests/side-provenance.test.js), lines 155–163, only exercises an unknown token.

### F15 — P1: A submit-only HTTP caller can claim another room's whitelist authority

**Code:** [backend-v2.js](../../backend-v2.js), lines 12950–12957, 13619–13642 and 13811–13841. The shared requester token grants submission, but it binds neither an authenticated Matrix room nor the body-supplied requester identity. The request's `projectRoomId` controls whitelist eligibility and side-budget accounting; `offer-book` also reports whitelist state for an arbitrary query room.

**Reproduced after Fable's finding:** with distinct operator and submit-only fixture tokens, the submit-only caller named a whitelisted victim room and an unrelated sender. No Matrix event was involved. The API returned an automatically active engagement and consumed that side's budget. This exposure requires the configured requester credential; it is not an unauthenticated default-path finding. If this token is distributed to project clients, they share authority over every whitelisted room rather than only their own.

**Requirement:** `REQ-CONTRIBUTION-CONSOLE-WHITELIST-KEY` and `REQ-CONTRIBUTION-CONSOLE-OFFER-BOOK`. Bind requester authority to a verified room/event or scoped transport identity before honoring automatic admission and room-specific reads. Preserve explicitly authorized operator submissions. The accepted document itself notes that outward exposure needs a scope table; a global submit token alone does not satisfy room attribution.

### F16 — P2: Requester responses disclose private owner and configuration details

**Code:** [backend-v2.js](../../backend-v2.js), lines 13372–13386 and 13663–13667. The auto-join response returns the internal binding outcome directly to a requester-token caller.

**Reproduced after Fable's finding:** without an owner, the response exposed `HAGENCY_OWNER_MXID`/`HAGENCY_OWNER_DM_ROOM` as remediation. With an owner, it exposed the configured private owner MXID and `from: "HAGENCY_OWNER_MXID"`. All values in the probe were synthetic. `REQ-CONTRIBUTION-CONSOLE-ROLES` ([requirements](../../knowledge/requirements/req-contribution-console.md), lines 53–56) expressly keeps owner MXIDs and environment variable names private. Return a borrower-safe result DTO; retain detailed remediation and owner attribution on authenticated operator/internal surfaces.

### F17 — P2: Removing one side resolves another side's identity alerts

**Code:** [backend-v2.js](../../backend-v2.js), lines 9982–9985; [alert-store.js](../../lib/alert-store.js), lines 358–380. The removal route calls `autoResolveByPrefix('agent_identity_unminted:')` for every side and filters the returned list afterward. The filter changes reporting, not the mutations already made.

**Reproduced after Fable's finding:** deleting side A returned only A's alert key, while an open unminted-identity alert belonging to retained side B was also marked `resolved` by `system`. This defeats ADR-016's side-scoped cascade and can hide actionable failures. Select keys for the removed side before resolving them.

### F18 — P2: Side removal omits remote membership cleanup before dropping its credential record

**Static path confirmed after Fable's finding:** [backend-v2.js](../../backend-v2.js), lines 9843–9877 and 9936–9939, revokes engagements directly, retires records and removes the side, bypassing the normal engagement `detachEngagement`/withdrawal path. [ProjectSideStore.removeSide](../../lib/project-side-store.js), lines 853–866, deletes the side record; the bridge's later [forgetRoomsOnSides](../../bridge-matrix.js), lines 4960–5009, removes local pointers only.

For a side with joined agent/representative accounts, this path provides no leave/revocation attempt while its acting credential is still available. ADR-016 decision 7's credential-last rationale explicitly includes room departure and token revocation. This was not tested against live Palpo, and it does not imply that the remote room owner cannot remove members later. Add credential-backed withdrawal/revocation before final removal, with truthful per-room failure reporting and a recoverable cleanup state.

### Contract questions retained from cross-review

- **Execution approval channel:** ADR-016's accepted “RESOLVED 2026-08-13” section, lines 655–713, calls for actionable borrower-side approval and demotes the configured provider owner to bootstrap fallback. The current [owner-approval task](../../specs/task-owner-ui-approval.spec.md), lines 122–135, still requires actionable details only in the encrypted owner DM and a redacted project-room notice. The implementation follows the latter. These accepted artifacts need an explicit reconciliation/successor scope; moving private controls into a public room is not an appropriate inferred fix. This remains a plan-level sign-off question.
- **Cross-family review:** an additional fixture confirmed `/api/capability` reports `review` with `crossFamilyOk: false` and `fillable: 0` for one Claude-family agent, while a whitelisted review request still auto-activates against it. `REQ-CONTRIBUTION-CONSOLE-CROSS-FAMILY` requires coherent fillability reporting. The contract should make clear whether an engagement represents a complete two-family service or one reviewer paired with an author elsewhere, then make admission and offer reporting agree. The review does not assume every review engagement must launch two agents.
- **Representative identity:** Fable flagged the reconstructed/lowercased representative in [bridge membership handling](../../bridge-matrix.js), lines 4777–4778, and the [join helper](../../lib/matrix-representative.js), line 1262. The source does diverge from the recorded-`/whoami` identity used by the provenance gate. No end-to-end case-mismatched identity reproduction was established here; retain this as a targeted follow-up, not a demonstrated impersonation exploit.
- **Other claims:** the intentional no-side migration path and permitted same-side warm-instance reuse were not counted as new defects by themselves. Fable's generic instruction-file concern is outside this product/spec review and is not adopted. Its test-file naming observation is valid: the side-provenance contract's prose still names `tests/bridge-side-provenance.test.js`, while the implementation file is `tests/side-provenance.test.js`; include that in F12's binding repair.

## Coverage of the requested workflow

| Area | Implemented and reviewed | Sign-off gap |
| --- | --- | --- |
| Local contributions and agent definitions | Presets, tiers, ceilings, seats, offers, whitelist, side allocation and agent APIs | F3–F5; demand-driven creation remains F10 |
| Request fulfillment | Matrix request handling, engagement state, verdict, binding and room admission | F3, F6–F8; no complete resource-to-new-agent fulfillment |
| Delegation | Durable task intents/inputs, parent/worker bindings, thread activation, dispatch/session routing and returned results | Runtime ownership defects F1–F2; actual multi-agent model work is unproven here |
| Agent integration | Shared/worktree workspace modes, exclusive/named resource leases, dirty-workspace recovery, task/result projection | F1–F2 permit post-settlement writes; no real producer → worker → integration-agent artifact chain was executed |
| Matrix and Palpo intake | Authenticated AS router, representative/room checks, push/edge/sync paths, deduplication, encrypted DM and owner-approval paths | F8–F9, F11, F14–F15 and F18; remote-mini topology was not exercised in this review |
| Browser/operator console | Live API proxy, contribution/request/agent/project views, rendered invariants and Playwright fixtures | F16–F17 affect privacy/operational truth; fixture browser checks do not prove live model work, delegated artifact correctness or integration |
| Scoped Agent Operations | Feature flag, encrypted enrolled-device bootstrap, loopback/PoP, revocation, scoped DTO/action flows and fixtures | Development release state; actual external client interoperability was not established |

The existing [e2e-full-loop.mjs](../../mockup/scripts/e2e-full-loop.mjs) drives a real Matrix request through console approval, checks binding/room admission, and revokes/withdraws it. It is a useful baseline, but it does not prove that a model completed a task, delegated work, or integrated another agent's output. Playwright exercises the web console; native Robrix UI and the model processes need separate observable evidence. The earlier live-run notes are historical evidence, not a new remote-mini test at this revision.

## Verification record and limits

Reused same-revision verification from the initial audit: full Vitest run **3,702 passed, 2 failed, 1 skipped** across 223 files; exact-bound run **149 passed** with 13 unresolved selectors. Static syntax, ESLint, CLI, architecture/dependency boundaries, router typecheck/build and remote-package checks passed after the normal remote build regenerated stale ignored output. Console fixture verification passed **110 static/rendered checks and 39 browser checks**. The `verify:ci` wrapper itself could not start because GNU `timeout`/`gtimeout` was absent; direct checks were run and are reported individually rather than claiming the wrapper passed.

This extended review added isolated API and actual runner-process probes for F1–F7/F10, the real push-listener mode probe for F9, and separate reproductions of F14–F17 and the cross-family discrepancy from Fable's review. F18 was confirmed by tracing the complete deletion/refresh path. No application or test implementation was changed. Fixture backend stores and sockets were temporary; fixture runtimes were cleaned up. No deployed Matrix server, remote mini, real task-executing model, production credentials, or external project was used by those probes. The separately authorized Claude Code reviewer used its model service for review only.

Local evidence is under `/Users/yuechen/Library/Caches/hagency-audit/2026-09-05/` (suite reports, selector audit and original provenance probe) and `/Users/yuechen/Library/Caches/hagency-review/2026-09-05/` (`contribution-probes.log`, `runner-probes.log`, `mode-probe.log`, `fable-validation.log`, independent reviewer output). Exploratory fixture setup failures in the contribution log are followed by separately labeled corrected reproductions; only the confirmed outcomes above support findings.

## Suggested order to reach sign-off

1. Fix runtime-tree termination and lease lifetime, and prove no writes remain possible after resource release.
2. Make engagement admission/fulfillment coherent: eligible side-bound agents, retirement fencing, owner binding, reliable replay, valid seat identity/periods, and the accepted demand-driven provisioning path.
3. Correct provenance retry semantics, unique registration selection, adapter-owned metadata and requester room authority; replace label-only coverage with actual required scenarios. Fix borrower-response privacy and side-scoped cleanup/alerts.
4. Reconcile the accepted approval-channel decision, repair acceptance bindings, clear regression failures and produce honest spec/release evidence.
5. Run the full remote-mini Palpo workflow using uniquely tagged fixtures: contribute/define resources → request/fulfill → perform a task → delegate to a second agent → return and integrate a verifiable artifact → exercise denial, crash/retry and cleanup. Capture browser evidence together with Matrix IDs, dispatch/task transitions, process termination and artifact assertions.
