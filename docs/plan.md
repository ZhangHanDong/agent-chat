# Native migration working plan

This is coordination, not canonical runtime task state. There is no provisioned
`task-writer` in this source checkout. User instruction: execute the Rust migration
in a clean worktree. Branch `feat/rust-migration`; baseline `5dbef22`.

Current integration priorities (2026-09-10): the staged encrypted upload owner
now joins original domain reservations, qualified encrypted staging, one actual
HTTPS upload and protected SDK acceptance. It rechecks exact input association,
current token identity and current domain scope before upload. Cancellation or a
lost result cannot rearm the send. A fresh process can record first historical
domain acceptance from the protected SDK journal without the original runner
secret or another POST. Upload acceptance still does not publish a room file.
ADR091 also retains already enqueued Matrix invalidations after caller loss,
while ordinary abandoned domain work remains cancellable.

ADR093 now binds execution and file snapshots to the same retained private
workspace object. Its one-shot Started handoff retains the original writer and
capability, rejects root aliases and retires new reads on every execution exit.
The fixed runtime path still requires trusted, stable host provisioning; this
is not hostile same-UID namespace or actual Codex sandbox qualification.
ADR094 adds bounded test-only evidence for each original Matrix/SDK operation,
including separate primary/fencing errors and close/acknowledgement stages.

After integrating c3a75ec and bbf19e2, the locked full workspace passes 521
independent tests plus one proxy child (522 printed), 85 suite summaries and no
failed or ignored tests. Full warnings-denied Clippy, rustfmt and diff checks
pass, including cleanup of one unused CLI fixture import. All 420 Rust selectors
resolve. Final integrated ADR093 lifecycle passes 8/8 across all 17 changed
paths, and ADR094 passes 14/14 across all 12 changed paths. Both have zero
failed, skipped, uncertain or pending-review results.
Windows GNU compilation is not native Windows workflow evidence, and unconfirmed
directory sync remains a typed refusal rather than a positive upload qualification.

Latest completed fc57d6b Node CI 34560957060 passes: 4291 tests, one platform skip.
Native CI 34560957072 passes Linux and macOS but fails Windows. Original suites
contain Linux 512 printed passes, macOS 511, and Windows 502 passes plus six
Matrix outgoing failures, each with 85 summaries and zero ignored. Two failures
are original domain shutdown timeout paths; four are early collector
OutcomeUnknown observations whose internal cause is still unknown. Subsequent
diagnostics passed separately. Original logs remain preserved; their failure
is not replaced by the diagnostic passes or this local integration result.

The migration-introduced knowledge corpus errors are being closed separately:
417 errors at fc57d6b versus 157 at baseline5dbef22. The docs/spec-only cleanup
preserves baseline findings and actual test selectors; its independent review
and integration remain pending.

The next user-visible slice is native send_file and get_file_delivery: actual
MCP admission, the retained workspace, bounded capture/staging, immutable metadata,
the single upload owner, and separate encrypted Matrix file-event acknowledgement.
Proposed ADR092 remains isolated with unimplemented selectors. Its real service
bootstrap/owned-dispatch driver and pre-launch workspace registration must be
specified before implementation. A first tool request must not race registration.

Keep canonical Done, cleanup, owner decision, runtime application, usage and
message acceptance separate. Approval application proof, complete room/history
behavior, physical provisioning/sandbox, file tools, service/console integration,
quotas and release parity remain open. No M0-M9 milestone or entire migration is
complete. The numbered notes below describe earlier checkpoints; this current
section supersedes their interim status.

1. M0/M1 first checkpoint: native Salvo process, protected fresh state, custody,
   recovery, bounded work, shared protocol vectors and offline encrypted SDK proof.
2. Verify native CI on Windows, macOS and Linux, plus existing build-tool coverage.
3. Continue M0's complete dynamic endpoint/helper classification, supported runtime
   versions and measured device budgets. Run early process-tree/sandbox proofs.
