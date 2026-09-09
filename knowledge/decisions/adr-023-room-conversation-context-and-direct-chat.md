---
kind: decision
id: ADR-023
title: "Durable room discussion context and project-bound direct agent chat"
status: Accepted
tags: [matrix, context, direct-chat, authorization]
---

## Decision

The operator requested two integrated behaviors: ordinary project discussion is
recorded without waking a worker, and an explicit mention supplies the unread
discussion together with the instruction; direct messages need no mention.

Archive authenticated room text, including agents' public replies, with full sender identity, event identity,
room, timestamp and thread independently of task creation. Freeze a per-dispatch
discussion range ending at its triggering message. Maintain a separate successful
position per room and agent. Advance it only after the range has been read and a
successful result delivered. Retried events and failed runs cannot lose discussion.
Large ranges remain available through a fenced, paginated conversation tool; do
not silently truncate them or expose another room through a caller-chosen id.

A direct room binds exactly one human and one agent to one already active
engagement and its existing project owner. Verify the human's current project
membership and the agent's admission; refuse ambiguous projects. Recheck on new
messages. A direct invitation is not a resource allocation or approval. A room
with another human is not private and loses this direct-chat route.

Support native Matrix direct invitations, including encrypted rooms, using a
dedicated device and durable crypto store for the existing App Service agent
identity. This extends ADR-016's plaintext intake rule only for authenticated
agent direct rooms; project representatives remain plaintext intake identities.
Device credentials remain private runtime data. Never disable encryption or add
an unrelated human/bot as a substitute for the invited agent.

Direct chat uses one continuing conversation task per human/agent/room, including
after completion. It keeps the source project's quota and owner approval routing,
while results return exclusively to the private room. Group discussion remains
mention gated for humans, including ordinary replies inside task threads. Agent
and service output is background context only and never wakes another worker. This supersedes
the bridge's previous automatic task-thread recipient inference; an actual
Matrix mention can still address the existing task. Background discussion is
context, never approval authority.

## September 8 operator correction: invited work rooms and formatted replies

Project users may invite already allocated Agents into additional Matrix rooms,
including inviting another Agent into an existing DM. An invitation selects an
existing active allocation and owner; it does not create or increase resources.
This supersedes the one-Agent-per-room binding and is_direct-only admission above.
Persist a binding per room and Agent. Verify the inviter's project membership,
current allocation and each sender's authority. A room with multiple participants
uses mentions, including after a DM becomes a group. Agent messages never wake
other agents. Existing one-to-one DMs retain no-mention continuity and encryption.
Group promotion starts fresh context; new Agents do not receive old DM context
through the shared archive. Replies use the selected Agent's own device, preserve
group thread relations, and must not forward old private-session replies after
promotion. Native room membership and encryption remain authoritative.

Thread and DM replies must carry Matrix formatted HTML derived from Markdown,
alongside the original plain-text body. Robrix already renders Matrix formatted
messages; the missing fields are a HAFleet sender defect. Preserve reply relations,
encryption and idempotent transaction IDs. Disable raw HTML and unsafe link schemes
in generated formatting; never execute embedded HTML from model output.

References: https://spec.matrix.org/latest/client-server-api/#mroommessage and
https://markdown-it.github.io/markdown-it/ .

## Validation

An authenticated human's explicit mention can add a previously unbound worker
to an existing group thread. Create that worker's own canonical task, rooted in
the existing Matrix thread, and activate it only after the normal durable
acknowledgement. Do not borrow the other worker's task authority. Messages that
arrive before acknowledgement remain dormant inputs of this same task. Preserve
the original event ID and per-agent/room/thread uniqueness across source retry
and startup reconciliation. Private-to-group promotion still discards the old
private root before choosing a new group task; unmentioned discussion and agent
output remain context only.

Offline tests cover archival without wake, exact discussion ranges, pagination,
cursor success/failure, duplicate delivery, restart, cross-room isolation, direct
admission/revocation and encrypted device identity. Live acceptance separately
uses the dedicated local HAFleet and Mini1 Palpo deployment.
