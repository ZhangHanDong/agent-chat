> Independent static follow-up by Claude Code 2.1.247, model `claude-fable-5`. The first review used read-only tools; the second received current code excerpts with tools disabled. These are historical review observations on intermediate fixes, not a final execution or release certificate. The closure report records subsequent changes and qualifications.

# First follow-up

# Cross-review: HAFleet review-closure changes (branch `fix/spec-review-closure`)

**Verdict: the fixes for F1–F9 and F14–F17 are substantively correct in shape, and the new provisioning path (F10) is durably designed — but I found one crash-class defect in the new runner approval code, one liveness defect in the guardian/runner cleanup contract, one identity-shape bug that breaks the new roster gate for recorded identities, one permanent deadlock in the new side-removal sweep, and several reservation-accounting gaps.** Details with triggers and remedies below, ordered by severity. This is a static read-only review; nothing was executed.

## Defects in the new fixes

### R1 — P1: `answerApproval` can crash the runner host via an unhandled rejection
`router/src/runner.ts:445–471` — the awaits before the `try` block at line 473 are unprotected, and the function is invoked as `void answerApproval(message)` at line 538, so any rejection there is a process-level unhandled rejection (fatal by default in Node).

Two concrete triggers:
- The new turn-identity gate (line 446): a runtime sends an approval request for the current thread before `turn/start`'s response arrives, and that response is delayed past `acknowledgementTimeoutMs` — `withTimeout(turnIdentityReady, …)` rejects.
- The deny writes at lines 449 and 470: if the child died between emitting the request and the answer, `writeLine` returns an already-rejected promise (guard at line 210).

**Remedy:** move the whole body inside the try/catch (the catch at 512 already does the right thing: deny, terminate, settle unknown), or invoke as `void answerApproval(message).catch(…)` with the same handling. The same fix must land in `router/dist/runner.js` (dist is currently in sync with src, including this bug).

### R2 — P2: cleanup can hang a dispatch forever, holding its lease with no settlement
`router/src/runner-guardian.ts:71–83, 103–113` + `router/src/runner.ts:284–288, 365, 628, 639`. The guardian exits only after the `close` event (`finishWhenStopped` returns early until `runtimeClosed`). A descendant that escapes the process group (`setsid`) while inheriting the stdout pipe keeps `close` pending; the group itself is dead, so the SIGTERM/SIGKILL escalation cannot reach it. The guardian then never exits, and the runner's `terminateAndWait` is unbounded in every path — success (line 628), catch (639), and the Claude catch (365) — so the dispatch neither settles nor returns, and the workspace lease is held forever with no `outcome_unknown` record. That is fail-closed on the workspace but violates the spec's intent that uncertain termination produce an explicit quarantined settlement, and it permanently consumes the runner slot.

**Remedy:** let the guardian exit once `exit` has fired and `hasLiveGroupMembers()` reports the group dead (destroy/unpipe its stdio instead of requiring `close`), and/or bound `terminateAndWait` in the runner; on expiry settle `outcome_unknown` **without** releasing the lease.

### R3 — P1: `backendRosterAdmits` reads `agent.matrixIdentity` as a string; both writers use other shapes
`backend-v2.js:13269–13273` expects a string. The provisioning path writes an object `{mxid, sideId, kind}` (line 13595); the federation-reuse path writes a bare string (line 10552). Consequences:
- For provisioned agents (object form), the recorded identity never participates in the roster ruling — it silently falls back to the composed MXID, which is benign only while the two happen to be identical.
- For federation-reuse agents (string form, our-server MXID), `admitAgentToProjectRoom`/`withdrawAgentFromProjectRoom` read `matrixIdentity?.mxid` (lines 13353, 13302) → `undefined` → they compose a side-server MXID, which the roster check then refuses (server mismatch against the string-form authoritative). Admission and withdrawal permanently fail for a legitimate agent — fail closed, feature broken.
- `fulfillEngagementOnce:13590` (`if (!agents[agentName].matrixIdentity?.mxid)`) also reads `undefined` for the string form and would **re-mint** a duplicate side identity and overwrite the recorded federation identity — the exact duplication ADR-016 decision 2's reuse exists to avoid.

