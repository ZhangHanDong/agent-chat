# Live UX closure — 2026-09-06 UTC

**Contribution setup, request fulfillment, encrypted owner decisions, real Claude
delegation and tested parent integration now pass in the repaired live run.
Both original tasks are done and the final Matrix reply is delivered. A fresh
delegation also completed without backend recovery, and the repaired browser
Stop passed actual descendant-process checks. Final native member refresh and
drawer action-isolation checks also pass. This is scoped workflow acceptance;
the complete project is not signed off.**

The [original live report](2026-09-06-live-ux.md) remains historical evidence of a
failed full workflow. Its failed, partial and blocked results have not been
rewritten as passing. This report records the subsequent authorized repairs on
`fix/spec-review-closure`, based on Hagency commit `f89c746`, with uncommitted source
changes. Private host inventory, credentials, room identifiers, account details,
browser profiles and full operational traces remain outside the repository.

The active contracts are [live UX closure](../../specs/task-live-ux-closure.spec.md)
and [representative intake](../../specs/task-live-matrix-intake.spec.md).
[ADR-019](../../knowledge/decisions/adr-019-live-workflow-authority-and-termination-evidence.md)
records the authority and termination decisions, including the remaining recovery
limitation.

## Implemented changes

| Area | Result in code and deterministic verification | Live acceptance |
|---|---|---|
| Codex MCP approval | Recognizes supported MCP confirmation elicitation, parks for the exact owner verdict and returns the matching protocol response. Fresh request identity permits a new verdict after denial; migration preserves prior decisions. Foreign threads and unsupported forms fail closed. | PASS for encrypted native Deny followed by fresh Allow, consumed by the real runtime. The earlier retry failure and operator API recovery remain recorded below. |
| Claude runtime preparation | Provisioning prepares the managed MCP/approval configuration. Real fixture-process argv confirms primary model and explicit override selection. Invalid stored model/config cancels before start with an actionable notice, while transient launch failures remain retryable. | PASS for a fresh on-demand home running the real Claude child to a completed dispatch and done child task. |
| Session tools and delegation | MCP task reads/transitions and peer messages cross authenticated dispatch-scoped routes. Peer replies attach atomically to recipient task inputs; pending-reply recovery and session-specific processing preserve their scope. | PASS for recovered handoff and completed integration: both tasks done, dispatches completed, final Matrix reply delivered, README examples and three tests independently pass. |
| Delegation thread roots | Fresh delegation uses the authenticated source's stored top-level Matrix root, retains the original input and rejects nested or substituted roots. | PASS for a fresh human thread follow-up: original input preserved, valid outer Matrix root, distinct parent/child sessions, actual child result visible in Robrix. Earlier nested-root history remains unchanged. |
| Registration-token intake | A durable representative collector handles invites, credential generations, delivery retries and timeline gaps. Ordinary sync joins before reading full membership when stripped invite metadata arrives first. | PASS for fresh registration-token setup, verification and representative join after the invite-order correction. |
| Representative-only routing | Bridge hydration imports active authoritative backend bindings and requires joined sender, representative and target. Revoked imports are removed. An unavailable appservice registry remains retryable. | PASS for native addressed work while the fleet bot remained outside the project room. |
| Bot sync and gaps | Failed admission hydration retains the committed cursor. Unprovable initial timeline gaps remain visibly blocked instead of silently advancing or retrying indefinitely without an actionable state. | Invite ordering exercised during live setup. Unprovable-gap and other injected failure behavior has deterministic evidence only. |
| Console setup and allocation | Registration resume/verification mapping is corrected. Allocation editor distinguishes unset, closed and positive capacity. First approval collects explicit private ownership; server validation rejects public-room or managed-identity ownership. | PASS for browser setup, allocation and explicit first-owner approval. Later execution-outcome recovery used the operator API and is recorded separately. |
| Capacity | Supported unused presets contribute model metadata, provisionable roles and cross-family eligibility. Existing eligible instances are not counted twice; unsupported on-demand frameworks remain unavailable. | PASS for contributions published before agents existed, followed by coding and documentation request fulfillment. |
| Runtime display | Dispatches determine ephemeral activity, approval waiting and blocking. Unknown durations remain unknown, paths are redacted from runtime projections, and one router snapshot is reused per response. | Running, approval-waiting and blocked states observed against real dispatches. After Stop, the refreshed console shows BLOCKED, matching the intentionally uncertain task; the immediate pre-render OFFLINE capture is preserved separately. |
| Operator Stop | Local-only authenticated Stop persists its fence, prevents concurrent Start/registration/PATCH revival, cancels queued work and preserves uncertain outcomes. The guardian tracks observed descendants across process groups and reparenting; inspection loss prevents confirmation. Recorded tmux targets retain exact host management policy. | PASS in the fresh retest: actual browser confirmation returned success after the guardian, Codex and detached Node tool all exited. Original 403 and false-success failures remain preserved. Portable observation is not universal daemon containment. |
| Stopped-agent admission | New admission and capacity selection exclude durable operator-stop and unconfirmed-cleanup fences. Idle provisioned agents remain eligible. | PASS: a new native request and browser approval provisioned a distinct coding agent/home, with actual Matrix membership joined and the old engagement, owner binding and stop fence unchanged. |
| Robrix private approval parsing | Canonical status/verdict messages stay read-only even with embedded action payloads. Native request parsing preserves exact binding strings and rejects padded security identifiers/digests. Headless tests/build passed in the separate Robrix checkout. | PASS for rendered native controls, encrypted Deny/Allow verdicts and runtime consumption after private driver pacing was corrected. |
| Robrix drawer rendering | Separate foreground draw batches put Threads and Room Info above their scrims. The actual draw-order regression fails before and passes after repair. | PASS for both clean native drawers in the running app. |
| Robrix approval reply previews | Canonical approval previews show bounded, escaped readable summaries instead of serialized Rust debug structures. Real event deserialization and the actual reply widget are covered. | PASS for the live encrypted approval verdict's readable quoted request and room-list preview. |
| Robrix drawer action ownership | Threads/Info toolbar actions require the emitting widget UID. Thread rows and pane controls require the owning pane or PortalList group UID, including different timelines in the same room. | PASS: main-room Threads/Info opening and thread-row selection leave the mounted owner room and separate thread tab unchanged, with no foreign drawer or search modal. |
| Robrix mention membership | Opening the picker refreshes remote SDK membership once, retaining room/thread scope and local suggestions while fetching. Explicit remote refresh invalidates an already-synced member cache. | PASS without restarting Robrix: a controlled fixture member appears after joining and disappears after leaving. Room membership returns from five to six to five; the owner room is untouched and still refuses outsider access. Join/leave support setup used the Matrix API, not native invite controls. |

