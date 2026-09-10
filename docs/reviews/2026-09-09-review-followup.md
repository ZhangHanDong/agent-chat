# Follow-up to the c380959/f89c746 review

Repair source: `fix/review-closure-20260909`, based on merged `master` 8dfea48.
The supplied review refers to earlier commits. Each finding was retraced against
the merged source before repair. All code and verification work runs in the
isolated review worktree; live services and the operator's website work are unchanged.

## Finding ledger

| Finding | Resolution and evidence |
| --- | --- |
| B1 SDK import isolation | Already fixed by 39196ee. The bridge injects SDK constructors; dependency isolation passes. |
| B2 five original failures | Already fixed in the merged source. Provenance and preset cases pass in the fresh baseline/full-suite runs. |
| H1 direct command reply wedges sync | Direct replies use the admitted Agent device. A failed command reply is visibly recorded and consumed without replaying the command. Real BotCommands plus device-send regression in invited-room-routing. |
| H2 mention of Agent without a device | Only an identity in the device starting map defers admission. Joined but retired/missing devices cannot block another Agent. |
| H3 private replies after promotion | Router commands carry host-owned source session creation time. Direct, file and activity sends permanently reject missing/old provenance after promotion, including null roots. Front-desk group turns start fresh thread sessions. |
| H4 unreachable App Service removal | Withdrawal preserves the helper's structured failure state. Explicit force plus abandon_unreachable accepts unreachable cleanup while retaining partial/failed remote outcomes in the audit. HTTP regression covers refusal without both options. |
| M1 private grant metadata | GET and DELETE return an explicit management projection. Private approval-room IDs, internal workspace fields and source identifiers are excluded; exact human-readable authorization scope remains visible. |
| M2 unknown-Agent owner selection | A null Agent uses only unanimous room bindings, never the first binding by insertion order. Conflicting owners refuse provisioning. |
| M3 direct-history cost | Persist invitation/admission floor; exclude old plaintext/encrypted events before verification, stop at the boundary, cap five 100-event pages, and report the cap. Eligible encrypted history writes as one atomic batch. |
| M4 historical media download | Representative history records each Agent's membership timestamp and excludes pre-admission context. Backfill archives attachment metadata only; an authorized receive_file call downloads/caches verified bytes. Later unrelated uploads stay inaccessible. |
| M5 conversation windows | Freeze at most 200 text parts; page only relevant rows/parts. Successful delivery advances through fully read events, preserving partial messages and unread history. Limited coverage is explicit. The current request's attachment remains available outside the background window. |
| M6 catalog Withdraw | Already fixed: explicit role withdrawal overrides catalog-derived publication. palpo-agent-definitions covers withdrawal across resource edits. |
| M7 approval-store growth | Rollback copies maps and mutable records instead of deep-cloning completed payloads. Terminal receipts older than seven days past expiry are pruned; persistent grants retain their own authority and revocation. Persistence-failure/retention regression passes. |
| M8 committed rig address | Redacted the reviewed documentation occurrence. Existing Git history is not rewritten. |
| L1 permanent outbox failures | Promoted-private replies are permanent failures. Permanently rejected approval notices settle as failed outcomes instead of endlessly retrying; temporary delivery failures retain retries. |
| L2 public execution policy | Agent serialization excludes executionPolicy. Operator policy endpoints remain authoritative; unauthenticated list/detail regression verifies exclusion. |
| L3 task liveness | Uses created/accepted/in_progress/blocked, matching canonical task statuses; unknown/done states remain inactive. |
| L4 initial runtime exit | A stopped shell gate establishes birth/group ownership before exec. Immediate exit and unavailable executable finish promptly; unknown cleanup still quarantines. |
| L5 migration ownership | Conversation schema is migration 010. Activity/file/admission tables are gated by additive migration 013; existing databases converge without losing records. Migration 12 reconciliation is gated. |
| L6 nested dist ignore | Ignore nested dist directories generally and explicitly retain router/dist. |
| L7 missing tmux | Probe without throwing at module import. Only the real tmux-dependent test skips when tmux is absent. |
| L8 non-Codex policy fetch | The effect is gated by Codex framework. Both browser locales visit a Claude Agent with unexpected policy requests treated as failures. |
| Coverage: PID reuse | Unit cases cover reused root, reused parent, retired process group, zombie and wrong guardian/group. Existing live process-tree tests still prove detached cleanup and foreign-process survival. |
| Coverage: real commands/null roots | New real command/device test plus null-root reply/file/activity scope and router source-origin regressions. |
| Coverage: YOLO propagation | Already covered in the later merged source by router-runner's real fake-app-server thread/turn capture; writable YOLO and read-only confinement cases pass. |
| Coverage: assertPrivateMembers | Called by production verification for direct mode; deliberate group invitations retain their separate admission path. |

## Verification record

The clean baseline full run on 8dfea48: **4,206 passed, one failed, one skipped**.
Its failure was the registration-token test homeserver returning no event_id for
a send; the fixture now returns a real Matrix-shaped acknowledgement. Production
continues requiring durable send confirmation.

The first repair full run exposed old fixtures that omitted membership state and
admission timestamps, read execution policy from its former public endpoint, or
claimed pre-migration schema while retaining newer migration markers. Each fixture
was corrected at its protocol/version boundary; the original behavioral assertions
remain active. Targeted reruns pass. The final full suite also completes with
zero failures; totals and skips are recorded below.

Production console build passes with Webpack. The default Turbopack build refuses
the worktree's external node_modules symlink; this is recorded rather than reported
as a successful default build. Both English and Chinese Playwright permission
workflows pass, including the non-Codex page without a policy request.

Native agent-spec 1.4 parses/lints the Task Contract and passes its boundary check.
Its nine Node/Vitest scenario executions are **Skip**, so lifecycle exits nonzero;
this is not a native lifecycle pass. Exact executable test selectors are verified
by the project's inventory check and run separately with Vitest. Native automatic
worktree path discovery mis-normalizes absolute paths; the final run passes the
complete Git-derived set as explicit relative --change arguments. The hidden
.gitignore path uses its equivalent **/.gitignore boundary glob.

No live Palpo/Robrix/LLM acceptance run or deployment is claimed by this repair.
Source task-writer is absent, so these files record coordination evidence rather
than fabricate canonical runtime task state.

## Final checks

- `npm test`: **4,226 passed, zero failed, one skipped**, across 286 test files;
  four shards and the final merged report complete with exit zero (452.42 seconds).
  The skipped case is the non-macOS installer rejection branch on this macOS host.
- `npm run verify:ci`: exit zero. SDK/architecture isolation, router type/build
  checks, all **479** executable spec bindings and **505** kernel/CLI tests pass.
  The kernel tests overlap the full-suite count. Two optional live probes skip
  because no runtime directory is selected; they are not counted as acceptance.
- Console: `npm run build -- --webpack` succeeds. Playwright permission workflows
  pass in English and Chinese, including the non-Codex no-fetch assertion.
  The default Turbopack external-symlink limitation remains as described above.
- Native agent-spec: boundary **one pass**, Node scenarios **nine skips**, zero
  failures; the overall lifecycle result remains non-passing (exit one).
- `git diff --check`: clean. This follow-up changes Hagency source only; live
  Palpo, Hagency and Robrix remain on their existing deployments.

Verification logs and the exact patch are preserved outside Git under
`~/Library/Caches/hagency-review-closure/2026-09-09/`. This record documents the
tested source; it does not claim a fresh live Matrix/LLM end-to-end run.
