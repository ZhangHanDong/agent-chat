---
kind: decision
id: ADR-073
title: "Freeze authenticated attachment visibility with canonical dispatch input"
status: Accepted
tags: [rust, matrix, attachments, privacy]
---

ADR027 requires receiving only authenticated files visible to the current dispatch.
Domain schema018 stores bounded safe metadata and opaque private SDK manifest
identities atomically with the exact Matrix event. It never stores MXC URLs,
encryption descriptors or keys. A host-only typed admission has no deserializer.
Ordinary text admission cannot later acquire a file capability by annotation.
Exact historical receipts permit acknowledgement only and never revive routes.

Per-session attachment projection receives its own monotonic sequence. Dispatch
creation freezes the highest actually selected inbox source sequence and this
projection cutoff. Ordinary dispatches without selected inbox input get a deny-all
window. Already queued uploads after the selected trigger remain excluded; late
projection of an old source cannot expand an already queued dispatch's authority.
Only the existing verified task-input provenance can copy attachments to a child
session. Later dispatches may use earlier files in that authorized lineage.

A host read returns an opaque, non-serializable ticket after validating the exact
current Started capability, route, private generation and frozen visibility. The
same checks must run after asynchronous download before exposing checked bytes.
The future receive coordinator owns that second check. This slice supplies domain
authorization, not a runner file tool or filesystem path. Matrix manifest retention
and actual encrypted event projection are a separate adapter slice.

Both attachment records and visibility are finite, and neither dedup identities
nor frozen windows are evicted to admit new work. Restart preserves immutable
receipts and bounds. Pre-migration dispatches receive no fabricated file window.
No live service, plaintext attachment, thumbnail, upload recovery or production
cutover is enabled.
