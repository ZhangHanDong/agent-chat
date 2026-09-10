> Independent static review by Claude Code 2.1.247, model `claude-fable-5`, at commit `75ca1ecbf8c4623359094f000fa4968693f4a27e`. Read-only Read/Grep/Glob tools; no tests or services run by this reviewer. The text below is preserved as returned. Its claims and recommendations are not all adopted; see [the consolidated review](2026-09-05-spec-gap-review.md) for validation, qualifications and reconciliation.

The review is complete — I've traced all the requested flows through the specs, knowledge base, backend, bridge, stores, proxy, and test assertions. Here is the full review.

---

# Hagency Independent Code Review — commit `75ca1ec`

**Scope:** `/Users/yuechen/home/hagency` at `75ca1ecbf8c4623359094f000fa4968693f4a27e`, reviewed read-only against `specs/project.spec.md`, the 8 task specs, and accepted `knowledge/` requirements/decisions (with ADR-013's pricing withdrawal and ADR-016's identity/provisioning amendments treated as current truth). **No tests were executed**; all findings are from static reading of source and test assertions. `docs/progress.md` / `docs/agent-knowledge.md` were not consulted.

**TL;DR:** The core chain (offer → whitelist → engagement → budget → binding → room admission → revocation) is implemented carefully and mostly matches its specs, with unusually honest self-documentation. No P0. The substantive gaps cluster at two seams: (1) the appservice router accepts a token that matches **two** registrations by first-match where the side-provenance spec mandates HTTP 403, and the test named after that scenario only exercises the wrong-token half; (2) the HTTP engagement surface trusts a **caller-claimed** `projectRoomId` under the shared requester credential, which the whitelist-key requirement forbids for room identity. Beyond that: an idempotent-replay ordering bug in the budget gate, a cross-side alert-resolution bug in the side-removal cascade, and several accepted-document conflicts that no one has reconciled (most notably ADR-016's "the borrower approves" ruling vs. the still-governing owner-DM approval spec and implementation).

---

## A. Confirmed code defects

### P1-1 — Ambiguous `hs_token` selects a registration by first-match instead of refusing 403

- **Location:** `/Users/yuechen/home/hagency/lib/appservice-receiver.js:404-408` (`createAppserviceRouter.handle`)
- **Violates:** `specs/task-side-provenance.spec.md:48` ("An unknown token or one matching multiple local registrations returns HTTP 403 before dispatch; **first-match selection is not authority**") and the critical scenario at `:103-112` (`side_provenance_rejects_bad_or_ambiguous_credentials`).
- **Trigger:** two configured sides whose credential records carry the same `hs_token` — an operator installing one registration file for two sides, a copy-paste duplication in the side store, or a bad `inbound-credentials` payload. `setSides` (`lib/appservice-receiver.js:360-386`) performs no duplicate-token detection, and the match loop keeps the first hit: `if (!match) match = { sideId, entry }`.
- **Actual vs required:** actual — the transaction is dispatched under whichever side iterates first, acquiring that side's registration identity, representative, room-relation authority, and dedup window. Required — HTTP 403 before dispatch, zero ingress.
- **Impact:** the entire provenance model (ruling C) rests on "the credential uniquely selects one registration." Under duplication, events are attributed and claimed under a nondeterministic side; room-relation proofs use the wrong representative; dedup claims land in the wrong scope.
- **Test gap that masks it:** `tests/side-provenance.test.js:155-163` carries the spec's exact title but asserts only the *wrong-token* branch; no fixture configures two registrations with one token. A matching test name is currently standing in for unimplemented behavior.
- **Correction:** in `handle()`, continue scanning after the first match; if a second entry's token also matches, log both fingerprints and return 403 without dispatch. Optionally refuse duplicate tokens at `setSides`. Extend the existing test with the two-registration fixture.

### P1-2 — HTTP engagement intake accepts a caller-claimed `projectRoomId` under the shared requester credential

- **Location:** `/Users/yuechen/home/hagency/backend-v2.js:13535` (`POST /api/engagements`, guarded by `requireRequester` at `:12952-12958`), room taken from `req.body.projectRoomId` at `:13620` and `:13626`; also `GET /api/offer-book?projectRoomId=…` at `:13811-13843`.
- **Violates:** `knowledge/requirements/req-contribution-console.md:80-83` (REQ-CONTRIBUTION-CONSOLE-WHITELIST-KEY: "The whitelist MUST key on the **authenticated** `projectRoomId` reported by Matrix… MUST NOT accept a room id supplied in message content"). The Matrix path honors this (`lib/bot-commands.js:414-427, 525-546` — room and event id come from the authenticated event); the HTTP path does not: the requester credential authenticates *the right to submit*, not *which room is asking*.
- **Trigger:** any holder of `HAGENCY_REQUESTER_TOKEN` (a single shared secret; `lib/bot-commands.js:121-124` shows it is intended to travel to submitting parties) who knows or guesses another project's whitelisted room id.
- **Actual vs required:** actual — a request naming a foreign whitelisted room auto-joins under that room's trust: the victim side's budget is committed (`refuseOverSideAllocation` charges the room's server, `:13619-13623`), an owner binding is written, and a real Matrix invite/join is fired into the victim's room (`admitAgentToProjectRoom`, `:13662`). `offer-book` likewise answers "is room X whitelisted?" for any X (`:13840`). Required — room identity on this surface must be authenticated or the surface must not honor whitelist/auto-join at all.
- **Impact:** cross-tenant budget consumption, unsolicited agent admission into another customer's room, and whitelist-state enumeration — all under a credential the design intends to be low-privilege.
- **Correction (minimal):** when the caller authenticated with the requester token (not the operator bearer), refuse auto-join routing for the claimed room — force `notWhitelisted`/pending — and restrict `offer-book`'s `whitelisted` field to Matrix-originated calls (the bridge already authenticates via requester token; distinguish it with a bridge-only header or per-side requester tokens). Longer term this is the "scope table before outward exposure" open question in `req-contribution-console.md:257-259`.

### P2-1 — Idempotent replay of a committed request is refused by the side-budget gate before the dedup lookup runs

- **Location:** `/Users/yuechen/home/hagency/backend-v2.js:13619-13624` (`refuseOverSideAllocation` runs first) vs. `/Users/yuechen/home/hagency/lib/engagement-store.js:469-483` (`requestId` dedup lives inside `createRequest`).
- **Violates:** `knowledge/requirements/req-contribution-console.md:94-100` (REQ-CONTRIBUTION-CONSOLE-IDEMPOTENT: "Repeating the same `request_id` with the same request digest MUST return the existing engagement") and its scenario at `:168-172`; PRD gate A-R0-1 as cited in Traceability.
- **Trigger:** an auto-joined request commits `N` tokens; the same Matrix event is redelivered (bridge restart clears the in-memory claim map `bridge-matrix.js:4573`, sync-batch replay, or edge redelivery) while `allocated − committed < N`. The replay's budget check computes remaining *including the first commitment* and answers 409 `over_allocation` — and files a spurious `project_side_budget` operator alarm (`raiseSideBudgetAlarm`, `backend-v2.js:8854`) — without ever reaching the store's "same id + same digest → return prior" branch.
- **Actual vs required:** actual — 409 + false alarm + "Request refused" posted into the borrower's room; required — the existing engagement returned unchanged.
- **Impact:** no double-spend (the failure direction is safe), but a MUST-level idempotency break under the at-least-once transport the system is explicitly built on, plus alarm noise that trains operators to ignore the budget page. Untested: `tests/api-engagement-side-budget.test.js` and `tests/engagement-store.test.js:294-357` cover each half separately, never the ordering.
- **Correction:** before the budget gate, look up `requestId` (+digest match) in the engagement store and return the prior engagement; only a genuinely new request should reach `refuseOverSideAllocation`.

### P2-2 — Removing a project side auto-resolves `agent_identity_unminted` alerts belonging to *every other* side

- **Location:** `/Users/yuechen/home/hagency/backend-v2.js:9982-9985` — `alertStore.autoResolveByPrefix('agent_identity_unminted:')` resolves all alerts of that type (see `lib/alert-store.js:358-380`, which mutates every prefix match); the `.filter(...includes(removedSideId))` on the next line trims only the *reported* list, not the mutation.
- **Violates:** ADR-016 decision 7 / row 7 ("SIDE-SCOPED alerts are resolved by dedupe prefix" — scoped to the removed side) and the alarm design intent of decision 6.
- **Trigger:** two sides, each with an open `agent_identity_unminted:<agent>:<side>` alert; operator deletes side A.
- **Actual vs required:** actual — side B's unminted-identity alert is silently marked resolved-by-system; required — only alerts naming the removed side are swept.
- **Impact:** a live actionable alert on a healthy side disappears without recovery, which is precisely the "trust the next one less" failure the cascade comment warns about.
- **Correction:** resolve by the full per-side prefix (the dedupe key format already embeds the side; filter *before* resolving, or call `autoResolve` per matching key).

### P2-3 — Retired agents remain selectable for new engagements

- **Location:** `/Users/yuechen/home/hagency/backend-v2.js:12818-12835` (`agentForRole` filters only by tier), `:12916-12929` (`remainingFor`), `:9879-9891` (`retireAgentsForSide` sets `online:false`, `retiredAt`, `offlineReason` — none of which any selection path reads; `isAgentRecord` at `:1356-1358` ignores retirement).
- **Violates:** ADR-016 decision 7 ("retires agent identities: deactivated, **unable to be dispatched**, MXID retained for attribution").
- **Trigger:** delete a project side (retiring its agents), then a `!request`/`POST /api/engagements` for a role the retired agent's preset still qualifies for.
- **Actual vs required:** actual — `agentForRole` can name the retired agent, `serving` discloses it to the borrower, and `decide()` will allocate against its ceiling; on the contributor's own-server rooms nothing later blocks it (cross-side rooms are caught by `backendRosterAdmits` ② at `:13206`). Required — a retired identity serves nothing new.
- **Correction:** exclude records with `retiredAt`/`offlineReason` beginning `retired:` from `agentForRole`, the requested-agent hint check (`:13553-13570`), and `resourceForRole` candidate agents.

### P2-4 — Side-removal cascade never withdraws agents (or the representative) from the customer's rooms, then destroys the only credential that could

- **Location:** `/Users/yuechen/home/hagency/backend-v2.js:9843-9877` (`endEngagementsAndBindingsForSide` calls `engagementStore.revoke` directly — not `detachEngagement`) and `:9905-9940` (route retires agents, then `removeSide`; no `withdrawAgentFromProjectRoom(s)` call). Contrast the per-engagement revoke route `:13759-13779`, which does withdraw.
- **Violates:** ADR-016 decision 7's stated order rationale (`knowledge/decisions/adr-016…md:556-561`: "leaving rooms, revoking tokens, and any farewell … all require the token that deletion would already have destroyed" — the reason the credential is forgotten last), and the hygiene rule the code itself documents at `backend-v2.js:13098-13102`.
- **Trigger:** `DELETE /api/project-sides/:id?force=true` (or after deactivation) with agents joined to rooms on that side.
- **Actual vs required:** actual — engagements end and commitments release, but every joined `@ac_*` account and the representative remain members of the customer's rooms forever; after `removeSide` the acting credential is gone, so no later cleanup is possible from Hagency. The `cascadeNote` (`:10004-10006`) does not disclose the skipped step. Required — leave rooms while the credential still exists (the order is the whole point of "credential last").
- **Correction:** inside the cascade, before `removeSide`, run `withdrawAgentFromProjectRoom` for each (agent, room) reached by the ended engagements/bindings (best-effort, reported per room, as the existing helpers already do), and have the representative leave; report unremovable seats in the response.

### P2-5 — Intake `mode` is read from the transaction body, so a homeserver push can select or poison the mode

- **Location:** `/Users/yuechen/home/hagency/lib/appservice-receiver.js:268` (`mode: typeof body?.mode === 'string' ? body.mode : undefined`), consumed at `/Users/yuechen/home/hagency/bridge-matrix.js:5189` (`mode: meta?.mode ?? 'push'`). The edge/sync adapters legitimately stamp `body.mode` (`lib/appservice-puller.js:193`, `lib/appservice-sync.js:378`), but the push listener forwards the homeserver's raw body on the same channel.
- **Violates:** `specs/task-side-provenance.spec.md:39` ("Incoming fields cannot replace authenticated provenance or **select the intake mode**") and `:48` ("The listener supplies push mode…").
- **Trigger:** a project side's homeserver (authenticated with its own `hs_token`) PUTs a transaction whose JSON includes `"mode": "sync"`, `"edge"`, or garbage.
- **Actual vs required:** actual — a valid mode string relabels a push as edge/sync in provenance, logs, and diagnostics; an *invalid* string makes `buildSideProvenance` throw before the gate (`lib/side-provenance.js:96-98`), which the receiver converts to a blanket 500 (`lib/appservice-receiver.js:269-279`) — an infinite homeserver retry loop that self-inflicts head-of-line blocking for that side. Required — the listener path supplies `push` unconditionally; body fields never select mode.
- **Impact:** bounded to the authenticated side's own traffic (mode is diagnostic, not identity), but it is a direct Must-Not violation and a mislabeling vector for the audit trail the provenance log exists to provide.
- **Correction:** have the listener adapter strip/override `body.mode` to `'push'` before handing to the router, or carry mode out-of-band from each adapter rather than in the shared body.

### P2-6 — Bind-failure remedy leaks the provider's environment variable names to the borrower over the HTTP surface

- **Location:** `/Users/yuechen/home/hagency/backend-v2.js:13372-13376` (`bindEngagement` error names `HAGENCY_OWNER_MXID` / `HAGENCY_OWNER_DM_ROOM`), returned verbatim as `binding.error` in the `POST /api/engagements` auto-join response (`:13663-13667`) — a route authenticated by the *requester* (project-side) credential.
- **Violates:** `knowledge/requirements/req-contribution-console.md:53-56` (REQ-CONTRIBUTION-CONSOLE-ROLES: "environment variable names are private, and a failure reported to a project MUST NOT carry the provider's own configuration as its remedy").
- **Trigger:** whitelisted auto-join on a deployment with no resolvable owner. The Matrix path deliberately withholds this (`lib/bot-commands.js:576-587`), but a programmatic requester posting to the API receives the full remedy text.
- **Correction:** when the caller authenticated with the requester token, replace `binding.error` with the neutral "could not be attached; the contributor has been notified" the bridge already uses; keep the full text for operator-bearer callers and the engagement record.

### P2-7 — Cross-family role (`review`) can auto-join served by a single model family

- **Location:** `/Users/yuechen/home/hagency/lib/engagement-store.js:176-226` (`routeRequest` has no cross-family input), `/Users/yuechen/home/hagency/backend-v2.js:12818-12835` (`agentForRole` checks tier only); constraint declared at `/Users/yuechen/home/hagency/lib/role-capacity.json:44-49` and enforced only on the capability read (`backend-v2.js:12668-12689`, `fillable: 0`).
- **Violates:** the coherence half of `knowledge/requirements/req-contribution-console.md:76-78` (REQ-CONTRIBUTION-CONSOLE-CROSS-FAMILY: "Any field summarising fillability MUST agree with the cross-family constraint reported beside it") — `/api/capability` reports `review` unfillable for a one-family fleet while `!request review N` on a whitelisted room auto-joins it with one agent and reports `serving`.
- **Impact:** the surfaces disagree; a borrower is granted a "Reviewer" the capability model says cannot exist, defeating the role vocabulary's meaning (ADR-013 decision 3).
- **Correction:** in `POST /api/engagements`, when `roleCapacity.roles[role].crossFamily` is true and the qualified fleet spans <2 families, route to approval (never auto-join) and attach a hint naming the constraint.

### P2-8 — Knock-answer membership handler compares a *composed, lowercased* representative instead of the `/whoami`-recorded MXID

- **Location:** `/Users/yuechen/home/hagency/bridge-matrix.js:4777-4778` (`@${senderLocalpart.toLowerCase()}:${sideId}` vs. `state_key.toLowerCase()`), inside `onAppserviceMembership`.
- **Violates:** `specs/task-side-provenance.spec.md:49` ("Use the exact representative MXID recorded from `/whoami` for the selected registration, **never a reconstructed localpart**") and the case-preservation rule at `:31`; also the design rule documented in the same repo at `lib/matrix-representative.js:112-117`.
- **Trigger/impact:** low today (`sender_localpart` is forced lowercase at registration generation, `lib/appservice-receiver.js:97`), but a homeserver that canonicalizes differently, or a hand-written registration with mixed case, makes the join/trust action target a differently-cased identity than the one the provenance gate proved; localparts are case-sensitive in Matrix. The provenance *gate* itself does this correctly (`representativeMxidFor`), so this is an inconsistency between the gate and the action behind it.
- **Correction:** use `registered.representative.mxid` (already available in the snapshot) for the `state_key` comparison and the join.

---

## B. Contract / governance conflicts (accepted documents that disagree)

### G-1 (P1) — Execution-approval authority: ADR-016's accepted resolution contradicts the still-governing approval spec and the shipped behavior

- ADR-016, "RESOLVED 2026-08-13" (`knowledge/decisions/adr-016…md:655-713`): the operator ruled the **borrower** approves execution; "the borrower gets the actionable request, and the contributor gets the notice," explicitly noting "none of which is built."
- `specs/task-owner-ui-approval.spec.md:122-135` (Accepted, satisfies REQ-OWNER-UI-APPROVAL/ADR-003) still mandates the opposite: actionable structured verdicts **only** in the encrypted owner DM; public room redacted and non-actionable. Implementation follows the spec (`buildOwnerApprovalRequest`/`buildPublicApprovalNotice`, `bridge-matrix.js:2520-2555`; verdict validation `lib/approval-store.js:483-545` — correctly fail-closed for what it implements).
- **This is an unresolved conflict between two Accepted artifacts.** Every new project-side deployment stamps `owner_mxid` audit rows and trust anchors under the model ADR-016 says is wrong, deepening the "unreversible part" the ADR itself flags (`:694-697`). No spec revision or ADR-003 renegotiation exists in the tree.
- **Direction:** either amend `task-owner-ui-approval.spec.md` (and ADR-003) to the borrower-decides model, or record in ADR-016 that the resolution is deferred and the owner-DM model remains normative until a named successor task. Today a reader cannot tell which document wins.

### G-2 (P2) — Invalid/inconsistent transport provenance: spec says retryable 500; implementation and tests pin terminal-skip-with-200, under a reason code the spec doesn't define

- Spec: `specs/task-side-provenance.spec.md:54` ("missing, **invalid, or inconsistent** adapter provenance yields `invalid_transport_provenance` … HTTP 500 … whole batch retryable") and the critical scenario at `:114-125` (explicitly includes "an invalid mode" and "a different configured collector side").
- Implementation: only *missing/malformed* is retryable; a disagreement (wrong sideId, forged registration, alien mode) is **terminal** `provenance_mismatch` — logged, skipped, batch may 200 (`lib/side-provenance.js:48-81`, `bridge-matrix.js:4409-4417, 4431-4441`). `provenance_mismatch` is not in the spec's reason vocabulary.
- Test: `tests/side-provenance.test.js:165-198` is titled `…keeps_batch_retryable` yet asserts `resolves` (terminal) for three of its four fixtures — the title claims the spec's behavior, the assertions pin the deviation.
- Practical risk is limited (router entries and the inbound snapshot refresh atomically from one payload, `bridge-matrix.js:5112-5193`, so a transient disagreement window is hard to construct), and terminal-on-contract-violation is defensible — but the accepted spec text, the code, and the test currently say three different things. Amend the spec or change the disposition; don't leave the test title asserting the opposite of its body.

### G-3 (P2) — ADR-016 decision 1 cardinality ("one agent instance per engagement, minted on acceptance") vs. implemented per-side identity reuse

- Implementation composes one `@ac_<agent>:<side>` identity per (agent, side) and reuses it across all engagements (`backend-v2.js:13293`, `backendRosterAdmits` `:13197-13217`); `mintAgentIdentity` remains largely test-exercised per the ADR's own row 4. The ADR's status rows acknowledge partial build, and its Alternatives section even argues per-engagement identity is "a deliberate accounting choice" — but neither the requirement layer nor the spec layer records the reuse model as the accepted end-state, and `committedForProjectSide`'s own comment (`lib/engagement-store.js:663-669`) notes side attribution "will understate real consumption until minted agents carry their side."
- **Direction:** a short amendment settling per-engagement vs per-side identity as the target, so implementers stop navigating by status-row archaeology.

### G-4 (P2, disclosed) — The budget escape for rooms on servers with no side record

`backend-v2.js:8675-8678` deliberately lets an engagement on an unconfigured server bypass the side budget entirely (`requireSide:false`), and ADR-016 records this as "the migration state, not the design." It is honestly named in code and ADR but appears in no requirement; combined with P1-2 it means a requester-token holder can also route spend entirely outside any side ledger by naming a room on an unconfigured server (the *contributor's* per-agent ceiling still gates). Worth a requirement-level statement with an expiry condition.

---

## C. Verification-only gaps (behavior may be right; the evidence isn't)

1. **Spec-bound test file name mismatch.** `specs/task-side-provenance.spec.md:57` binds the titles to `tests/bridge-side-provenance.test.js`; they were implemented in `tests/side-provenance.test.js`. Any lifecycle/selector run keyed to the spec's named file selects zero tests — which the spec itself says "prove[s] no behavior."
2. **Ambiguous-credential scenario untested** (see P1-1): the title exists, the two-registration fixture does not.
3. **`…keeps_batch_retryable` asserts terminal** for 3 of 4 fixtures (see G-2), and that test drives `handleAppserviceEvents` directly rather than "actual push, edge, and sync adapters through the real router," which the spec's Must (`:34`) and test-binding (`:57`) forbid substituting for these scenarios. Several other titles in the file do use the real listener/puller/sync drives.
4. **No test for idempotent replay across budget exhaustion** (P2-1) — store tests and budget tests each pass in isolation.
5. **ADR-016 federation-positive branch** (`reusedIdentity`) remains unprovable on Palpo 0.4.0 per the ADR's own record; nothing in-tree substitutes.
6. **Console-side obligations not verified here:** blank-is-never-zero, declared-and-unenforced labeling, `overBy` meter rendering (REQ-…-BLANK/UNENFORCED/METERING-SCOPE and ADR-016 decision 6's display duty) live in `mockup/` invariant suites (`scripts/check-invariants.mjs` etc.) that I did not execute.
7. **REQ-CONTRIBUTION-CONSOLE-BOUNDED's DM-room release rule** ("a room whose invitation is merely unaccepted MUST NOT be [released]") was not traced to its bridge implementation in this review.

---

## D. Areas reviewed and found sound (with evidence)

- **Engagement store:** routing order, no-offer ≠ unlimited, unstated-rate refusal, `count` enforcement, null-ceiling refusal, floor-then-validate, rollback-on-failed-persist including audit-trim restoration (`lib/engagement-store.js:176-226, 253-315`). Matches REQ-…-ROUTE/UNKNOWN-LIMIT/DURABLE.
- **Requester scope split:** verdict/revoke/offers/whitelist are operator-bearer only; requester submits and reads the deliberately narrowed `offer-book` (published-only, no ceilings, own-room whitelist state) — REQ-…-SUBMIT-SCOPE/OFFER-BOOK implemented (`backend-v2.js:12931-12958, 13811-13843`), subject to P1-2.
- **Both budget admission points** (auto-join and verdict) gate against the side allocation with recomputed remaining and full alarm actionability; over-allocation names side, figures, remedy (`backend-v2.js:13619, 13697; 8788-8867`), with two-side isolation and alarm-dedupe covered by `tests/api-engagement-side-budget.test.js`.
- **Approval machinery:** strict two-shape verdict parsing with no hybrid (`bridge-matrix.js:2557-2598`); store-side validation of sender/room/agent/project/room/digest/pending/expiry and CAS single consumption (`lib/approval-store.js:483-589`); spec-named tests exist with real assertions (`tests/approval-store.test.js`, `tests/bridge-matrix-approval.test.js`, `tests/bot-ctl-room-guard.test.js`).
- **Provenance gate ordering** (registration recheck → representative room relation via the side's own credential → claim → typed path), retryable-vs-terminal propagation to receiver 500/no-ack/held-cursor, in-flight claim leadership with failure re-entry, `unhandledRejection`-safe settle (`bridge-matrix.js:4401-4746`), canonical idless-invite identity with delimiter-collision-proof JSON (`lib/side-provenance.js:190-262`).
- **Receiver txn idempotency** (remember only after success), timing-safe token compare, token fingerprints in refusal logs, per-side dedup windows preserved across refresh (`lib/appservice-receiver.js`).
- **Console proxy:** default-deny read/write allowlists, canonicalize-before-match with rebuilt outbound path, `%`-refusal, `.`/`..` refusal, cross-site write refusal via `Sec-Fetch-Site`, `redirect: 'manual'`, and deliberate exclusion of every credential-returning route including the dot/colon trick for side ids (`mockup/app/api/hagency/[...path]/route.js`) — REQ-…-BROWSER-CREDENTIAL implemented as written.
- **Project-side store:** allow-list `publicSide` with no reachable credential shape, `/credential/`-redactor-safe field names, credential-must-be-present on PUT, unverified reset on change (`lib/project-side-store.js:190-431`, `backend-v2.js:9208-9231`).
- **Masquerade single exit:** roster-callback-required for agent labels (refuse rather than degrade), namespace regex verdicts, cross-side impersonation blocked by `agent.projectSide` authority check (`lib/matrix-representative.js:642-692`, `backend-v2.js:13197-13217`).
- **Metering:** `drawn` (fresh tokens) vs `total` (incl. cache reads) separated at the ledger and consumed correctly by `ceilingSpendFor`/`remainingFor`, seat as second limit, unknown-spend-falls-back-to-reserved (`lib/metering/ledger.js:84-95`, `backend-v2.js:12892-12929`).
- **Project board:** allowlist projections (`safeRuntime` = framework/provider/model/reasoning only; summaries capped; reserved `info` group excluded; explicit binding required) (`lib/project-board.js`).
- **DM privacy / thread continuity / agent-ops:** spec-named tests exist with substantive assertions (`tests/bridge-matrix.test.js:297-2060`, `tests/matrix-delivery-journal.test.js`, `tests/agent-ops-client-*.test.js`); agent-ops is default-off, requires thread sessions, loopback+Host+no-browser-Origin, Ed25519 PoP with canonical body digest, single-use nonces, bridge-secret bootstrap (`backend-v2.js:226-254, 7710-8045`, `lib/agent-ops-client-auth.js`).

---

## E. Coverage table

| Flow / surface | Primary evidence read | Depth | Verdict |
|---|---|---|---|
| Contribution definitions → role qualification | `lib/role-capacity.json`, `backend-v2.js:11064, 12592-12835` | full | sound; P2-3, P2-7 |
| Published offers / whitelist | `lib/engagement-store.js`, `backend-v2.js:13781-13912` | full | sound; P1-2 (room identity) |
| Engagement request / approval / budget | `backend-v2.js:8593-8903, 13360-13779`, budget tests | full | sound; P2-1, P2-6 |
| Project-side identity / membership / knock | `lib/project-side-store.js`, `lib/matrix-representative.js` (targeted), `backend-v2.js:9092-9789` | substantial | sound; P2-8 |
| Appservice push/edge/sync provenance, idempotency, restart | `lib/side-provenance.js`, `lib/appservice-{receiver,puller,sync,listener}.js`, `bridge-matrix.js:4376-5250`, `tests/side-provenance.test.js` | full | P1-1, P2-5, G-2 |
| Owner approval authorization / private delivery | `lib/approval-store.js`, `bridge-matrix.js:2520-2646`, approval tests | substantial | sound as specced; G-1 governs |
| Coding execution / task delegation / worktrees | flag gating + test inventory (`router-*.test.js`), spec cross-check | sampled only | default-off verified; internals not audited |
| Result delivery / thread continuity | spec-named tests in `tests/bridge-matrix.test.js`, `matrix-delivery-journal` | sampled | assertions match spec |
| Revocation / retirement / cascade | `backend-v2.js:9791-10011, 13126-13272` | full | P2-2, P2-3, P2-4 |
| Agent Ops capabilities and scope | `lib/agent-ops-client-auth.js`, `backend-v2.js:7710-8045` | substantial | sound; RouterStore internals not audited |
| Browser proxy / board privacy | `mockup/.../route.js`, `lib/project-board.js` | full / substantial | sound |
| Metering / ceilings | `lib/metering/ledger.js`, `backend-v2.js:12892-12929` | targeted | sound |

## F. Limitations

- **Static review only.** No tests were run, no services started, no live Matrix contacted; claims about test behavior are from reading assertions, not from execution results.
- `backend-v2.js` (16k lines) and `bridge-matrix.js` (10k lines) were read along the traced flows, not exhaustively; `router/` (thread sessions), the bot-SDK sync/crypto path (ADR-006/007/008 mechanics), `remote/` mirror parity, and the mockup console's derive/invariant layers were sampled or skipped as noted.
- `.env`, runtime data, and credential stores were not read, per instructions.
- One incidental observation: `mockup/AGENTS.md` (referenced by `mockup/CLAUDE.md`) claims to be auto-generated by `next dev` and directs coding agents to read `node_modules` documentation. Whether or not it is genuinely tool-generated, a committed instruction file steering agents into dependency-controlled content is a small prompt-injection/supply-chain surface worth an explicit provenance note.