Native Agent Operations remains unavailable under its release/provenance gate.
Hagency's development contract and Robrix's expected namespace do not establish
compatible released artifacts. The existing private approval protocol is a
separate surface; testing it does not certify the gated Agent Operations views.

## Independent Claude Code review

The user-requested cross-review ran in Claude Code 2.1.263 using
`claude-fable-5`, confirmed by the session initialization and primary model usage.
It used only **Read, Grep and Glob** in plan mode. It executed no tests, edited no
files and inspected no live services. The tree changed during its reads, so its
line references and supplied-diff comparison describe an intermediate snapshot.
The private artifacts are `closure-fable-review.md` and
`closure-fable-review.events.jsonl`.

The reviewer identified registry fallback inversion, missing server-side owner
validation, bot-sync cursor loss, unconfirmed Stop recovery, path disclosure in
runtime reasons and repeated full-router snapshots. Follow-up work addressed the
registry, owner, cursor and runtime projection findings with focused regressions.
It also added protected-command refusal coverage and explicit blocked gap
reporting. A real fixture-process Claude dispatch-argv regression verifies primary
model and override selection. Deterministic configuration failures now cancel
before start with a visible notice; transient launch recovery remains covered.

The proposed Stop shortcut was not accepted: a workspace `resolutionAction` proves
neither guardian exit nor descendant termination. Investigation also found that
an owned runner promise could settle without confirmed cleanup. The implementation
now carries explicit guardian evidence, preserves its fence on uncertainty, and
waits for still-owned runners even after another cancellation settled the dispatch.
The non-owned recovery limitation below remains open. Static review suggestions
are not converted into live acceptance results.

## Deterministic evidence

Evidence names below identify private verification artifacts, not checked-in
logs. Counts describe their recorded runs and must not be added together as unique
coverage totals.

