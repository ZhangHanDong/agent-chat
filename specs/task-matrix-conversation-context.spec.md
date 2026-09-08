spec: task
name: "Room discussion context and direct agent conversations"
inherits: project
satisfies: [ADR-023, REQ-THREAD-SCOPED-SESSIONS]
tags: [active, matrix, context, direct-chat]
---

## Intent

Record project discussion without waking agents, provide unread discussion on
mentions, and support continuous project-bound private agent chat without mentions.

## Constraints

### Must
- Deduplicate authenticated events by room and event identity and retain full sender identities.
- Freeze each dispatch's discussion range and advance per-room per-agent positions only after successful read and result delivery.
- Page long context through the current dispatch capability without cross-room reads.
- Require current project membership, a unique active engagement and its existing owner for invited Agent rooms.
- Allow ordinary room invitations and multiple allocated Agents in one room; keep one-to-one DMs mention-free and groups mention-gated.
- Render Markdown in thread and DM Matrix replies without changing plaintext, encryption or relations.
- Keep encrypted direct messages encrypted and retain the agent device across bridge restarts.
- Preserve project budgets, owner approval, sandboxing and private reply destinations.

### Must Not
- Ordinary group chat must not start a model or become an operation approval.
- Failed work, duplicate events and unrelated agents must not consume another conversation's position.
- Do not silently truncate discussion, grant resources from an invite, or expose private room messages to project rooms.

## Boundaries

### Allowed Changes
- backend-v2.js
- bridge-matrix.js
- lib/**
- router/**
- remote/lib/mcp-server-core.js
- scripts/architecture-boundaries.json
- specs/project.spec.md
- specs/task-palpo-fleet-protocol.spec.md
- tests/**
- mockup/**
- ./package.json
- ./package-lock.json
- knowledge/decisions/adr-023-room-conversation-context-and-direct-chat.md
- specs/task-matrix-conversation-context.spec.md
- docs/**

### Forbidden
- Root workspace templates, credentials in source control, and direct edits to live task or cursor state.

## Acceptance Criteria

Scenario: Ordinary discussion is durable without waking a worker
  Test: discussion archives without creating a dispatch and survives restart
  Given an admitted project room with multiple human participants
  When participants post ordinary text
  Then each event is stored once with its sender and no worker starts

Scenario: Mentions carry the exact unread discussion
  Test: mention context ends at the trigger and advances only after successful delivery
  Given discussion and independent room-agent positions
  When a participant mentions an agent
  Then the dispatch reads discussion up to that event and success advances only its position

Scenario: Large discussions remain fully readable
  Test: conversation pages preserve long messages and reject cross-dispatch reads
  Given a discussion exceeding the initial context page
  When the current runner reads further pages
  Then it receives all content in order and cannot select another room

Scenario: Failed work preserves unread discussion
  Test: failed conversation dispatches and duplicate deliveries do not lose history
  Given a frozen discussion range
  When work fails or an event is retried
  Then the successful position remains unchanged and events are not duplicated

Scenario: Private invitations retain project authority
  Test: direct admission requires a unique active project and current human membership
  Given an allocated agent and a human inviting it to a direct room
  When admission is evaluated
  Then only a unique authorized project can bind the private room

Scenario: Private messages continue without mentions
  Test: direct messages continue one private conversation with project owner approval
  Given an admitted direct room and a previously completed task
  When its human sends another message without a mention
  Then the same conversation resumes and retains its project owner

Scenario: Encryption survives direct chat restart
  Test: direct agent devices preserve identity and never send encrypted-room replies as plaintext
  Given an encrypted direct room
  When the bridge restarts and sends a reply
  Then it reuses its agent device and encrypts the reply

Scenario: Revocation closes private intake
  Test: direct chat refuses revoked projects and additional human members
  Given a previously admitted direct room
  When project authority expires or another human joins
  Then revoked authority stops intake and additional members disable implicit private-message triggering

Scenario: Project users invite multiple allocated Agents
  Test: ordinary invitations support two agents with independent room bindings and mention routing
  Given allocated Agents and an authorized project user
  When the user invites them to an ordinary room or an existing DM
  Then each Agent joins under its existing allocation and group messages require mentions

Scenario: Group promotion isolates private conversation history
  Test: room promotion preserves bindings without exposing prior private context
  Given a continuing direct conversation
  When another Agent joins the room
  Then group context starts after promotion and per-Agent bindings survive restart

Scenario: Thread and DM messages render Markdown
  Test: Matrix Markdown preserves plaintext relations and safe formatted content
  Given an Agent reply containing headings bold lists quotes links and fenced code
  When it is sent to a thread or DM
  Then Matrix formatted HTML accompanies the unchanged plaintext and relation
