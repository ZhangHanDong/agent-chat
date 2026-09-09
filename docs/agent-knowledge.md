# Repository audit knowledge

- **Selected website style, 2026-09-08:** the operator selected
  `https://github.com/ymote/adora-website`. Local/public revision `44ff68f` matches.
  Read both `generate-hero*.cjs` scripts and inspected both images plus the deployed
  desktop hero. Scripts use Google GenAI and configured model
  `gemini-3.1-flash-image-preview` for separate charcoal and pale geometric
  backgrounds; real HTML supplies typography. Actual assets are1376×768 despite
  1920×1080 in the prompts. Adopt the charcoal/teal/amber, spacious geometric
  direction with original human/agent/network artwork. See section8 of the
  [website plan](design/hagency-website-plan.md). No generation call was made.

- **Hagency website planning, 2026-09-08:** the operator requested latest-project
  research and a comprehensive promotional website plan. See
  [the proposal](design/hagency-website-plan.md). Public defaults inspected:
  HAFleet `4fb9749`, Robrix2 `e28e118e`, Palpo `c96c8e33`; local integration
  revisions are `c380959`, `88ebf221`, and Palpo admin worktree `c8748200`.
  These branches diverge; do not imply they are merged releases. GitHub's latest
  published releases inspected were HAFleet1.2.0, Robrix2/Robrix1.1.0 and
  Palpo0.4.0. Robrix2 has an existing bilingual HAgency book, but its older
  agent-chat naming/behavior and HAFleet's historical screenshots need review
  before website reuse. The plan proposes an independent bilingual static site;
  implementation, hosting and publication have not been performed.

- **Mini1 public Matrix, 2026-09-08:** operator explicitly requested public access
  using crew.ominix.io on another port. Public homeserver URL is now
  `https://crew.ominix.io:19443`; Matrix server identity remains
  `hfux-closure-20260906.test`. Existing root Caddy service io.ominix.caddy proxies
  only client/media APIs to Mini1 loopback18010, using its existing valid domain
  certificate. Original443website stays intact;18443belongs to another service.
  Public Chrome login, sync, joined rooms, history and thread relations pass.
  Client access no longer needs a local tunnel; HAFleet's reverse callback and
  Palpo admin still retain their existing tunnel. See
  [the connection guide](guides/mini1-public-matrix.zh.md).

- **Invited Agent rooms and Markdown, 2026-09-08:** normal invitations may bind
  existing allocated Agents to additional rooms; binding authority is per room
  and Agent. A DM with an additional participant becomes mention-gated, with a
  fresh context boundary. Keep existing Agent device/crypto stores and never
  allocate from an invite. HAFleet now emits Matrix formatted HTML; Robrix did
  not need a renderer change. Local backend65390 and bridge75228 are deployed;
  console4681 and Mini1 Palpo are unchanged. 179 regressions and five real model
  dispatches pass; browser HTML/thread assertions pass. Native lifecycle has11
  unsupported skips (non-passing). See
  [the validation report](reviews/2026-09-08-invited-agent-rooms-markdown.md).

- **Project registration versus server onboarding, 2026-09-06:** the operator's
  new project room was registered under the already accepted Mini1 project side
  using the existing project metadata API. No server credential replacement is
  needed to add a project. The pending request's first-owner approval form is
  prefilled in the dedicated console browser with the verified borrower and
  existing private encrypted owner room; final approval remains the operator's
  manual step. The server onboarding wizard does not create Matrix rooms or
  establish project owner bindings. Its missing project-management entry point
  must not be confused with an absent server credential.

- **Repeated Matrix command replies, 2026-09-06:** identical `!offer` answers
  reused a content-derived representative transaction id, hiding fresh replies.
  Command replies now carry an async-scoped authenticated event identity; replay
  remains stable, concurrent commands remain separate, and unkeyed sends are
  independent. Six regressions and 279 related checks pass. The dedicated local
  bridge was restarted with its existing profile. See
  `specs/task-matrix-command-replies.spec.md`; its native lifecycle retains three
  behavioral skips. During the manual walkthrough the operator submitted a
  request from the private approval room; that request remains pending with no
  project owner binding. Start project requests in the project room and retain
  a distinct private owner approval room. Do not silently rebind the wrong request.

- **Palpo onboarding requirements, 2026-09-06:** the operator requested a product
  requirements document and a guided borrower/provider walkthrough. See
  [the draft](../knowledge/requirements/req-palpo-hafleet-onboarding.md) and
  [manual steps](guides/hafleet-borrower-walkthrough.zh.md). Dedicated reception
  rooms require a verified target-project authority extension; do not relax the
  current source-room binding or claim that the draft has been implemented.
  Current manual validation uses the existing registration-token deployment.

- **Operator desktop walkthrough, 2026-09-06:** Robrix2 now runs as a visible
  macOS app using the existing Mini1 test profile, account and encrypted session.
  The owned headless app exited normally and its driver was stopped before the
  desktop launch. The private run cache's `desktop-mini1/` contains the launcher,
  build log and launch receipt. Do not restart the headless driver against this
  same profile while the desktop app is running.

- **Manual web onboarding recovery, 2026-09-06:** `sunwukong-01` is online and
  healthy with MCP connected after a real web Retry start. Repository dotenv
  overwrote the environment-only deployment's port/token in the launcher. Backend
  launches now set `HAFLEET_LAUNCH_ENV_READY=1`; both shell entrypoints retain the
  resolved environment, while standalone CLI dotenv precedence stays supported.
  The console requires observed health, preserves real failure details and no
  longer invents `restarts=3` or an ACP removal remedy. Identity/home/token/profile
  remain unchanged. See [the recovery report](reviews/2026-09-06-sunwukong-onboarding.md).
  This manual path is distinct from the earlier Matrix on-demand provisioning test.