| Verification | Recorded result | Scope limit / evidence |
|---|---|---|
| Earlier full Hagency Vitest run | 232 files passed; 3,835 tests passed, one skipped. | `closure-full-vitest.log`; this run predates later Fable follow-ups and final cleanup-proof edits. It is not a final-tree full-suite result. |
| Full Hagency suite after socket-fixture correction | 234 files passed; 3,863 tests passed, one skipped; exit 0. | `closure/full-vitest-fixture-fixed.log`; 373.92 seconds, started 2026-09-06 00:44:49 PDT. Before/after hashes found no changed paths during the run; the private diff and receipt preserve the exact working-tree snapshot at `f89c746`. Later source changes require their own relevant verification. |
| Subsequent provisioned-thread Stop correction | 36/36 passed across three files: Stop 19, provisioning 10, console 7. | `closure/provisioned-stop-final.log`; real provisioned records plus a real guardian subprocess. Stop waits while the child remains alive, then confirms after the final child write, process exit and cleanup receipt. Same-name foreign tmux sessions remain untouched. Four new regressions first failed against the previous code; `closure/provisioned-stop-red.log` preserves them. This delta postdates the full-suite snapshot. |
| Subsequent detached-tool guardian correction | 39/39 passed across three files: Stop 19, structured runners 17, process-tree regressions 3. The two files with later portable zombie-state assertions passed 22/22. | `closure/detached-guardian-affected-vitest.log` and `closure/detached-guardian-portable-pid-vitest.log`. The real provisioned Stop test now includes a detached grandchild. Separate real subprocesses prove tracked reparenting, unrelated-process preservation and inspection-loss refusal. The same counterexample fails against the old guardian and passes against the new one in `closure/detached-guardian-{red,green}.{json,log}`. This is bounded observed-process evidence; ADR-019 records the polling limit. It does not replace the failed live Stop receipt or the required fresh live retest. |
| Subsequent stopped-agent admission correction | 116/116 passed across eight related files. | `closure/stopped-admission-affected-vitest.log`; a new role request excludes stopped or cleanup-fenced agents and can provision a fresh qualifying resource, retaining the previous engagement and owner identity. Both exact regressions first failed against the old eligibility predicate in `closure/stopped-admission-red.log`. |
| Subsequent child-reply handoff correction | 85/85 passed across four files: scoped tools 10, router core 58, backend 16, launch recovery 1. | `closure/scoped-reply-affected-vitest.log`; exact parent input attachment, truthful dispatch status, pending-reply recovery, authority refusal, rollback and session-specific input processing. `closure/PEER-REPLY-HANDOFF-REPAIR.md` distinguishes the live missing-attachment defect from the separate settlement defect exposed by the initial red fixture. This delta postdates the full-suite snapshot. |
| Subsequent delegation thread-root correction | 87/87 passed across four files: scoped tools 10, router core 60, backend 16, launch recovery 1. | `closure/delegation-thread-root-affected-vitest.log`; fresh delegation derives the stored top-level Matrix root while retaining its source input and refusing nested/substituted roots. The two new regressions failed against the previous code in `closure/delegation-thread-root-red.log`. Existing history is not migrated. This bounded run includes the handoff corrections and postdates the full-suite snapshot. |
| Stop, runner and backend integration follow-up | 43/43 passed across three files. | `closure-stop-cleanup-proof-tests.log`; includes unconfirmed cleanup, independently inspected workspace, earlier cancellation and real fixture guardian cleanup. |
| Matrix intake follow-up | 394/394 passed across nine files. | `closure/matrix-intake-palpo-invite-vitest.log`; deterministic fixtures, including ordinary-sync invite ordering. No live homeserver was contacted by these tests. |
| Console and runtime follow-up | 106/106 passed across seven files. | `console-runtime-final-tests.log`; Claude runtime 20, owner binding 13, runtime projection 4, scoped tools 6, console 7, router core 55 and transient launch recovery 1. |
| Earlier capability/Stop/runtime regression run | 90/90 passed across six files. | `agent-stop-final-tests.log`; later Stop behavior is covered by the 43-test follow-up above. |
| Robrix native approval parser | 33/33 parser tests; locked headless build passed. | `robrix-octos-approval-green.log`, `robrix-interop-build.log`; separate checkout, no released Agent Operations claim. Three bound native lifecycle scenarios passed. |
| Robrix drawer action ownership | Actual three-RoomScreen regression passes for both toolbar actions, grouped thread-row selection and pane close. Product build passes. | `closure/thread-action-scope/toolbar/`; old Threads and Info broadcasting each reproduced a failing assertion. Native lifecycle passes one behavioral and one boundary scenario, zero skips/fails/uncertain, quality 1.0 with one advisory. |
| Robrix mention member refresh | Real SDK HTTP integration passes; 56/56 actual mention-widget tests pass; locked product build passes. | `closure/mention-member-refresh/`; covers new join, leave, local-only reads without HTTP, remote denial and once-per-opening refresh with thread scope. Native lifecycle passes two behavioral and one boundary scenario, zero skips/fails/uncertain, quality 1.0 with one advisory. |
| Router and source checks | Typecheck, generated router consistency, router boundary, architecture ownership, dependency isolation, syntax, undefined-name and CLI checks passed. | Corresponding `closure-*-checks.log` files; new routes have explicit architecture registry entries. |
| Remote packaging | Normal remote source sync, build, generated consistency and smoke assertions passed. | `closure-remote-*.log`; smoke used a cache copy preserving the existing HOME, with the root path adjusted and HOME override removed. Source smoke script is unchanged. |
| Contract fixtures and selector binding | Agent Operations fixture integrity passed for development artifacts; selector check at the full-suite snapshot resolves 206 with none missing. | `closure-contract-specs-checks.log` and `closure/fixture-fixed-spec-binding-receipt.json`; fixture integrity is not released interoperability. |
| Earlier active contract lifecycle | **NON-PASSING:** zero scenarios passed, nine skipped; no failed or uncertain scenario verdicts. Parse and lint completed, with seven lint diagnostics and quality score 0.9578. | `closure-final-lifecycle.json`, `closure-final-lint.json`; 47 actual changed paths supplied explicitly in the captured manifest. No change-boundary failure was reported. Agent-spec 1.4.0 did not execute Vitest; broader requirement traces also lack lifecycle results. Separate test output remains the execution evidence. |
| Earlier contract after approval and Stop follow-ups | **NON-PASSING:** boundary check passed; zero behavioral scenarios passed, eleven skipped, none failed or uncertain. Parse/lint completed with seven diagnostics and quality score 0.9604. All 213 selectors at that snapshot resolved. | `closure/post-live-fixes-{parse,lint,lifecycle}.json` and `closure/post-live-fixes-changed-paths.json`; 57 changed paths supplied explicitly. Agent-spec 1.4.0 did not execute these Vitest cases; the separate test runs provide execution evidence. |
| Earlier contract after child-reply handoff correction | **NON-PASSING:** boundary check passed; zero behavioral scenarios passed, twelve skipped, none failed or uncertain. Parse/lint completed with seven diagnostics and quality score 0.9614. All 218 selectors at that snapshot resolved. | `closure/delegation-reply-{parse,lint,lifecycle}.json`, `closure/delegation-reply-bindings.log` and `closure/delegation-reply-changed-paths.json`; 57 changed paths supplied explicitly, with no changes during verification. Agent-spec 1.4.0 did not execute Vitest; the new behavioral scenario remained skipped in that lifecycle. |
| Earlier contract after delegation thread-root correction | **NON-PASSING:** boundary check passed; zero behavioral scenarios passed, thirteen skipped, none failed or uncertain. Parse/lint completed with six diagnostics and quality score 0.9926. All 220 selectors resolved. | `closure/delegation-thread-root-{parse,lint,lifecycle}.json`, `closure/delegation-thread-root-bindings.log` and `closure/delegation-thread-root-changed-paths.json`; 59 changed paths supplied explicitly, with no changes during verification. Agent-spec 1.4.0 still does not execute these Vitest scenarios; the separate bounded test results remain the execution evidence. |
| Active contract after detached-tool cleanup and stopped-agent admission corrections | **NON-PASSING:** boundary check passed; zero behavioral scenarios passed, fifteen skipped, none failed or uncertain. Parse/lint completed with seven diagnostics and quality score 0.9879. All 225 selectors resolve. | `closure/detached-guardian-{parse,lint,lifecycle}.json`, `closure/detached-guardian-bindings.log` and `closure/detached-guardian-changed-paths.json`; 69 changed paths supplied explicitly, with no changes during lifecycle verification. Agent-spec 1.4.0 does not execute the bound Vitest cases; its skips remain separate from the executed test results. |

