---
kind: decision
id: ADR-124
title: File and resolve ceiling overrun alerts from the drawn figure
status: Proposed
---

## Context

Slices 1–3 ported the ceiling draw, refusal wording and admission rule
(ADR-121/122/123). ADR-123 listed the overrun alarm (gap G5 of the port plan)
as the one remaining gap, deliberately deferred because it needs new
infrastructure — native has no alert table and no periodic sweep at all —
rather than another join. The retained JavaScript sweeps hourly
(`backend-v2.js:9393-9452`, `CEILING_OVERRUN_SWEEP_INTERVAL_MS` at `:9350`),
filing `agent_ceiling_overrun` when `drawn > ceiling` and auto-resolving when
the draw falls back under, with an alert record in `lib/alert-store.js` whose
four actionable fields (owner, runbook, impact, recoveryCondition) are what
keep it a `warning` rather than a silent `info`.

## Decision

Slice (a) of the alarm plan (brief 8) delivers storage, sweep and resolution;
publication and the hourly trigger are slice (b).

**Storage.** One table, `ceiling_alerts` (migration 024), one row per dedupe
key `agent_ceiling_overrun:<resource_id>`. The row carries the retained
wording verbatim (summary/runbook/impact/recovery_condition with raw numbers,
never `compactTokens`), `detail` as a JSON string capped at 4096 bytes,
`occurrences`, `first_seen_ms`/`last_seen_ms`, and `resolved_at_ms`/
`resolved_by` (NULL = open).

**Sweep.** `DomainRepository::sweep_ceiling_overruns(&mut self, now: u64) ->
Result<SweepOutcome, Error>` as one `Immediate` transaction over every
resource with a declared finite ceiling, reading the same `ceiling_report`
the admission decision reads — never a second arithmetic path, so the alarm
and admission cannot disagree about whether a resource is over. Strictly
`drawn > ceiling` raises; `drawn <= ceiling` auto-resolves with
`resolved_by = 'system'`; a repeat against an open row increments
`occurrences`; a re-over after resolution reopens the same row; resolved rows
older than 7 days are pruned (`ALERT_RESOLVED_TTL_MS` parity). No timer, no
route, no console change: the sweep cadence is the caller's concern until
slice (b), and the async `DomainStore::sweep_ceiling_overruns(now)` wrapper is
the `sweepCeilingOverrunsForTest` shape — tests drive it directly.

**Divergence from Node's episode model.** The retained store is an id-based
episode log: a re-over within the 5-minute reopen window reopens the same
record, a later re-over mints a new record (`lib/alert-store.js:254-271`).
Native uses **one row per dedupe key**, reopened on any re-over regardless of
the gap. The reason: slice (b) will publish on the dedupe-key resource
dimension, not on individual alert episodes, and there is no alert-ID surface
to justify preserving episodes yet. The contract that matters is unchanged —
one open alert per resource, occurrences riding on it — and the simplification
is recorded here so slice (b) can revisit it if an operator-facing alert-id
surface ever appears.

**What auto-resolve must never do.** An alert is diagnostic, never
enforcement: raising one must not revoke or end engagements, block or permit
admission (admission already refuses by its own rule), release leases, or
authorize retries. Auto-resolve flips the row's display state and nothing
else. "Resolved" is a display state on the alert record, full stop.

## Consequences

Bounds: 7-day resolved retention, 4096-byte detail cap, sweep cadence is the
caller's concern until slice (b). No admission, refusal, deadline, lease or
engagement behavior changes; `resource_ceiling`/`CeilingReport` are reused
unmodified. The oracle gains `sweeps` vectors computed by the retained
JavaScript (pinned by `alertStoreSha256` alongside the existing hashes) so the
native sweep and the retained sweep agree on the same seeds. The seven tests
(`tests/ceiling_alerts.rs`) exercise every transition; the SQLite-backed ones
cannot open their fixture in the peer sandbox (cap-std ancestor EPERM) and run
under CI.