- **Active follow-up, 2026-09-06 UTC:** see the
  [current closure report](reviews/2026-09-06-live-ux-closure.md). Fresh ordinary
  registration-token setup, unused presets, allocation, automatic role
  fulfillment, representative-only native intake, encrypted owner Deny/Allow,
  real Claude delegation and tested parent integration pass. Both original tasks
  are done. A subsequent two-stage review also completed in the same backend
  process without outcome recovery, using the correct outer Matrix thread root.
- Final native member-refresh and drawer ownership checks pass. Reopening the
  picker discovers a joined fixture member and removes it after leave without
  restarting Robrix. Matrix API support setup restores the original membership;
  it is not native invite acceptance. Threads/Info toolbar actions and thread-row
  selection remain isolated from the mounted owner room and separate thread tab.
  The native SDK/widget tests and both task lifecycles pass. Full project release,
  approval-channel and HAFleet lifecycle gates remain open.
- Preserve the earlier approval retry `outcome_unknown`, missing peer task-input
  association and invalid nested Matrix history. Schema 9 gives fresh upstream
  requests distinct approval identities; pending original peer replies recover
  with unchanged content and exact task/session authority. New delegations retain
  the human follow-up input while binding the valid outer Matrix root.
- Stop testing found both a legacy tmux-only eligibility refusal and a deeper
  false success: an owned detached Node tool wrote after Stop. The guardian now
  tracks observed process birth identities across reparenting/groups and refuses
  confirmation when inspection fails. A fresh browser Stop retest removed the
  exact observed guardian/Codex/Node tree. Portable polling is not kernel
  containment for arbitrary unobserved daemonization. Interrupted probe tasks
  remain uncertain and quarantined; they are not completed work.
- New admission excludes operator-stopped and cleanup-fenced agents while retaining
  idle provisioned eligibility. A new native request/browser approval created a
  distinct home and joined identity without altering the stopped agent's existing
  engagement, owner binding or fence.
- The full-suite snapshot passed 3,863 tests with one platform skip in 234 files;
  later changes have separate bounded evidence. The current HAFleet agent-spec
  lifecycle still has 15 skipped behavioral scenarios and is not passing.
- Native headless input must pace redraw requests. Queuing periodic Tick commands
  while CPU rendering is busy caused minutes of input delay in the test driver.
  Paced input restored approval rendering; isolated long approval text did not
  reproduce a product rendering defect. Preserve Matrix device/session data across
  restarts to retain existing encrypted history.

- **Latest state, 2026-09-05:** the requested fixes are on
  `fix/spec-review-closure`. Read the
  [closure report](reviews/2026-09-05-review-closure.md) before the historical
  audit below. Full Vitest passed 3,783 tests, the console fixture checks passed,
  and real-model continuity passed 5/5. Remote Mini/Palpo end-to-end evidence,
  released Agent Operations client interoperability, and the approval-channel
  conflict remain open sign-off items.
- [ADR-018](../knowledge/decisions/adr-018-review-closure-recovery.md) defines the
  durable engagement reservation, bridge-owned registration credentials, cleanup
  retry/abandonment rules, and provider-owner bootstrap restriction. Matrix work
  results are inspectable through operator-only `GET /api/matrix-work`.
- `agent-spec` 1.4 is installed for this task under the closure cache's `tools/bin`.
  Native lifecycle does not execute Vitest: retain its skipped verdicts and use
  separate Vitest evidence. Explicit relative change paths and `./package.json`
  boundary spelling avoid observed path-extraction limitations.
- Four old portal selectors were withdrawn under the operator's already-recorded
  retirement, rather than recreated. See ADR-017. All 174 remaining active
  selectors resolve through `npm run check:spec-bindings`.

- `/Users/yuechen/home/hagency` is the HAFleet source Git checkout, with origin
  `https://github.com/hagency-org/HAFleet.git`; it is not a provisioned agent-home
  `workdir/projects/` copy. Its root AGENTS.md/CLAUDE.md symlink to workspace templates.
  At the 2026-09-05 audit, `./task-writer`, `docs/projects.md`, and `docs/plan.md`
  were absent. Do not fabricate a control-plane task wrapper or treat these audit
  notes as canonical task state.
- The audit at `75ca1ecbf8c4623359094f000fa4968693f4a27e` is recorded in
  [progress.md](progress.md), with reproducible findings and test evidence. No
  implementation or test source was changed by that audit.
- Green named tests are insufficient evidence of side-provenance contract
  completion at this revision: inconsistent provenance is terminal in code but
  retryable in the spec, and the 24-label edge/sync loop repeats a success fixture.
  Inspect conditions and assertions, not just title matches.
- Exact contract-title reconciliation found 13 unresolved selectors out of 157.
  Several are renamed or combined tests; do not infer 13 missing features from
  that count. The sync-intake spec also references an undefined
  `REQ-AGENT-OPS-MATRIX-INTAKE`.
- A stale ignored `remote-dist/` after pulling is repaired by the normal
  `npm run build:remote` command before checking the generated package. It does
  not by itself establish a source defect.
- The full local suite at this revision failed twice: one fixture-setup 404 that
  passed in isolation, and a reproducible Linux-specific `/usr/bin/tmux` path in
  `tests/hafleet-up-selfcheck.test.js`. macOS tmux here is under `/opt/homebrew/bin`.
- Older planning prose contains superseded and conflicting status claims. Use
  accepted artifacts and current code; do not count the withdrawn PDU scheduler
  and pricing work, or the non-normative Octos/remote runner roadmap, as missing
  current-contract implementation.
- The extended review is in
  [reviews/2026-09-05-spec-gap-review.md](reviews/2026-09-05-spec-gap-review.md).
  Isolated probes at the same revision demonstrated post-settlement runner writes,
  selection of agents from the wrong side or after retirement, auto-join with an
  unknown seat period, merging of distinct API-key seats after DTO redaction,
  successful active engagement state despite missing owner binding, and request-id
  replay failure after side budget exhaustion. These are review findings, not fixes.