Two preceding full runs remain recorded as failed. `closure/full-vitest-final.log`
reports 3,857 passed, one failed and one skipped while an offer-formatting edit
landed; the exact file subsequently passed 22/22 and the final affected and related
suites passed 138/138 and 154/154. `closure/full-vitest-stable.log` reports 3,859
passed, two failed and one skipped; both failures were socket resets.

The socket investigation found a test isolation defect: Supertest created a
default IPv6 listener but dialed IPv4. On this host, another IPv4 listener could
own the same port. A deterministic reproduction using two owned servers reached
the wrong server. The shared fixture now explicitly binds and reuses a tracked
`127.0.0.1` server. All 71 tests in six affected files pass, including the two
originally failing files and isolation/cleanup regressions. The individual
destinations of the original untraced failures cannot be reconstructed; the
fixture defect and matching failure class are directly reproduced. See private
`closure/stable-reset-diagnosis.md` and `closure/stable-reset-fixture-fix.log`.

The subsequent full run above also passes both original failing files and the new
fixture regressions. Its one skipped test remains skipped; a green Vitest run does
not change the separate non-passing agent-spec lifecycle result.

## Live acceptance

The dedicated clean deployment and initial appservice run remain separate.
The clean rerun uses registration-token credentials, a fresh runtime and managed
homes, the production console through Playwright, and actual native Robrix input.

