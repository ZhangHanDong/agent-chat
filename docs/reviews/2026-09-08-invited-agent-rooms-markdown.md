# Invited Agent rooms and Markdown replies — 2026-09-08

The operator could not invite a second allocated Agent into an existing DM, and
Robrix displayed Agent Markdown as literal text. The sender supplied only `body`;
Robrix already supports Matrix formatted messages. HAFleet now supplies safe
`org.matrix.custom.html` / `formatted_body` alongside the unchanged plaintext.
The same send path covers DM, thread, edited content and encrypted messages.

Ordinary invitations now select an existing active project allocation. Durable
bindings use room plus Agent, preserving project ownership, admission and device
identity. A DM becomes a mention-gated group when another participant is invited.
One authenticated event can address multiple bound Agents without duplicate task
creation. Replies retain their Agent identity and thread relation. Agent output
does not wake peers. Departed or revoked bindings do not block another valid
Agent in that room. Existing command and media handling is retained.

Promotion starts a fresh conversation context range and blocks pending replies
from the former private task. This limits HAFleet's context delivery; it does not
change Matrix room history visibility or erase messages already in the room.

Validation from `/Users/yuechen/home/hagency`:

- 179 Vitest tests across 13 suites pass, covering bridge/backend integration,
  deduplication, authorization, independent room bindings, context boundaries,
  identity selection, encryption and Markdown sanitization.
- Router build and generated output check, scoped ESLint, architecture boundaries
  and 302 spec selector bindings pass.
- Native agent-spec 1.4 parses and lints the updated contract at quality 1.0.
  Its lifecycle reports 0 failed, 11 unsupported behavioral skips and one passing
  boundary check. The native lifecycle is **non-passing**; Vitest and live checks
  are separate evidence.

Deployed to the existing local rig: backend PID 65390 on 18194, Matrix bridge PID
75228 on 18195. Console PID 4681 on 13202 and Mini1 Palpo are unchanged. Runtime,
credentials, router database and crypto stores were backed up before restart.
Existing Agent identities, three Resources and engagement allocations compare
equal before and after the live test. No commit or push was made.

Actual Mini1 acceptance used provider-owned test rooms and the existing Edison
and coding Agent. Five additional model dispatches completed; all 25 dispatches
are complete, with no active or failed test work:

1. Invited Edison into a DM and sent a prompt without a mention. Its reply contains
   heading, bold, list, link, inline code and fenced code as formatted HTML.
2. Invited the coding Agent normally into that DM. Both joined under their existing
   allocations. A separate ordinary room invitation also joined successfully.
3. Posted unaddressed background discussion in both rooms. No dispatch started.
4. Mentioned Edison in the promoted DM and coding in the ordinary room. Only the
   selected Agent answered each prompt, correctly summarizing the preceding
   background discussion (the fruit was blueberries).
5. Mentioned both Agents in one message. Exactly two completed tasks produced two
   replies under that message's thread, each from its own Matrix identity.
6. Playwright opened the real Mini1 room and thread in Element Web. Both replies
   render headings, bold, lists, links and code blocks; DOM assertions and a
   screenshot confirm this. The earlier DM renders correctly too.

This run verifies live plaintext rooms and the browser client. Encrypted sending
and restart preservation are covered by automated tests; this run did not repeat
the earlier native Robrix or live encrypted-room acceptance. New replies get the
format fix; previously sent plaintext events are not rewritten.

Private evidence is in
`/Users/yuechen/Library/Caches/palpo-admin-e2e/2026-09-06/`:
`invited-rooms-final-verification.json`, `invited-rooms-browser-verified.json`,
`invited-rooms-thread-browser.png`, `invited-rooms-dm-browser.png`,
`invited-rooms-deployment.json` and `invited-rooms-lifecycle-final.json`.
Test rooms are named `HAFleet 验证 · DM 转双 Agent · 0908` and
`HAFleet 验证 · 普通房间邀请 · 0908`; user-created rooms were preserved.