- ADR-016 decision 4 remains an unfinished accepted capability: a qualifying
  resource with no existing agent yields only a provisioning hint; approval cannot
  fulfill that request. Do not confuse manual agent creation with on-demand
  resource-to-engagement fulfillment.
- The user requested an independent Claude Code Fable cross-review. It was launched
  on the same revision with read-only Read/Grep/Glob tools, without service access
  or repository mutation. Its output must be cross-checked before adopting findings.
  That review is now complete and preserved in
  [reviews/2026-09-05-claude-fable-review.md](reviews/2026-09-05-claude-fable-review.md);
  the consolidated report records which claims were reproduced, qualified or not adopted.


## Live workflow evidence after closure commit f89c746

- The 2026-09-06 UTC real remote-Palpo/local-HAFleet/native-Robrix run is documented in
  [reviews/2026-09-06-live-ux.md](reviews/2026-09-06-live-ux.md). It failed full workflow
  acceptance despite successful deployment and several real admission paths. Keep
  remote inventory and private credentials outside source documentation.
- On-demand provisioning now creates the serving agent and joins its AS identity
  when explicit ownership is available. Earlier review notes that provisioning was
  absent are historical. Fresh UI ownership/allocation setup and launch readiness
  still have gaps; do not confuse backend active engagement with usable execution.
- Codex sends `mcpServer/elicitation/request` for HAFleet tool approval; the current
  runner does not handle it. Capture and handle the real protocol, preserving owner
  approval semantics; do not auto-accept to make a test pass.
- New Claude homes lack `.mcp.json` required by thread launch. Stored primary model
  also is not passed unless a session model override exists. Recorded model labels
  are not evidence of the actual Claude model.
- Ephemeral MCP permits scoped create_task but rejects exposed legacy send_message,
  get_task and transition_task. Real child scheduling succeeded; completion did not.
  A completed response dispatch is not a completed task.
- For real UX checks, wait for the rebuilt console's LIVE data and verify Matrix
  membership/events. Robrix headless snapshots include hidden dock widgets: rendered
  frames and homeserver events decide whether input actually happened. Isolate the
  account with ROBRIX_DATA_DIR; never reassign HOME or inspect the operator desktop.

## First-project ownership setup

- Server credentials, project metadata and project owner binding are separate.
  An accepted registration-token side and a recorded room do not automatically
  authorize a project owner. The first engagement approval must explicitly supply
  the owner Matrix ID and its separate private approval room, unless that exact
  project already has an authoritative reusable binding.
- The pending queue's `ownerBindingRequired` is derived from current scoped
  bindings. The console requires and opens these fields when true or unknown;
  `owner_unavailable` after a stale read also reopens setup. Never resolve this
  error by inferring the requester as owner or replacing working server credentials.
- The 2026-09-06 operator retry completed through the rebuilt browser form and was
  independently confirmed active/bound and joined on Mini1 Palpo. Private evidence
  is in the live run cache's `first-project-owner/`. The first runtime work message
  for that new agent is still pending manual validation. Before any router session
  exists, its runtime projection currently falls back to legacy tmux offline state;
  successful approval alone does not establish successful execution.
- A pending Matrix acknowledgement is historical text, not a live engagement
  status widget. Manual approvals now durably deliver a separate public result
  through the project representative. The initial real delivery exposed an intake
  loop: representative-authored messages were treated as borrower input. The shared
  message handler now excludes the recorded representative before command parsing
  and dispatch. An empty `m.mentions.user_ids` does not by itself prevent the legacy
  text-address parser from waking an agent.
- Preserve the accidental notification-created task as blocked with inspected
  outcome_unknown resolution. It is not a completed borrower task. The actual
  engagement remains active, its receipt is visibly delivered, and the serving
  thread agent is idle and available for a new explicit borrower task.

## Palpo admin fleet protocol

- The operator-authorized admin integration now uses four `/api/fleet/v1` operations
  on the existing App Service listener, authenticated by the individual registration's
  `hs_token`. Do not expose the operator backend port or add arbitrary proxy routes.
- Reception requests use custom Matrix events, full sender readback, a fleet-scoped
  target project state marker and current room authority. Direct `!request` still
  targets its own room. Provider approval remains manual; the reception's whitelist
  does not authorize another target.
- Private owner room IDs travel only in the scoped authenticated HTTP submission and
  operator context, not the plaintext reception event or public status. The private
  bot verifies exact two-person encrypted membership. Native private runtime approval
  is still a separate acceptance gate from Playwright web onboarding.
- Details and setup are in [design/palpo-fleet-protocol-v1.md](design/palpo-fleet-protocol-v1.md).
  The admin E2E console build uses `HAFLEET_CONSOLE_DIST_DIR=.next-admin-e2e` at both
  build and start so the existing `.next` console remains intact.

- Imported Palpo fleet registrations now derive their own agent prefix from the
  exact accepted sender and namespace. Do not require a manual
  `MATRIX_AGENT_PREFIX` override for these sides. Backend minting/admission and
  bridge addressing use `lib/matrix-agent-identity.js`; legacy credentials keep
  their configured prefix. See `specs/task-managed-fleet-identity.spec.md`.

- A completed one-shot dispatch is not a completed task. Runner context now
  requires an explicit confirmed canonical done transition after all assigned
  work is verified. Provisioned task-writer uses the session-task API only in a
  complete authenticated ephemeral context; it refuses partial/expired authority
  and cannot fall back to legacy agent.task metadata. Existing home wrappers
  reference the shared script and require no reprovisioning for this fix.

- Project-thread replies without @mentions now resolve only through exact durable
  room/root/original-requester task authority plus current admission membership.
  GET approval-bindings with thread_root_event_id and requester_mxid returns a
  narrowly scoped threadLookup. Unknown/ambiguous roots do not select the last
  active agent. A fresh bridge needs no historical local thread map for this path.