| Step | Current observed result |
|---|---|
| Dedicated remote Palpo deployment and local access | PASS; separate persistent homeserver and database, existing deployments preserved. |
| Create and publish unused contribution resources | PASS through console; coding and documentation presets configured before agents existed. |
| Default registration-token setup | PASS after the invite-order fix; verification accepted and representative joined through ordinary sync. |
| Side allocation | PASS through console; 250k allocated and 140k committed after the two approvals. |
| Request and approve coding/documentation | PASS through native Robrix and console; both engagements active, homes provisioned and both agent identities joined without manual home configuration. |
| Representative-only addressed task intake | PASS; actual native Matrix mention and task thread produced a started Codex dispatch while the fleet bot remained outside the project room. |
| Real Codex approval protocol | PASS for consumed encrypted native Deny followed by fresh Allow and real runtime resumption. Earlier expiries and the operation-digest retry failure remain failed attempts; that interrupted dispatch required authenticated operator outcome recovery. |
| Native private approval controls | PASS; corrected private driver pacing made controls usable, and native Deny/Allow events reached the backend as encrypted owner verdicts and were consumed. Action-row layout and composer shader compiler regressions remain fixed with passing native lifecycles. |
| Approval privacy | Tested outsider room access returns 403; anonymous backend endpoints return 401. Approval wire events use Megolm encryption. Plain text `approve` does not decide the pending request. |
| Coding artifact | PASS; implementation and three tests pass independently in the actual project directory. Both README JavaScript fences execute with expected-output, special-key and package-import assertions. Verification leaves project hashes unchanged. |
| Delegated Claude child | PASS; after a fresh owner Allow, the real Claude dispatch completed, the child task became done, and it returned its full README through scoped messaging. |
| Child-to-parent handoff | PASS after repair and restart; automatic reconciliation attached the original unchanged reply to the parent task and a new started parent dispatch. The initial missing attachment and falsely reported queued state remain recorded failures. |
| Parent integration and final task | PASS after recovery; parent and child tasks are done, both dispatches completed, and the coding agent's final Matrix thread reply is delivered. The integrated README is byte-identical to the child artifact and scoped message. No operator copied or injected it. |
| Fresh top-level delegation and native navigation | PASS for the backend workflow: two tasks done, four dispatches completed and four actual Matrix replies delivered on valid roots, with no backend restart or outcome-recovery call. Robrix displays the child result in the correct thread. Separate drawer action-scope defects were repaired and retain their own evidence. |
| Live console Stop | PASS for the repaired fresh probe: actual browser Stop returned success, exact prior guardian/Codex/Node PIDs and runtime groups disappeared, and the completion marker is absent. The intentionally interrupted dispatch remains `outcome_unknown` and its workspace stays quarantined. Earlier false success and 403 are separate failed attempts. |
| Native member refresh after membership changes | PASS: exact member query is absent, present after join, then absent after leave in one unchanged native process. No message is sent; original project membership is restored and the approval room remains inaccessible to the fixture outsider. |
| Native drawer isolation | PASS: opening main-room Threads or Info affects only that screen. Selecting a thread row does not open a search modal or change the separate thread/owner screen. |

