spec: task
name: "Appservice sync intake (third inbound mode)"
inherits: project
satisfies: [REQ-AGENT-OPS-MATRIX-INTAKE, ADR-016, ADR-014]
tags: [active, matrix, appservice, intake]
estimate: 2d
---

## Intent

Collect appservice events for a project side over an ordinary outbound
`/sync` loop — no inbound socket, no co-located edge process — so a fleet
behind NAT can still receive homeserver traffic. The sync loop feeds the
same router as the listener and edge paths, inheriting their ordering,
duplicate suppression, and authentication.

## Constraints

### Must

- Resolve configuration through `resolveAppserviceSyncConfig`: disabled by
  default; a half-configured pair (side without URL, URL without side, or a
  non-absolute URL) is REFUSED with a reason, never treated as off.
- Authenticate as the application service itself: `m.login.application_service`
  with `token = as_token` and `identifier = sender_localpart`. The resulting
  access token is a process-local cache only — never persisted, matching the
  in-memory-only acting-credential design.
- Carry an explicit `/sync` filter: no `room.timeline.types` allowlist (palpo
  matches filter types literally — no `*` wildcard — so an allowlist of
  `["m.room.*"]` silently drops every event; measured on the live smoke),
  empty `account_data` and `to_device`, plus `set_presence=offline`.
  Membership and invite sections must NOT be filtered out.
- Deliver `rooms.invite.*.invite_state.events` on EVERY poll including the
  first, with `room_id` injected so invite and join events are the same
  shape entering the router. The join timeline of the FIRST poll is
  swallowed (initial sync replays history); invites are not, because a
  pending invite that waits out a long-poll delays the knock handshake.
- Advance the cursor (`next_batch`) ONLY after the router answers 200. A
  non-200 leaves the cursor in place and retries the SAME batch after
  backoff — at-least-once, never at-most-once; the crash window between a
  successful handle and the cursor write is absorbed by the router's
  event-id dedup.
- A retryable rejected batch holds its pre-batch cursor and retries automatically
  with exponential delay capped at 300 seconds. A homeserver `Retry-After` or
  `retry_after_ms` is respected as a minimum delay within that cap. There is no
  attempt-count circuit break; logs name the attempt, delay, held cursor and failed
  `next_batch` so prolonged head-of-line blocking remains observable.
- Break the 401 loop: a 401 against a token minted in the CURRENT login
  generation goes straight to backoff; only a 401 against an older token
  triggers one re-login.
- Enforce intake mutex PER SIDE, after side-name NORMALIZATION (lowercase;
  reject trailing slashes and URL-shaped side names — aligned with the
  project-side store's identifier rules) for both the comparison and the
  credential lookup. `Palpo.Example` and `palpo.example` are the same side;
  a trailing-slash or `https://…` side value is refused. The listener has no
  side dimension, so it conflicts with any enabled edge or sync.
- Persist the sync cursor in bridge state keyed by side, so a restart
  resumes rather than replays.
- Idempotence of repeat deliveries is the Matrix join's own idempotence plus
  the bridge's trust-state reconciliation — invite-section events carry no
  `event_id`, so event-id dedup does not apply to them (a redelivered invite
  must be harmless). The executable pin (see `B-idem`) covers REDELIVERY
  through the collector and router: the same invite section delivered on
  successive polls produces byte-identical router batches with no loop
  error or state drift. The DOWNSTREAM claim — that the join path absorbs
  the duplicate without re-warning or re-backfilling — is exercised by the
  bridge's own membership tests, not by this spec's bound tests; this spec
  promises redelivery harmlessness at the collector boundary and no more.

### Must Not

- Must not persist the sync access token to disk.
- Must not advance the cursor past a batch the router has not accepted.
- Must not abandon a retryable batch or advance its cursor; retries remain observable in logs.
- Must not run two intakes for the same side (post-normalization) in one
  bridge.
- Must not filter out membership or invite sections.

## Acceptance Criteria

Scenario: Cursor advances only on router success
  Test: A: a router failure holds the cursor and keeps retrying with capped exponential backoff
  Given a sync batch the router refuses
  When the collector reaches its retry delay cap
  Then the cursor is unchanged and the collector remains able to retry

Scenario: A retryable batch remains live at the backoff cap while holding the cursor
  Test: A-cap: a refused batch reaches the delay cap without stopping or moving the cursor
  Given the router continuously refuses one batch
  When its retry delay reaches 300 seconds
  Then polling continues, the cursor is held, and each retry logs the delay and both cursor positions

Scenario: Invites are delivered on every poll; the first join timeline is not
  Test: logs in, swallows the initial sync, delivers timeline events through the router, and persists the cursor
  Given a first poll carrying both an invite section and a join timeline
  When the collector processes it
  Then the invite reaches the router and the join timeline does not

Scenario: A repeated invite redelivery is harmless
  Test: B-idem: a repeated invite (restart redelivery) is harmless
  Given the same invite section on successive polls
  When it is delivered twice
  Then both router batches are identical and no error state accrues

Scenario: A 401 on a freshly minted token backs off
  Test: C: a 401 on a FRESHLY minted token backs off instead of re-logging in
  Given a login that succeeds and a sync that always answers 401
  When the fast re-login is spent
  Then the loop rides the exponential lane and never hammers login again

Scenario: The intake mutex is per side after normalization
  Test: D: edge and sync on the SAME side is refused, on DIFFERENT sides is allowed
  Given two intakes whose side ids differ only by case or form
  When they are compared for the mutex
  Then same-side pairs are refused and different sides are allowed

Scenario: The sync request carries the filter allowlist
  Test: E: the sync request carries an explicit filter and set_presence=offline
  Given any sync poll
  When the request is built
  Then the URL carries the filter JSON and set_presence=offline

Scenario: A half-configured sync env is refused
  Test: half-configured is refused, not treated as off
  Given only one of side or URL is configured
  When the config is resolved
  Then intake is disabled with a reason naming the missing half

### Test hygiene (binding)

Every loop-shaped test in `tests/appservice-sync.test.js` MUST use the
shared watchdog helper (absolute iteration cap, trips as an error), MUST NOT
use a mock-call count as its sole stop condition, MUST use a sleep mock that
records and yields (never a spin), and MUST call `collector.stop()` in an
`afterEach` guard.

### References

- `lib/appservice-sync.js` — implementation.
- `lib/appservice-receiver.js` — the shared router both intakes feed.
- `lib/project-side-store.js` — side identifier normalization rules.
- `docs/FOR-PROJECT-SIDES.md` — operator-facing description of the third option.