- **Mini1 Palpo web admin live acceptance, 2026-09-06:** the implemented
  App Service → reception → verified project → manual resource approval → actual
  agent/code/tests/result path is deployed and demonstrated. Five deliverable
  tests pass and the canonical task is done with no queued dispatches. This is
  mixed browser/native evidence: Playwright drives the web/admin/task workflow,
  while actual runtime owner permission requires Robrix's encrypted native
  Approve once control. Element and Palpo admin do not yet provide those controls;
  scoped MCP completion also requests owner permission in this deployed runtime.
  Preserve this gap rather than describing the run as entirely Playwright.
- **Live boundaries discovered:** dynamic Palpo AS tokens must use the enabled DB
  registry after startup; room bindings compare semantic JSON without changing
  saved idempotency fingerprints; imported fleet prefixes control minting and
  mentions; role refresh must fetch current capabilities and honor published:false.
  A successful model turn is not task completion. Canonical lifecycle updates
  require explicit scoped task transition, and mentionless Matrix thread inputs
  require exact persisted task/root/room/original-requester authority plus current
  admission. The private cache acceptance report records fixes and retained gaps.


- **Walkthrough and connectivity refresh, 2026-09-07:** a healthy Mini1 deployment
  can be inaccessible when the local SSH forwards are gone. The dedicated
  `mini1-tunnel.sock` under the private palpo-admin-e2e run cache now controls an
  owned background SSH master forwarding Matrix18010/admin18080 and reverse
  callback19094→AS18195. Check the listener/control socket before opening another
  tunnel. Current operator guide explicitly distinguishes homeserver project-side
  records, Palpo project rooms and HAFleet engagement bindings, and documents
  unenforced resource declaration/unattributed usage and incomplete project rollups.

- **Mini1 tunnel supervision, 2026-09-08:** both Robrix history errors were TCP
  connection refusal because the local18010/18080 SSH forwards and control socket
  had disappeared. Mini1's Palpo containers remained healthy. Forwarding is now
  owned by launchd `com.hafleet.mini1-tunnel`, installed at
  `/Users/yuechen/Library/LaunchAgents/com.hafleet.mini1-tunnel.plist`, with the
  existing private-cache control socket and reverse19094→18195. Explicitly set
  `ControlPersist=no` and `ForkAfterAuthentication=no`: the user's SSH config
  otherwise enables ControlPersist600, detaches a master and defeats foreground
  process supervision. KeepAlive plus SSH liveness checks reconnect automatically.
  A controlled SIGTERM recovered in0.48s with a new launchd-owned listener PID99248.
  Both original history URLs and browser thread loading pass after restart.
  Do not create another tunnel on these ports while this service is loaded.


- **Onboarding reset, 2026-09-07:** the operator explicitly requested removal of
  `Mini1 Palpo admin E2E`. The isolated18194 side was removed through its cleanup
  API; its engagement ended, binding deactivated, agent retired and Matrix
  project-room memberships withdrawn. Console13202 `/projects/new` now offers
  fresh creation (Playwright verified). Do not silently recreate this side: the
  operator wants to perform onboarding. Remote Palpo App Service/project history
  and separate manual18193 runtime remain; previous walkthrough IDs are history
  until the operator establishes a fresh binding. Agent retirement is recorded in
  retiredAt even if generic health polling rewrites its offlineReason.


- **Empty manual onboarding, 2026-09-07:** deleting a side alone does not remove
  the primary homeserver candidate injected by the launch environment. At the
  operator's request, private palpo-admin-e2e rig.py now omits MATRIX_HOMESERVER,
  MATRIX_HOMESERVER_URL and MATRIX_SERVER_NAME for backend18194 only. Bridge18195
  retains the actual Mini1 connection. Console13202 now begins with no candidates;
  manual server/address probe succeeds without persisting a side. Do not restore
  the backend preset or recreate a side during the operator's fresh walkthrough.


- **Palpo wizard import implemented, 2026-09-07:** projects/new step3 now supports
  Appservice → 导入 Palpo 已授权配置 → JSON preview → 保存并验证, followed by the
  wizard's connection result and retry. Do not tell the operator to leave for
  Engagements just to import. The imported callback and representative are read
  from the scoped file, so no manual19094 entry is needed on this route. Manual
  generation remains a separate option. Console13202 uses .next-palpo-wizard-v2;
  the launcher reads private console_dist. Real owner download/preview succeeded,
  but operator test side 测试房间 1 still awaits their own explicit save. Inbound
  reception verification remains the provider's Palpo action; outbound accepted
  alone does not prove readiness. See the2026-09-07 wizard review for test evidence.


- **Projects connection section, 2026-09-07:** Projects now displays the existing
  projectSides projection separately from invitations and Agent access. A newly
  imported App Service therefore appears as 测试房间 1 / 凭据已验证 even with no
  Agent grants. Console13202 now runs .next-palpo-wizard-v3. This status proves
  identity access only; it does not allocate resources or prove Palpo reception
  readiness. The live side was unchanged by this UI-only repair.
- **Robrix reception guidance:** !Z3rHf65DtOfCf0EaAv:hfux-closure-20260906.test is
  a room ID, not a login account. The test provider @pwa_provider_20260906 on this
  homeserver is joined to Mini1 live E2E provider · Reception. On the local Mac,
  password login uses the full provider ID plus explicit http://127.0.0.1:18010;
  read passwords only from the private operator cache when requested. Do not
  assume the operator's existing native account is this provider or alter its
  profile; ask for actual login errors or current full MXID when necessary.