The final native checks used the rebuilt local Robrix app with its preserved
Matrix device/profile. App-rendered frames were inspected; no operator desktop
capture was used. The membership fixture used owned accounts through real Matrix
API join/leave calls, followed by actual native picker input. That fixture setup
does not certify native invitation controls. Detailed evidence is in
`closure/mention-member-refresh/live-acceptance.md`,
`closure/member-refresh-live-final.json` and
`closure/thread-action-scope/live-acceptance.md`.

At the final read-only health check, Palpo's versions endpoint returned 200,
all 15 approval requests were consumed, and no dispatch was queued, leased,
started or parked. Historical dispatches comprise nine completed and three
`outcome_unknown`; the latter include the preserved approval failure and the two
intentional Stop probes. This does not convert uncertain work to completed work.

The native verdict records link encrypted Megolm events to accepted owner decisions
and consumed Deny/Allow results. Expired requests and the first denial produced no
child; the later fresh allow did. See private
`closure/native-owner-deny-wire-receipt.json` and
`closure/live-delegation-ledger.json`. A prior click during the stalled driver
produced no server-visible verdict; it is not counted as a stale-verdict negative
test. Migration preserved all six existing approval waits and their old columns,
as recorded in `closure/approval-migration-before.json` and
`closure/approval-migration-after.json`.

The console correctly displayed the interrupted agent as BLOCKED. Its actual Stop
attempt returned `403 unmanaged_session`, because a newly provisioned local thread
agent has no tmux session. No successful stop is claimed for that attempt. This
finding and the approval retry defect were repaired and tested. The interrupted
dispatch was inspected and continued through the authenticated operator API;
that action is an execution recovery, separate from browser/native acceptance.
Its earlier `outcome_unknown` record remains part of the history.

The subsequent bounded Stop probe exposed a deeper cleanup failure. Read-only
process inspection established the exact backend-to-guardian-to-Codex-to-Node
ancestry before clicking the console's real **Stop it** confirmation. The endpoint
returned HTTP 200 and `stopped: true`, but the Node process survived reparented to
PID 1 in its own process group. It naturally wrote its completion marker 65.192
seconds after the dispatch was settled as operator-stopped. This is failed Stop
acceptance; neither the response nor a settled router row proves termination.
No operator killed that process or cleared the stopped agent's fence. Private
evidence is `closure/console-live-stop-receipt.json`, the exact
`closure/live-stop-before-*` / `closure/live-stop-after-*` snapshots, and
`closure/live-stop-detached-survivor.json`. The finite probe's files and history
remain preserved through the guardian repair and subsequent retest.

After the guardian and admission repairs, a native role request plus ordinary
browser approval provisioned a distinct coding agent. A second native task started
a real Node timer in that new managed home. Read-only inspection matched its
guardian's exact dispatch/runner identities and the complete observed ancestry,
including the Node process's separate group. The actual browser Stop confirmation
returned success; subsequent inspection found none of those PIDs or executable
groups, no matching guardian and no completion marker. The old probe's files,
engagement, binding and fence were not changed. Exact private evidence is
`closure/live-fresh-stop-admission-verified.json`,
`closure/console-live-stop-retest-receipt.json` and the new immutable
`closure/live-stop-before-*` / `closure/live-stop-after-*` pair.
An independent observation 105 seconds beyond the full two-minute probe deadline
still found no completion marker, late write or live owned process. No dispatch
was queued or running. The task remains blocked, the interrupted dispatch remains
uncertain and the exact workspace remains quarantined, with no outcome resolution.
See `closure/live-stop-retest-final-readonly.json` and its Markdown companion.

The fresh independent-review workflow also completed before this intentional Stop
probe. Its human follow-up remained the child's original task input, while both
assignees used the valid outer Matrix root in separate task sessions. The child
completed its review and its scoped reply immediately started a new parent turn
in the same backend process. Both tasks finished; all four dispatches and Matrix
deliveries completed. The original project files remained unchanged from the
independently passing integration verification. See
`closure/live-fresh-review-final.json` and `closure/live-fresh-review-final.md`.

