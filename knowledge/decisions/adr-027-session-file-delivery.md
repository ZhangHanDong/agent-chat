---
kind: decision
id: ADR-027
title: "Agent deliverables use scoped reliable Matrix file delivery"
status: Accepted
tags: [matrix, attachments, runtime]
---

The operator requests that LLM Agents send files to rooms and DMs. Provide
`send_file`, `get_file_delivery` and `receive_file` on the managed MCP server. The destination is
the authenticated dispatch's current conversation; callers cannot choose another
room, person or thread. Support files and image previews through Matrix media.

The backend validates the active Agent token and runner capability before reading
any file. Read only regular files within the dispatch's registered workspace;
reject path escapes, symlink escapes, hard links and oversized files. Snapshot
bounded bytes into private staging, hash them, and persist a request-keyed outbox
record. Replay keeps the original snapshot. Outgoing staging paths and private upload keys
are not returned to the model or posted as message text.

File delivery uses the existing reliable reply outbox and exact Agent sender.
Persist prepared media content before sending the Matrix event; retries reuse
the media reference, encryption metadata and transaction ID. Only an acknowledged
Matrix event is delivered. Queued or failed uploads are never reported as sent.
Recheck existing room admission and private-room promotion rules on delivery.

For encrypted rooms, encrypt the file bytes before uploading and include the
encrypted-file descriptor inside the encrypted message. Never fall back to a
plaintext upload for an encrypted destination. Unencrypted rooms use ordinary
`m.file` or `m.image` messages. Palpo and Robrix use standard Matrix capabilities;
no custom server protocol is introduced.

This narrows ADR-021's exclusion of attachments: the three new workspace/current-
conversation tools may use Codex's exact per-tool approval policy like normal
scoped replies. Legacy attachment tools, shell networking, external destinations
and filesystem grants remain outside that exemption. Runtime approval requests
that actually occur retain their existing owner verdict flow.

Protocol reference:
https://spec.matrix.org/v1.16/client-server-api/#sending-encrypted-attachments

The operator additionally requests files from room members to Agents. Archive
file metadata with the authenticated Matrix event, download through that room's
homeserver credential, and decrypt encrypted media before staging. `receive_file`
exposes only attachments from the dispatch's room, at or before its frozen input
boundary and after its privacy floor. Historical visible files remain readable
on follow-up turns. The returned local cache path contains verified bytes; it is
not an arbitrary filesystem reader. Unmentioned group uploads are background
context until an Agent is addressed; DM uploads wake its Agent without mentions.
Encrypted-file keys stay in the bridge transport and never enter model context.

Use the same Matrix Rust attachment primitive as matrix-bot-sdk for bounded
inbound decryption, declared as a direct dependency. This avoids starting a
second room crypto engine or allowing the SDK downloader to buffer unbounded media.