- **Latest console build v4:** project-side content spans both columns of the
  shared `.steps li` grid. Its first column is only20px for a marker, so a sole
  child must explicitly span the row. Live render measured1124px width and151px
  height; the browser regression now checks geometry as well as text. Do not
  deploy v3: it rendered project-side names and IDs vertically. Console13202
  uses .next-palpo-wizard-v4 (PID26554).


- **Palpo request readiness, 2026-09-07:** connection evidence expires after30
  minutes; an accepted HAFleet credential and ready owner DM alone do not permit
  new Palpo submissions. The admin form now gates Send on expiry and puts owner
  Verify connection recovery and delivery/failure receipts beside the request.
  It preserves quotas and request ID for retry; reconnect does not submit or
  approve resources. Live octos-code-use remained request-free while its actual
  connection was reverified at22:56:35Z (expiry23:26:35Z). Do not invent the
  operator's request quantities. See the request-readiness review and private
  live evidence. Mini1 web-admin updates require a fresh browser login; they do
  not restart Palpo Matrix or the local HAFleet runtime.


- **Operator octos-code-use completion:** the operator has now submitted and
  approved a new1M-token engagement and run the sum-js task in Robrix2. Current
  agent ends coding_126926a91ba1; canonical task
  task_5cb9646b-ddc5-412c-8a7b-a1fdf92517f9 is independently confirmed done.
  Both heartbeat and done approvals were allowed/consumed by the owner. Three
  local node:test checks pass and the actual final reply is in the source thread.
  Historical waiting messages are not current approval state. Do not direct the
  operator to approve those consumed cards again or say this project lacks a
  request. Routine state updates still produce permission prompts.


- **Completed-thread follow-ups, 2026-09-07:** explicit original-requester
  follow-ups can now continue their existing completed thread task. The old
  implementation queued them but skipped done tasks forever. Claim validates
  exact authenticated unprocessed supplementary input and reopens atomically
  after existing safety/lease gates, preserving prior results and completion
  audit. Generic transition APIs and mentionless lookup remain unchanged.
  The operator's Python request msg_0005 was recovered with its original
  dispatch20de23cb-830b-41f4-9d5b-ef986d5c062a on backend18194 PID52844. Python
  tests pass3/3; pending done approval is ba9fdadd9c28425fa973b8daee2489d4 at
  initial verification. Do not call this approval consumed or the task done
  without a fresh read. See ADR-020 and the completed-thread-followup review.

- **Task maintenance repair, 2026-09-07:** Codex dispatches now use scoped MCP
  lifecycle tools, including the previously missing execution/heartbeat route.
  Developer instructions replace shell-wrapper guidance for these dispatches;
  launch configuration authorizes only the six task tools and requires this MCP
  server. Do not replace this with global network access or shell auto-approval.
  Native owner approval still applies to real permission requests. Backend18194
  now runs PID53826.92 regression tests and a real Codex run pass; the latter
  wrote/tested code and reported heartbeat/done with zero approval requests.
  The first real probe exposed get_task confirmation and is preserved as failed
  evidence. See ADR-021 and reviews/2026-09-07-task-maintenance-approval.md.
- **Python follow-up completion confirmed:** fresh API reads at23:49 and23:55Z
  confirm task_5cb9646b-ddc5-412c-8a7b-a1fdf92517f9 done at23:38:00.660Z and
  dispatch20de23cb completed. The earlier pending-done observation above is
  historical. Do not direct the operator to approve that old card again.

- **Resource-first console, 2026-09-07:** operator removed the independent web
  Create Agent workflow. Console13202 now uses `.next-resource-first-v5`, PID90451.
  `/onboard` redirects to `/resources`; sidebar and resource empty states no
  longer require manual creation. Resource configurations precede the Agent
  roster, and the Resource count is independent of instantiated Agents. Approved
  requests use the existing automatic provisioning path. Keep Agent management
  and CLI/API provisioning.31 Vitest and8 controlled Playwright cases pass;
  deployed read-only checks preserve both actual agents and resource records.
  See ADR-022 and reviews/2026-09-07-resource-first-console.md. Do not redeploy
  `.next-palpo-wizard-v4`, which restores the obsolete creation workflow.

- **Room discussion and direct chat, 2026-09-07:** ADR-023 supersedes the earlier
  mentionless project-thread routing rule. Ordinary project text, including
  public agent replies, is archived without starting a worker; an explicit
  mention reads the frozen unread range for that room and agent. Positions
  advance only after all pages are served and the successful reply is delivered.
  The seventh narrowly authorized MCP tool is `read_conversation`.
  App Service agents now have durable ordinary Matrix device sessions and crypto
  stores for two-person private rooms. Native DM invitations require current
  project membership and a unique active allocation; subsequent messages need
  no mention and retain the same conversation and source-project approval owner.
  Revocation or additional participants stop private intake. Conversation data
  lives in runtime `data/router.db`; device secrets live privately under
  `data/matrix/direct-agents/`. Never copy those credentials into repository docs.
  Backend18194 PID75564 and bridge18195 PID75727 are the deployed versions;
  console13202 remains resource-first v5.746 related tests and actual Playwright
  sends/model replies pass, including encrypted DM continuity after restart and
  recovery of the user's existing Robrix2 DM. Native agent-spec has8 unsupported
  behavioral skips, not a passing lifecycle. See ADR-023 and
  reviews/2026-09-07-matrix-conversations.md for evidence and scope limits.

- **Second Agent resource-selection gap, 2026-09-08:** the operator saved
  `preset_mtsbkzyv_79sd` (`gpt-5.6-sol`, reasoning `medium`) in backend18194.
  It qualifies for coding/testing/integration/documentation. Palpo's live
  request form selects the target project `octos-code-use` and published role
  `coding`; it does not list provider presets. Current request matching prefers
  an existing qualifying agent, and the approval form/API cannot select a preset
  or require a distinct new Agent. Do not promise that another coding request
  will instantiate this medium resource: it currently selects the existing high
  Agent. Multi-agent room support does not close this allocation-UI gap. The
  provider approval path needs an explicit, validated new-Agent/resource choice.
  Read-only Playwright evidence is `second-agent-ui-inspection.json` in the
  private Palpo admin E2E cache. At inspection, connection verification had also
  expired; no request, approval, connection renewal or budget change was made.