The completed child's reply initially remained in the recipient session without a
task input or dispatch assignment. After the handoff repair and backend restart,
automatic reconciliation created the missing parent association and a new dispatch.
The reply's original timestamp and content hash are unchanged. The recovered parent
README and child README have identical hashes, and an independent parent test run
passes all three tests. No operator copied the README or injected a replacement
reply. Evidence is in `closure/PEER-REPLY-HANDOFF-REPAIR.md`,
`closure/live-parent-recovery-proof.json`, `closure/live-delegation-ledger.json`
and `closure/parent-recovered-independent-tests.log`.

The recovered parent then recorded its result and transitioned to done through
scoped MCP tools approved in the encrypted owner room. Its final dispatch settled
and its Matrix reply was delivered on the original top-level human thread.
Independent verification executed both README examples, checked package exports
and reran all three tests from the integrated project. Full private evidence is
`closure/live-integration-final.json` and `closure/live-integration-final.md`.

Two further native defects were reproduced and repaired. Threads and Room Info
foregrounds previously shared a draw batch with their scrims, causing visible
compositing noise; live captures now show clean panels. Approval reply previews
previously dumped the full custom-event debug structure. The new display-only
formatter shows a readable bounded summary, confirmed in a fresh native encrypted
verdict reply. The separate Robrix contracts passed one drawer behavioral scenario
and two preview behavioral scenarios, with no skipped or failed verdicts. These
changes do not alter approval authority or encryption. Private evidence is under
`closure/drawer-render-fixture/` and `closure/approval-reply-preview/`.

A forced test login created a new Matrix device and made prior encrypted approval
history unavailable in that session. New encrypted chat is readable. Subsequent
native restarts preserve the account/session profile. This setup recovery is not
reported as a source-level encryption fix.

The later capture stall was a private test-harness queuing defect: its driver sent
ticks every second while the CPU renderer was still drawing. Serializing commands
and waiting for frame completion restored responsive live owner-room captures.
An isolated fixture using the real Message, AgentApprovalCard, Splash and
PortalList templates, three captured long request bodies and a 700-pixel timeline
captured in approximately 0.42 seconds with paced commands. Its cold startup took
approximately 21 seconds. The initial fixture timeout is discarded as evidence:
that fixture incorrectly drew zero-height out-of-range rows, unlike RoomScreen.
A symbolized live sample confirms CPU raster and texture-conversion work; no
independent long-input rendering defect or corrupted restored dock was established.
No production text, encryption, approval binding or dependency change was made for
this diagnosis. The subsequent owner verdicts and completed child have separate
wire, task and artifact evidence described above. Detailed private rendering evidence is in
`closure/approval-render-fixture/diagnosis.md`.

## Remaining limits and live handoff

An unconfirmed **non-owned runner** remains fenced even after authenticated
workspace outcome resolution. No supported host-recovery API currently supplies
the exact process ownership and termination evidence needed to clear that fence.
Stop returns unconfirmed and Start remains refused. Editing state or deleting an
agent is not a supported proof of cleanup. An owned guardian's later confirmed
close can clear its own receipt; workspace inspection is a separate action.

The Stop endpoint also refuses remote and separately supervised ACP processes.
A recorded tmux target must match the agent's name and this host's management
policy. Local thread agents without such a target stop through dispatch and owned
guardian evidence; an unrelated same-name terminal is never inferred as theirs.
These ownership limits must not be described as successful shutdowns.

Core workflow acceptance now includes contribution setup, request fulfillment,
private owner decisions, child completion, tested integration, a fresh valid-root
delegation and repaired Stop with process evidence. The recovered original run
includes authenticated API outcome recovery and backend restarts; it is not an
uninterrupted browser workflow. The subsequent fresh review required neither a
backend restart nor outcome recovery. All earlier refused, failed and partial
steps remain part of the record. The final native member-picker and drawer checks
also pass, with their explicit fixture and action-isolation scope above.

Unmeasured usage is not measured billing or enforced runtime metering. Compatible
released Agent Operations artifacts, the outstanding approval-channel contract
conflict and full project sign-off also remain separate requirements.