4. M2 selected-resource domain checkpoint now implements verified-observation
   admission, one-transaction reservations/outbox and uncertain-effect recovery.
   Model qualification, derived catalogs and scoped cross-family checks now use
   the shared policy. Complete legacy/project-side/rotation integration.
   The M3 task/dispatch kernel now shares the domain database: current capabilities,
   atomic mutation receipts, frozen payloads, resource leases and conservative
   restart recovery. Canonical session resolution, per-session message projections
   and atomic dispatch input claims are now implemented in schema 4. Continue the
   internal group/MCP surfaces, task dependencies and durable final replies.
   Schema 5 now provides canonical task metadata, input activation through a
   fenced notice outbox, scoped delegation and start-time human follow-up. The scoped runner HTTP API now exposes task reads,
   comments, mutations and frozen inbox through the bounded writer, using its
   execution-time clock. The pure graph planner now matches the existing dependency policy using
   JavaScript-derived vectors. Schema 6 now provides explicit internal routes and atomic scoped conversation
   admission. Schema 7 now adds durable peer messages, exact-session recipients,
   dispatch-owned input and inspected recovery. Continue group lifecycle and atomic
   graph/task linkage before graph execution. Schema 8 now binds inspected-result
   reporting to the completed task epoch, separately from work creation authority.
   Actual final reply delivery remains to implement.
   Schema 9 now adds creator-scoped group member changes/closure, fresh rejoin
   sessions and durable host stop intents. Retired started work retains resource
   custody until inspected settlement; canonical tasks and input history remain.
   Schema 10 now binds finite task graphs to canonical node tasks, immutable
   assignment inputs and completed-epoch results. Current capabilities and
   inspected report grants remain distinct. Cancellation and scope retirement
   retain unknown leases and concurrency until host inspection. Continue final
   reply privacy/delivery, graph tool adapters and actual runner stop observation.
   Schema 11 now freezes explicit host-observed Matrix routes for fresh sessions
   and separates bounded final intent, send custody and observed delivery.
   Negative membership/privacy observations retire old sessions; cancelled or
   uncertain sends cannot silently resume. Continue real authenticated Matrix
   task-intent/session integration, arbitrary room/DM policy, taskless output and
   transport inspection before treating this as an operational reply bridge.
   Schema 12 now admits host-observed Matrix input into independent current
   session copies and creates/activates canonical task intents from that input.
   Direct main stays null-root; group/explicit threads retain authenticated roots.
   Offline repository and HTTP fixtures reach dispatch, follow-up and final intent
   without manually creating a task. Continue live notice send custody, actual
   authenticated Matrix intake/transport, automatic discussion-window selection,
   taskless output and generalized room policy before operational use.
   Schema 13 now persists private owner decisions and exact scoped grants,
   parks each native request and consumes it once before observed application.
   Shared approval-room negative evidence fences every Agent binding, and any
   unresolved request blocks resume. Continue native decision/inspection adapters,
   Matrix cards/verdict crypto and persisted operator YOLO policy before enabling
   runtime approval or treating this as full M6 parity.
   The initial hagency-platform proof now launches explicit native probes: Windows
   atomic Job Object assignment and POSIX unreaped-leader group cancellation.
   Continue native Windows CI validation, POSIX guardian/detached-child ownership,
   bounded runner IO and effective sandbox proofs before real runner adapters.
   Opaque child signal identities now use pidfds/process handles/macOS audit-token
   versions, with read-only birth metadata kept separate from signal authority.
   Extend those primitives to verified descendant adoption and guardian handoff.
   Native guardian handoff now uses an anonymous bounded prepare/start protocol;
   owner EOF, malformed input and leader exit cancel the owned process group.
   Continue detached-descendant adoption and guardian-loss recovery; a POSIX
   group report still does not establish full cleanup or sandbox enforcement.
   Linux now adopts orphaned descendants through a dedicated subreaper and
   validates pidfd waitability before signalling; only kernel ECHILD after root
   reaping can establish observed full cleanup. Actual Linux/Windows detached
   fixtures remain a CI gate for this step; macOS still refuses that guarantee.
   Schema 14 now fences verified task-notice sends before activation and keeps
   late/cancelled delivery distinct from current task authority. Native MCP and
   CLI task helpers use the same scoped API. The MCP helper now has 19 task,
   delegation, conversation, peer and graph tools; host-generated configuration,
   discovery and file tools remain open. The opt-in Codex approval
   coordinator now consumes durable decisions before typed responses, but the
   pinned upstream has no application acknowledgement: resolved is not Applied.
   Windows owned IO passed actual Windows CI; macOS identity observation fixtures
   were strengthened after CI's short heartbeat sample failed. Linux protected
   cgroup recovery is integrated but still needs successful hosted qualification.
   Authenticated Matrix observation collection and formatting are integrated;
   event intake and actual sends remain open. No operational cutover is enabled.
5. Continue M3–M9 in the migration plan; keep production deployments independent
   until every cutover gate is met. A foundation build is not full migration parity.

6. M6 content-format proof now lives in `hagency-matrix-format` (ADR050):
   JavaScript oracle, original body/relations, allowlisted Markdown and bounded
   edits. It is not wired to Matrix sending. Continue host event-size/chunking,
   private-route/crypto integration and actual client round-trip qualification
   before calling this complete M6 formatting or media parity.

7. M6 progress policy/coalescing proof is now isolated in `hagency-progress`
   (ADR052): fixed redacted summaries, exact JS policy/CLI vectors and bounded
   host-run receipts. ADR056 now attaches redacted, exact-instance Codex tool
   evidence through `hagency-progress-runtime`, including native pipe cancellation
   tests. Current domain/owned-worker binding, persistent uncertain-attempt
   recovery, editable Matrix status and route/crypto/delivery qualification
   remain open.

8. M7 bounded transcript normalization is in `hagency-metering` (ADR055).
   Continue transcript discovery, authenticated provenance, persistent ledger,
   exact Agent/project attribution, quota enforcement and console integration.

9. Host-only owned dispatch (ADR053) now binds frozen canonical scope and leases
   to actual native Codex pipes. Started commits before spawn, lost start receipts
   never launch work, and cancellation retains cleanup ownership. Runtime output
   never asserts canonical Done; incomplete cleanup retains dirty leases.
   Continue physical workspace and sandbox qualification, native helper setup,
   approval application, Matrix delivery and integrated platform acceptance.
