# Project discussion context and agent direct chat

Implemented the operator's request: retain project conversation independently
of execution, supply unread discussion when an agent is mentioned, and accept
continuous private conversation without mentions. ADR-023 records the authority
and context boundaries.

## Behavior

- Project text is archived with full Matrix sender, room, event, timestamp and
  thread identity. Public agent replies are context too; they never trigger an
  agent loop. Ordinary thread replies also require a mention to start work.
- Each room and agent has its own successful position. A dispatch freezes its
  discussion at the triggering event; messages arriving during execution remain
  for the next request. Its position advances only after the complete range has
  been served to that runner and its successful reply delivered. Failure and
  replay preserve the unread range. Existing accessible room history is backfilled
  on first access after bridge startup, without recreating tasks.
- The fenced `read_conversation` MCP tool supplies ordered pages with sender
  identities and complete message fragments. The caller cannot select another
  room or skip ahead. The runner is instructed to read the range before acting
  and to treat discussion as background, not approval or additional commands.
- A native direct invite selects the agent's unique existing active allocation
  after checking current project membership and ownership. The room must be
  invite-only with exactly the bound human and agent. New messages recheck those
  conditions. Allocation revocation or additional participants suspend private
  intake. Direct tasks continue across completed turns and restarts, while
  operation approval stays with the source project's existing owner.
- App Service agents use dedicated ordinary device sessions and durable crypto
  stores for private sync. Device creation follows Matrix's
  [application service login API](https://spec.matrix.org/v1.12/application-service-api/#server-admin-style-permissions).
  Encrypted private replies are encrypted before transmission. Project-side AS
  copies of private events are coalesced; the representative is not added to the
  private room. Failed history backfill and undecrypted events remain retryable.
- Runtime task bookkeeping stays internal to normal chat replies.

## Verification

The final related suite passes **746 tests in 40 files**. It covers real router
transactions, backend admission, scoped context reads, complete long-message
pagination, independent positions, failure/replay, restart, owner inheritance,
encrypted device preservation, private membership changes, thread mention gating,
and AS provenance. Router compilation and generated-output comparison, ESLint,
architecture ownership checks and remote MCP synchronization pass.

The contract's agent-spec native lifecycle retains **8 unsupported behavioral
skips**, because that lifecycle does not execute this project's Vitest tests.
It is not a passing native lifecycle; the separate Vitest results provide the
behavioral evidence.

Live acceptance used the existing local deployment with Mini1 Palpo and a
separate persistent Element browser profile driven by Playwright:

1. Two actual project members posted ordinary discussion. Both events were
   archived exactly once and neither became an execution input.
2. A browser mention produced a correct summary of both people's positions.
   A second round read the subsequent discussion instead of repeating the first
   human inputs.
3. The user's existing two-person DM and its previously unanswered message were
   admitted through the agent's own device. A subsequent browser message without
   a mention correctly recalled the original question.
4. An encrypted test DM remembered a supplied phrase. Its second message, also
   without a mention, recalled that phrase in the same canonical task/session.
5. After restarting backend and bridge, a third encrypted message recalled the
   same phrase. The agent kept its device identity. All three wire replies are
   `m.room.encrypted`, and the browser visibly decrypted the answers.
6. A further project mention after restart combined the release date, required
   regression testing, observation period and public agent discussion correctly.
7. Private test content is absent from the project's conversation archive. There
   were no new operation approval requests. The temporary second test member was
   removed, restoring the original project membership.

These are actual browser sends and actual model replies. The encrypted fixture
room was created through the Matrix API; this run did not automate native
Robrix2 room-creation buttons. The user's existing Robrix2 DM was successfully
recovered by the shared server-side implementation.

## Deployment and storage

Deployed to the existing local backend on 18194 and bridge on 18195, connected
to Mini1 Palpo. Final owned PIDs are 75564 and 75727 respectively. Consistent
private database backups preceded both graceful restarts, each after verifying
there were no live runners. The existing console on 13202 remains the entry UI.

Conversation events, positions, frozen dispatch ranges and private room bindings
live in the existing runtime `data/router.db`, in `room_conversation_events`,
`room_conversation_positions`, `dispatch_conversations`, and `matrix_direct_rooms`.
Task inputs continue to use `messages.json` and the router's task/session tables.
Agent device secrets and crypto state live under `data/matrix/direct-agents/`,
with private filesystem permissions; they are not exposed through the console.

Evidence is private under the existing `palpo-admin-e2e/2026-09-06` cache:
`conversation-live-results.json`, `conversation-encrypted-verification.json`,
`conversation-test-cleanup.json`, `conversation-final-deployment.json`,
`conversation-verified-tests.log`, `conversation-bindings-final.log`,
`conversation-lifecycle.json` and the corresponding browser screenshots.

Current scope is textual discussion in admitted project rooms and private chat
for this App Service deployment. Existing project intake remains plaintext;
encrypted project-room intake, voice transcription, edit/redaction reconciliation,
and a project picker for ambiguous multiple allocations are not implemented by
this change. It does not complete the separate fleet-wide metering/delegation
release gates. No commit or push was made.
