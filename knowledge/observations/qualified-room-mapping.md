# Qualified room mappings and the acting credential projection

The 2026-09-08 local E2E reproduced F03 duplicate-name acceptance after a bridge
restart. Startup had migrated an original room's bare group key to
`name@127.0.0.1:8008`, while a newly named or renamed room wrote the bare `name`
on that same side. The original route survived, but a second room became a
member of the same backend group without a mapping conflict.

`actingSideFor` projected `side.serverName` but omitted `side.id`; the actual
`onRoomEvent` and `tryMapRoom` callers read `side.id`, so a valid acting credential
still produced a null mapping side. The explicit `bindRoom` primitive also
omitted the side. The projection now carries the canonical credential-map key,
and each of these mapping entry points supplies it.

Historical persisted keys can contain a mixed-case server suffix. Project-side
registration normalizes server names to lowercase, so exact key lookup alone
would recreate the collision under different side spelling. Mapping and lookup
now compare the side portion without case, preserving the existing key spelling
and the exact group name. Case-equivalent aliases that point to one room remain
usable; aliases pointing to different rooms are ambiguous and are refused with
diagnostics. The own-server exclusion also ignores server-name case, matching
startup migration's existing rule that own-server routes stay bare.

Successful rename and unmap remove equivalent aliases for the room's previous
group and side. Otherwise the case-insensitive lookup could route through a
leftover alias after the original route was removed. Cleanup checks each alias's
room ID and preserves aliases owned by other rooms or sides; it runs only after
destination collision validation on rename.

Conflict validation must precede any old reverse-map deletion. Previously a
qualified rename collision returned false after deleting the renamed room's
previous group-to-room route; conflict reporting then persisted the incomplete
map. The validation order now preserves both maps on refusal.

Regression coverage lives in `tests/bridge-qualified-room-mapping.test.js` and
is bound by `specs/task-qualified-room-mapping.spec.md`. It imports the real
bridge with persisted migration fixtures in isolated temporary runtimes, uses
the real credential helpers, replaces network access, and checks both in-memory
and persisted routes. Direct map helper tests with manually supplied side IDs
alone did not expose the credential projection mismatch.

These observations refine F03 room routing under ADR-016; they do not change
side authentication, room trust, or room-agent ownership. They also do not
establish live acceptance of the repair, which requires the separate E2E recheck.