**Remedy:** normalize on one shape (the object), migrate the string writer at 10552, and read the authoritative MXID through a single helper used by the roster ruling and both admit/withdraw compositions.

### R4 — P2: side removal can 409 `cleanup_incomplete` forever
`backend-v2.js:9938–9962` sweeps memberships from **all** engagements (any state, `allocatedTokens > 0`) plus inactive bindings, and blocks removal if any withdrawal reports `left: false`. `withdrawAgentFromProjectRoom` refuses `not_a_registered_agent` for any agent already deleted from the registry (lines 13309–13312) — by design, since the fleet no longer vouches for that identity. But that means one historical row naming a deleted agent (e.g., an agent deleted while the side's homeserver was down, leaving the member seated) makes the side permanently unremovable: every retry hits the same refusal, and the retry the 409 response promises can never succeed.

**Remedy:** in this sweep, treat `not_a_registered_agent` (and similar "cannot ever act" outcomes) as reported-but-non-blocking; block only on retryable failures (network, credential errors). The refusal is still correct at the masquerade exit — the removal flow just must not wait on an action it is forbidden from performing.

### R5 — P2: `resourceRemaining` discards `committed` when no seat quota is declared
`backend-v2.js:13485–13497`: `known ? Math.min(ceiling, quota - committed) : preset.ceiling.tokens`. The same-seat committed sum (including `unprovisionedSeatCommitments`) is computed and then ignored in the unknown branch. Note the auto-join guard only fires when a declaration **exists** but is incomparable — an entirely undeclared seat passes. Triggers:
- Two concurrent whitelisted auto-join requests for a role with no existing agent, undeclared seat: the second arrives during the first's ~120 s provisioning exec, sees the full ceiling, and mints a **second** agent for the same side+role, over-committing.
- Requests from different sides repeatedly mint fresh agents from one preset, each granted the full preset ceiling — one contributed resource multiplied without bound unless a seat quota was declared.

**Remedy:** subtract committed in the unknown branch (`Math.max(0, ceiling - committed)`), or refuse auto-join provisioning on an undeclared seat when same-seat commitments already exist.

### R6 — P2: `seatRemainingFor` omits unprovisioned reservations
`backend-v2.js:12891–12911` sums `committedFor` only over **existing** agent records; a pending fulfillment whose agent record has not yet been created (the window during the provision exec) is invisible to it, even though `resourceRemaining` correctly counts it via `unprovisionedSeatCommitments` (13499–13508). A concurrent request served by an existing agent on the same seat is admitted against a quota that ignores the in-flight reservation. **Remedy:** add `unprovisionedSeatCommitments(seatId)` to the committed sum in `seatRemainingFor`.

### R7 — P2: side-budget internals disclosed to submit-only callers
`backend-v2.js:8853–8864`, reached from the requester-guarded request route at 13859: the `over_allocation` refusal returns exact `allocatedTokens`/`committedTokens`/`remainingTokens` for **any** `projectRoomId` the caller names. A requester-token holder can binary-search any side's remaining budget by probing amounts — the same class of provider-posture disclosure F15/F16 close elsewhere (offer-book deliberately withholds ceilings; the whitelist read was nulled for requesters). Secondarily, `overCommitMessage` (lib/engagement-store.js:72–101) can carry preset names and committed figures out through `respondEngagementError` on rare requester-path 409s. **Remedy:** for `req.engagementCaller === 'requester'` (and `'matrix'` where the bridge relays verbatim), return the reason code with a generic message and no numbers.

### R8 — P3: replay digest disagrees with creation digest on untrimmed room ids
`lib/engagement-store.js:343–351` digests raw `input.projectRoomId`; `createRequest` (502–508) digests the **trimmed** room. A body whose `projectRoomId` carries padding creates successfully, then its byte-identical replay throws `conflict` — a spurious idempotency failure (fail closed, but exactly the lost-response shape F7 was fixed for). **Remedy:** apply the same normalization in `replayRequest` before digesting.

### R9 — P3: budget-alert prefix resolution can still cross sides
`backend-v2.js:10010`: `autoResolveByPrefix('project_side_budget:<sideId>')` also matches `project_side_budget:<sideId>2` (side ids are server names — `palpo.test` vs `palpo.test2`). The unminted-identity half of the F17 fix was correctly narrowed to exact keys; the budget half wasn't. **Remedy:** exact `autoResolve(SIDE_BUDGET_ALERT_KEY(id))`, as line 8885 already does.

### R10 — P3: two smaller lifecycle gaps
- **Cancellation race leaks a join** (`backend-v2.js:13603–13622`): a reject verdict landing while fulfillment awaits `admitAgentToProjectRoom` runs its withdrawal *before* the join completes; `assertPending` then throws and the catch performs no withdrawal, leaving the agent joined with no live engagement, and `sweepProjectRoomMembership` only ever re-admits. Remedy: best-effort withdrawal in the catch when the engagement left `pending` after a join attempt.
- **Pending engagements survive side removal holding reservations** (`backend-v2.js:9843–9860`): the cascade only `revoke`s, which requires `active`; pending rows (including pending-with-fulfillment, which keep committing tokens via `holdsCommitment`) throw `conflict`, are warned, and persist until manually rejected. Remedy: reject pending ones in the cascade.

## What I verified as correct

- **F1/F2:** `runCodexDispatch` terminates and awaits the guardian before `settleAndRelease` (runner.ts:627–635); the Claude path releases only after guardian exit. The guardian signals the group after normal exit, escalates SIGTERM→SIGKILL, polls group death and excludes zombies. Real process-level tests exist, including a descendant matrix over `ignore`/`inherit` stdio (tests/router-runner.test.js:63, 84, 112). `dist/` matches `src/` on the symbols I checked.
- **F3/F4/F5/F6/F7:** `agentEligibleForRoom` fences retirement and side (applied to automatic selection, explicit hints, and re-checked before `decide`); `remainingFor({forAutoJoin})` refuses present-but-incomparable seat periods; seats are derived from **raw** records with no key material in the DTO; owner binding is committed before activation and persisted in the fulfillment plan for durable retry; replay resolves before the budget gate. The budget-check → reservation sequences are await-free, so single-process concurrency cannot interleave them.
- **F8/F9/F14:** provenance mode/side/registration mismatches are retryable throughout; the bridge throws → receiver 500 with no `rememberTxn`; the edge puller acks `ok:false`; the sync collector holds its cursor and circuit-breaks with the cursor held. The listener hard-codes `transport:{mode:'push'}`, adapters supply their own mode+sideId, the router cross-checks `transport.sideId` against the authenticated registration, and `matches !== 1` yields 403 before any dispatch (test asserts 403 with zero callback calls). The claim lifecycle (in-flight/settle/release) avoids unhandled rejections and follower-re-execution loss.
- **F15/F16:** requester callers get `allowAutoJoin:false`, a null whitelist read, and a redacted engagement DTO (owner MXIDs, env-var remediation, and `provisionHint` are not exposed externally).
- **F10:** phased, persisted fulfillment (`reserved→…→complete`) with a deterministic agent name, idempotent per-phase re-entry after crash, reservations held on failure, and per-engagement in-flight dedupe.

## Coverage limits — stated honestly

I did **not** read: `tests/review-closure.test.js`, `tests/spec-bindings.test.js`, `scripts/check-spec-bindings.js`, most of `tests/side-provenance.test.js` bodies (I verified the ambiguous-credentials test body and only the title of the repaired retryable test, so F11's matrix repair is unconfirmed), `bot-commands.js`, the rest of `appservice-sync.js`, the engagement API test files, the remaining bridge changes (owner-DM paths, `forgetRoomsOnSides`), `serializeAgent` itself, or `router/src/store.ts` settlement internals; dist parity was a symbol spot-check, not a diff. I ran nothing. One observation left unconfirmed: `runClaudeDispatch` never reads `mayWrite` — Claude confinement rests entirely on caller-supplied CLI args, which I did not trace.

Per the task's own acknowledgment: the external release gates (real-model continuity probe, agent-ops release manifest, `agent-spec` lifecycle output, remote Palpo/mini runs — F13) cannot be established by static review and remain open regardless of the above.

Suggested order: R1 and R3 first (crash and broken identity gate), then R2/R4 (liveness/deadlock), then the accounting trio R5/R6/R8, then the disclosure and cleanup items.

# Second follow-up

# Re-review: Matrix work queue, acknowledgement, cancellation, capacity, lifecycle

**Verdict: the queue's core contract is sound — persist-before-acknowledge for identity, lease-based reclaim, dedupe on non-complete rows, and the retryable `bridge_work_pending` shape all hold up — and R1, R2, R3, R5, R9, and R10a are visibly closed in the supplied code. I found one new race in the cleanup-confirmation channel, one missing catch that turns a pending bridge job into a false 500 after activation, one still-open remnant of the R4 deadlock for the new bridge-leave codes, and two idempotency gaps in the identity executor.**

## New defects

### N1 — P2: `cleanup_complete` can be observed after `exit`, quarantining clean completions
`router/src/runner.ts` diff: `spawnVerified`'s `message` listener populates `confirmedCleanups`; `terminateAndWait` resolves `confirmedCleanups.has(child)` when `childExit` (the `exit` event) settles, and `runClaudeDispatch` checks `!confirmedCleanups.has(child)` immediately after awaiting `exitPromise`. The guardian's `send(msg, callback)` callback fires on flush to the pipe, not on parent receipt, and Node does not order the child's final `message` event before `exit` — the pipe read and the process reap are independent event sources, and message-after-exit is permitted. When `exit` wins the race, a genuinely clean dispatch is judged unconfirmed: Codex throws "runner cleanup could not be confirmed" and settles `outcome_unknown`; Claude returns `outcome_unknown` with the work's final text demoted. This is nondeterministic, load-sensitive, and silently discards completed work (fail-closed, but wrongly).

**Remedy:** confirm on a channel that is ordered. Either wait for the child's `disconnect`/`close` (pending IPC messages are emitted before `disconnect`) before reading `confirmedCleanups`, or use the guardian's exit status as the signal — every guardian exit except the reserved deadline `125` passes through `finishWhenStopped`, so "exited normally with code ≠ 125" is equivalent to confirmation and race-free.

### N2 — P2: the registrationToken join branch lacks the catch its leave counterpart has
`backend-v2.js:13467–13469` vs `13370–13374`. `withdrawAgentFromProjectRoom` wraps `runMatrixWork` in try/catch and converts a timeout into `{ left:false, reason:'bridge_work_pending' }`. The join branch in `admitAgentToProjectRoom` does not: `awaitMatrixWork`'s 20 s timeout (or `runMatrixWork`'s synchronous throw when `getBridgeSecret()` is empty) rejects straight through. On the provisioning path that is caught at 13700 (fine, 503). On the **non-provisioning approve path** (13632) the admission is awaited **after** `decide` — the rejection escapes `fulfillEngagementOnce` as a plain `Error`, so the caller receives a 500 "failed to fulfill engagement" for an engagement that is already active with tokens committed, and no `roomAdmission` outcome is reported or recorded. A retry returns the active engagement (13598) but never re-attempts admission on that path.

**Remedy:** `.catch(() => ({ joined:false, reason:'bridge_work_pending' }))` on the `runMatrixWork` join branch, matching `joinRoomOnSideAsAgent`'s never-throws contract.

### N3 — P2: side removal still deadlocks on terminal bridge-leave outcomes (R4 residue)
`backend-v2.js:10008` exempts exactly one reason: `not_a_registered_agent`. The new bridge-executed leave path introduces outcomes that are terminal — they will repeat identically on every retry — yet are treated as retryable `cleanup_incomplete`:
- `agent_credential_unavailable` (lib/matrix-work-executor.js: bridge holds no token, or `stored.mxid !== job.mxid` after an identity re-composition);
- `credential_side_mismatch` (stored homeserver/serverName no longer match the side record, e.g. after an apiBaseUrl edit);
- `side_or_agent_unavailable` minted at claim time (backend-v2.js:7713–7716).

Any one such membership row makes `DELETE /api/project-sides/:id` answer 409 forever, though the bridge can never perform the leave. Same failure class R4 fixed for the roster refusal, reintroduced by the new transport.

**Remedy:** classify these codes as reported-but-non-blocking in the 10008 predicate (keep `bridge_work_pending` and `matrix_http_*` blocking, since those are genuinely retryable), or add an operator override that records unswept memberships in the response.

### N4 — P3: `identity_mismatch` is judged after minting but before persisting, breaking the executor's own invariant
`lib/matrix-work-executor.js`, identity branch: the order is mint → check `minted.mxid !== '@' + localpart.toLowerCase() + ':' + serverName` → **return failure** → only then `saveCredential`. A mismatch (mixed-case localpart in the job, or homeserver canonicalization) discards a just-issued access token: the account exists on the customer's homeserver, nobody holds its token, and every redelivery re-registers the same localpart into `M_USER_IN_USE` → permanent `registration_failed`. This directly contradicts the adjacent comment "Persist BEFORE acknowledging."

**Remedy:** validate the localpart *before* minting (refuse non-lowercase input up front — the backend composes it at 13672 without lowercasing), and persist the credential before rendering any post-mint verdict.

### N5 — P3: mint-then-crash window wedges the localpart permanently
Same file: a bridge crash between a successful `mintAgentIdentity` and `saveCredential` loses the only copy of the token; lease expiry redelivers the job, re-registration hits `M_USER_IN_USE`, and the job fails terminally forever. At-least-once redelivery cannot repair a non-idempotent registration. Narrow window, but unrecoverable without manual homeserver admin action. **Remedy:** make registration recoverable — e.g., register with a password derived deterministically from bridge-local secret material so a redelivery can fall back to `/login`, or durably record a pre-mint intent so the wedge is at least self-diagnosing.

### N6 — P3: over_commit refusals embed internal spend context on an externally reachable path (R7 residue)
`backend-v2.js:13627` now attaches `overCommitMessage(e, alloc, remaining, ceilingSpendFor(e.agent))` — preset name, committed and measured figures, period key — inside `fulfillEngagementOnce`, which runs on the bridge-relayed auto-join path (`autoJoin: true`). Per the previously reviewed `respondEngagementError`, `error.message` is returned to the caller, so a borrower-side refusal can carry the provider's internal accounting. (The message construction is in the supplied code; the delivery route is carried over from the earlier read.) **Remedy:** attach the spend context only for operator callers; return the bare `over_commit` reason to `requester`/`matrix` callers.

## Checked and sound

- **Store atomicity/rollback** (`lib/matrix-work-store.js`): `mutate` clones before the mutation closure runs, so in-place `Object.assign` in `claim`/`complete` rolls back correctly on persist failure; pruning inside `mutate` persists the reassigned array and restores the pre-push snapshot on error.
- **Lost acknowledgements:** identity persists the credential before completing; a lost `complete` is healed by lease reclaim + `readCredential` short-circuit; join/leave are idempotent at the homeserver; a stale `claimToken` after reclaim correctly 409s and the reclaimer's result stands. Duplicate `complete` with the same token is idempotent.
- **Removal gating:** in-flight fulfillments for the side are awaited (9980–9982) and `unsettled()` blocks removal while any bridge job for the side is pending/running (9983) — timeouts surface as retryable `bridge_work_pending`, consistent with that gate.
- **Guardian bounds:** the 2 s SIGKILL, 25 ms poll, and 5 s `cleanupDeadline` with reserved exit 125 close R2's unbounded hang; `retireAgentsForSide` now rolls back on persistence failure; alert resolution uses exact keys (R9); the fulfillment catch detaches on cancellation/side-deactivation (R10a); `recordedAgentMxid` handles both identity shapes and the roster's ambiguity check refuses duplicate recorded MXIDs (R3); `resourceRemaining` subtracts committed in the undeclared-seat branch (R5, now conservative in the right direction); `answerApproval` is fully guarded and its invoker catches (R1).

## Coverage limits

I did not execute anything and had no live Matrix access. Not verifiable from the supplied excerpts: R6 (`seatRemainingFor`), R8 (replay digest trim), R10b (pending engagements in `endEngagementsAndBindingsForSide` — only its tail was supplied), the `agentCredential`/`saveState` shape contract on the bridge side, `respondEngagementError`'s current body (N6 relies on its previously reviewed behavior), and the extended `agentEligibleForRoom(agent, room, id)` third parameter introduced at 13669. Minor non-blocking observations not listed above: the bridge's poll loop `break` on a claim-side auto-failed job defers remaining jobs to the next poll tick (latency only), and the enqueue dedupe key omitting `mxid` can carry a stale composed MXID for one job generation before self-healing.