- **Resource Agent definitions implemented, 2026-09-08:** supersedes the gap
  recorded immediately above. ADR-024 supports multiple named definitions under
  each Resource, persisted in its `agentDefinitions`. Definitions do not create
  homes or Matrix accounts until approval. The provider approval form can select
  a particular definition or eligible existing Agent; reservations and retries
  retain that choice, with side, owner, role and capacity checks. Disable affects
  future allocation, preserving existing project/DM work. Existing automatic
  selection can still reuse an Agent, so select the second definition explicitly.
  Resource catalog publication is opt-in, independent of role publication;
  Palpo shows sanitized resource/model/reasoning and enabled definition metadata.
  Backend18194 PID89234, console13202 PID31288 with
  `.next-resource-agents-v8`, and Mini1 web-admin image
  `palpo-web-admin:318f47082b8092da` contain the change. Bridge18195 and its crypto
  state were preserved. Real browser creation/publication of two temporary
  definitions reached Mini1 Palpo; cleanup preserved all original resources,
  Agent identities and allocations. The operator's medium Resource remains
  available for their own names/publication. The project's 1M allocation is
  fully committed; a second request needs additional project-side budget.
  See guides/resource-agents.zh.md and
  reviews/2026-09-08-resource-agent-definitions.md for steps and verification
  limits, including the native lifecycle's four unsupported behavioral skips.

- **Operator correction: Palpo owns Agent definitions, 2026-09-08:** ADR-025
  supersedes ADR-024's provider definition UI. Do not tell the operator to define
  Agents in HAFleet. HAFleet configures/publishes Resources; Palpo projects define
  Agent name, role and chosen resource and submit requests. Each named request
  gets a distinct runtime/Matrix identity only after HAFleet approval. The exact
  `requestContext.agentDefinition` is authenticated against the Matrix event and
  included in replay identity. Catalog IDs are public opaque resource references;
  other projects' Agent names are absent. HAFleet's approval form shows the
  requested definition without a replacement selector. Existing local definition
  records/APIs remain compatible but their web creation entry and proxy writes
  are removed. Current deployment: backend18194 PID20010, bridge18195 PID20071,
  console13202 PID20150 with `.next-resource-agents-v9`. Mini1 web-admin has the
  revised name/resource request fields. Existing Agents, budgets and device state
  are preserved. See guides/resource-agents.zh.md and
  reviews/2026-09-08-palpo-agent-definitions.md. The operator's project-side 1M
  allocation is still fully committed; no new quota or real approval was invented.

- **Automatic Palpo resource pool, 2026-09-08:** the operator explicitly requested
  automatic publication. ADR-025 now defaults newly created Resources to published
  in their creation transaction. Existing explicit withdrawals survive edits;
  legacy records without a publication choice retain visibility. All three actual
  Resources have now been explicitly published, including medium reasoning. Palpo
  derives supported roles from those Resources unless the role was explicitly
  withdrawn; missing manual offers no longer hide a resource. Qualification and
  cross-family gates remain; derived catalog visibility does not enable legacy
  automatic acceptance. Do not require manual Agent definitions in HAFleet.
  Palpo shows all resources as cards, then the chosen resource's supported roles.
  Visible pages poll the authenticated catalog every10 seconds and on return,
  preserving drafts and disabling new submission on unavailable catalog reads.
  Current backend18194 PID40252 and console13202 PID40253 use
  `.next-resource-pool-v10`; bridge18195 PID20071 and Matrix device state are
  preserved. Mini1 web-admin image is `palpo-web-admin:f67999ec23458a6a`.
  Actual Playwright web-wizard creation appeared in an already-open Palpo after
  9311ms without manual publication or refresh, and deletion automatically removed
  it. Only the temporary test Resource was deleted. Three actual Resources,
  two existing identities, allocations and18 completed dispatches are unchanged.
  Connection verification remains expired and the project-side1M budget fully
  committed; no extra request, approval or quota was created. See
  guides/resource-agents.zh.md and reviews/2026-09-08-palpo-resource-pool.md.

- **Send readiness restored, 2026-09-08:** diagnosis found expired connection
  verification, followed by a first reconnect's probe_pending race against real
  asynchronous Matrix delivery. Mini1 web-admin now runs
  `palpo-web-admin:b26d42db1b711ca9`; connect retries only the same pending probe
  for up to20 attempts at500ms intervals. It does not synthesize a receipt,
  automatically submit an Agent request, or override an intervening pause.
 35 Node checks and both browser suites pass. A real single-click verification
  succeeded in1207ms, preserving the draft and enabling Send. Readiness expires
  at2026-09-08T09:23:07.680Z, so use a fresh read in future turns. The project's
  1M-token allocation is still fully committed; an asynchronous question asks
  the operator to choose the next Agent's token amount before increasing the
  project-side budget. No amount has been authorized yet and no extra request
  or approval was submitted. Evidence: send-request-restored-final.json/png
  and palpo-connect-wait-deploy.log in the private Palpo admin E2E cache.

- **Pending definitions admitted before budget approval, 2026-09-08:** the operator
  objected that a fresh Resource still could not define/request an Agent. ADR-025
  now permits authenticated Palpo requests to be recorded for manual review even
  when the side allocation is exhausted or unset. The existing verdict and
  fulfillment budget gates remain before reservation/provisioning; ordinary
  intake that can auto-accept still retains its upfront gate.61 related Vitest
  checks pass, including an initial red/green regression on a fresh Resource,
  zero headroom, no allocation, replay, and successful later budgeted approval.
  Native lifecycle retains seven unsupported behavioral skips, non-passing.
  Backend18194 is now PID16597. Console13202 PID40253 and bridge18195 PID20071
  remain unchanged; Mini1 web-admin remains b26d42db1b711ca9.
  Retried the operator's ORIGINAL edison request through Palpo's browser button:
  request e0bc1093-7333-4bf5-8bdf-ce62a0067400 now maps to pending engagement
  en_mtsfvnyd_16ee86, integration,100000 tokens, medium Resource
  resource_a859975751fe9f7d283074a4. Source Matrix event is unchanged. Actual
  HAFleet web review displays edison and its selected Resource. It has no allocated
  tokens, Agent instance or fulfillment yet. Existing identities, Resources,
  18 completed dispatches and side budget1M/1M/0 are unchanged. The earlier quota
  question is no longer a prerequisite for SUBMISSION; quota is decided before
  APPROVAL. Do not say there are no pending HAFleet requests or retry the old
  submission again. Guide: guides/resource-agents.zh.md. Private evidence:
  palpo-pending-live-result.json and hafleet-edison-review.png in the E2E cache.

- **Edison approval headroom repaired, 2026-09-08:** the operator displayed the
  fresh Resource's100M ceiling and then the actual approval refusal for100000
  tokens. Rechecked the selected candidate: medium Resource has99M remaining;
  the blocking limit was the project side's separate1M allocation, fully committed.
  For this concrete operator approval attempt, increased only the side allocation
  from1000000 to1100000 via the authorized operator API. Committed tokens stay1M
  and remaining is100000. Edison remains pending en_mtsfvnyd_16ee86 with no Agent,
  allocated tokens or fulfillment; no approval was submitted. This was a targeted
  operator configuration repair, not a test budget increase. The earlier notes
  about zero side headroom are now historical. Evidence:
  edison-allocation-adjusted.json in the private Palpo admin E2E cache.

- **Edison pool accounting corrected, 2026-09-08:** the operator rejected the
  prior side-cap increase as the wrong model. ADR-025 now funds Palpo-defined
  Agents from the selected pool; legacy requests retain side-allocation gates.
  Pool commitments follow preset ID, while a declared shared-account quota
  applies across pools. No quota declaration means unknown, not provider-guaranteed
  capacity. Pending requests reserve nothing; active and provisioning reservations
  count once. Side budget API separates legacy commitments from poolCommitted.
 275 distinct regression checks and English/Chinese Playwright fixtures pass;
  native lifecycle has9 unsupported skips and remains non-passing.
  Local backend18194 PID4587 and console13202 PID4681 now use pool accounting and
  `.next-pool-budget-v11`. Bridge18195 PID20071 and Mini1 Palpo are unchanged.
  Real browser review shows edison on medium:100M configured,0 allocated,100M
  available,100k requested. It remains pending en_mtsfvnyd_16ee86; no live verdict
  was submitted. Existing two identities, three Resources,18 completed dispatches,
  first Agent's1M allocation and saved legacy side cap1.1M remain unchanged.
  The old side cap no longer governs edison. Do not raise it again to fund a named
  pool request. Read reviews/2026-09-08-palpo-pool-accounting.md and the updated
  guides/resource-agents.zh.md. Evidence: edison-selected-pool-fixed.json/png.

- **Edison approved by operator, 2026-09-08:** fresh control-plane read now
  shows en_mtsfvnyd_16ee86 active, fulfillment complete, runtime
  pa_edison_b93c487ea36f8c32. This supersedes the earlier pending state. Real Matrix
  membership confirms Edison joined octos-code-use
  (!tf0a2Zxm2OXQOoyYKa:hfux-closure-20260906.test), alongside the first Agent.
  Edison is NOT a member of Mini1 live E2E provider · Reception
  (!Z3rHf65DtOfCf0EaAv:hfux-closure-20260906.test); the representative delivered
  the approval receipt there. Guide the user to the project room to mention
  Edison. Read-only evidence: edison-room-membership.json in the private E2E cache,
  captured 2026-09-08T09:30:02.043Z. No message or verdict was sent by this check.

## Matrix Agent profile and execution status (2026-09-08)

ADR-026: project-defined displayName already survives backend serialization; the
missing step was Matrix profile synchronization. bridge.reconcileAgentProfile
initializes only generated names and preserves custom names. Matrix IDs remain
namespace-qualified and are never renamed by this repair.

Router ActivityStore is a projection on the existing router SQLite connection.
Native runner events contain sensitive data: runner-activity extracts only fixed
categories and hashed item identifiers; activity delivery emits elapsed time and
counts. One Matrix status anchor is retained per dispatch, with reliable outbox
edits. io.hafleet.activity messages from the exact known Agent MXID are excluded
from live/backfill conversation context. DM m.replace relations must survive
while nested thread relations are stripped; promotion guards check nested roots.
Never interpret runner completed as canonical task done.

The current Mini1 rig runs backend95185 / bridge95205 after a runtime backup at
activity-backup-20260908-095130. Three real Codex status workflows and 161 focused
regressions passed; native agent-spec has five unsupported skips, not passes.

## Bidirectional Matrix files (2026-09-08)

ADR-027: managed MCP send_file/get_file_delivery/receive_file use the live dispatch
capability. Destination comes from the current session; outbound files must be
regular files within the registered workspace (20 MiB max). Staged hashes and
prepared media are retained in file_replies plus existing notice_outbox. Files
are delivered only after Matrix ACK. Do not reuse legacy send_message attachments
for ephemeral runners. Input file manifests live with room_conversation_events;
read_conversation exposes event IDs and receive_file returns a verified local
cache file after room/time/privacy checks. Unmentioned group files do not wake
Agents; DM uploads do. File contents never authorize tool execution.

Use Matrix SDK media encryption for output and the declared Matrix Rust attachment
primitive for bounded input decryption. A newly constructed CryptoClient is not
ready and cannot decrypt media; do not fake readiness or disable integrity checks.
Media cache root is runtime/data/matrix/media. Public media reads use the standard
authenticated /_matrix/client/v1/media/download endpoint.

Current local deployment supersedes the activity entry: backend99858,
bridge99880; backup files-backup-20260908-114826. All three live scenarios (group,
plain DM, encrypted DM) passed actual file transfers and Playwright downloads.
141 focused regressions passed. Native agent-spec lifecycle has one boundary
pass and six unsupported skips, not a passing lifecycle. See the file guide/review
and session-files-*-0908 private evidence. No Palpo or Robrix source changed.
The isolated Element server's /usercontent/ helper needs frame-ancestors 'self'
while the main page retains 'none'; otherwise downloads are blocked by CSP.

## Robrix native file download repair (2026-09-08 afternoon)

The prior browser download acceptance did not exercise Robrix's native Save UI.
The user's permanent spinner in HAFleet verification DM came from rfd's async
picker panicking on a Tokio worker under Makepad's macOS loop. Robrix source now
opens the save picker on the UI thread and fetches/writes in the background.
The textual link's separate legacy downloader also parsed an empty filename into
a directory; links and buttons now retain event filenames/encryption descriptors
and use authenticated SDK media with a 120-second timeout. The stale encrypted
file unsupported message is replaced by the existing download link.

Actual native Save, cancel/retry, group thread link, original plain DM button,
encrypted DM button and encrypted link passed; four saved files matched the
expected 8 bytes. Five focused tests passed; final native agent-spec lifecycle
3 passed, 0 skipped/failed. An initial transient loopback fixture failure is kept
in evidence; its cause remains unconfirmed despite 15 diagnostic repetitions and
two passing lifecycle reruns. See Robrix docs/reviews/2026-09-08-native-attachment-download.md.

Robrix2 Mini1 desktop executable updated after binary/profile backup, preserving
the original Matrix/crypto profile. Final PID22930, SHA256
fc121703aadafbb34c97387f8a165b45e537f4ac3b59bd321e9ba88e241577ee.
Evidence: palpo-admin-e2e/2026-09-06/robrix-files-native-0908 in the user's cache.
Palpo and HAFleet source/services were not changed for this native client repair.

## 2026-09-08 — Explicit YOLO and scoped execution grants

Accepted REQ-EXECUTION-AUTHORIZATION / ADR-028. Codex resources carry an optional
executionPolicy.yolo default for future Agents; existing Agents have an explicit
operator-only policy and revocable grants under their Execution permissions pane.
Default sandbox remains on. YOLO only applies to leased writable ephemeral Codex
dispatches. Grants derive from native callbacks, never HTTP metadata or prose;
exact command/cwd, structured host/protocol or explicit permission profile only.
Robrix supports canonical scoped buttons and echoes the original digest binding.
Task grants bind migration-11 execution epochs: completing and reopening the same
canonical task cannot reactivate old task authority. See
docs/reviews/2026-09-08-execution-authorization.md for limits and validation.
Local rig updated to console .next-execution-auth-v12, backend60400, bridge60453,
console60472, Robrix61492. Palpo unchanged. Existing Agent YOLO remains false;
real UI-created test grant revoked. Preserve runtime/config/binary backup at
palpo-admin-e2e/2026-09-06/execution-auth-backup-20260908-154315.

## 2026-09-08 — Hagency website ownership and maintenance

The English/Simplified Chinese website lives in projects/hagency-website, an
independent new Git tree with no remote and no symlink. The user selected
ymote/adora-website's visual style and explicitly requested both languages.
Use the website README for commands; Astro preview is managed in the background
on 127.0.0.1:4328. Theme uses localStorage; locale stays in /en/ or /zh-cn/ URLs.
Refresh release data using scripts/update-releases.mjs, then update version
labels and copy in both languages together. Public packages do not contain all
September 8 local integration features; preserve the development labels.

Original dark/light hero PNGs and optimized WebPs are under public/images.
Exact generation prompts are in docs/artwork.md. Website testing uses Node and
Playwright. Native agent-spec 1.4 cannot execute those selectors: six skips are
recorded separately from the eight passing browser tests. No production domain
is assumed; default static builds are unindexed until SITE_URL is supplied.

The operator's added positioning is an open-source, agent-native alternative to
WeChat for communication/collaboration. /en/matrix/ and /zh-cn/matrix/ explain
Matrix, federation, independent operators, and agents with explicitly granted
human-equivalent room roles. Preserve the distinction between room authority and
host/runtime approvals; do not imply payment/Mini Programs parity, automatic
admin grants, account migration, or universal outage/privacy guarantees. The
interactive role cards and network diagrams are illustrations with no live
requests. Site count is now60 localized pages; browser suite has10 passing tests.

## Hagency real project screenshots (2026-09-08)

The website now retains six real development integration captures under
`projects/hagency-website/public/images/screenshots/`, with bilingual source
context in `src/data/screenshots.ts` and provenance/hashes documented in
`docs/screenshots.md` and `src/data/screenshot-assets.json`. The captures came
from the local palpo-admin-e2e/2026-09-06 cache archive but have September 7–8
modification dates. They show HAFleet, actual native Robrix2 (not Element Web),
and the separate Palpo companion admin app. The companion app is not bundled
in the published Palpo v0.4.0 server package; preserve this distinction.

Use `scripts/optimize-screenshots.mjs` from the website repo to verify original
hashes and recreate WebP previews. Do not rewrite product UI pixels. The native
viewer provides original-size scrolling, direct original links, keyboard close,
focus restoration, and localized error recovery. Active Task Contract is
`specs/task-project-screenshots.spec.md`; Node browser execution is independent
of agent-spec's native skips. The workspace task-writer remains absent.
