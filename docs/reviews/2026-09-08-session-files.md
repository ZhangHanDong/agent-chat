# Bidirectional Matrix files — 2026-09-08

The operator requested Agent output files in rooms/DMs and then member uploads
for Agents. ADR-027 and task-session-file-delivery govern this work.

## Implementation

Managed MCP now exposes send_file, get_file_delivery and receive_file. Agent
token plus active dispatch capability is required before filesystem access.
Destinations come from the authenticated conversation. Outbound reads are bounded
regular workspace files, reject escapes/special files/hard links, and become
immutable hashed snapshots. Existing reply outbox claims, receipts and stable
Matrix transaction IDs are reused. Prepared media content persists before event
send; retries do not reupload successfully prepared media. Delivered is returned
only after acknowledgement. Native shell/network permissions remain unchanged.

Incoming files are downloaded with the admitted room's credential, bounded to
20 MiB even when size metadata is absent, decrypted and verified, and associated
with their authenticated sender/event. Group uploads remain background until an
Agent is mentioned; DM files wake their Agent directly. receive_file can read
visible historical attachments, but rejects foreign rooms, future inputs and
pre-promotion private history. Cache bytes are verified again before receipt.
Permanent file errors are archived explicitly without blocking subsequent chat.
Filenames beginning with ! are never interpreted as bot commands.

Encrypted destinations encrypt actual media bytes and the Matrix event. The
bounded inbound decryptor uses the same Matrix Rust attachment implementation
as matrix-bot-sdk, now declared as a direct dependency. A disposable uninitialized
CryptoClient cannot perform this operation; real encryption tests exposed that
SDK readiness constraint. macOS workspace aliases are canonicalized consistently.

## Validation

141 distinct tests across 11 suites passed after fixing the exact per-tool
approval allowlist assertion. The security suite was rerun after adding tampered
ciphertext and undeclared oversized stream checks. Suites: session-file,
matrix-file-bridge, ephemeral-session-tools, invited-room-routing,
matrix-conversation-context, matrix-direct-chat, router-activity, matrix-activity,
router-runner, router-backend and router-core.

Router compile/build consistency, router boundary, architecture ownership,
JavaScript/shell syntax, targeted ESLint, remote package sync and 313 spec bindings
passed. Native agent-spec 1.4 parse/lint succeeds, score 1.0. Lifecycle has one
boundary pass and SIX unsupported Vitest scenario skips; it is explicitly NOT a
passing lifecycle. An initial boundary failure for bare package.json was resolved
by using ./package.json and ./package-lock.json in the contract, which the native
path recognizer accepts. Full prior failed/skip outputs remain in the private rig.

## Deployment and real Matrix evidence

After confirming no started/parked/leased/queued work, stopped bridge/backend,
backed up the full runtime and credentials, and restarted backend99858 /
bridge99880. Backup: files-backup-20260908-114826 in the existing private E2E rig.
No Palpo code, configuration, container or Robrix binary was changed.

Real Codex Agents received CSV bytes (apple3, pear5), calculated the total and
sent an 8-byte TXT containing exactly total=8 followed by newline. Group, plain
DM and encrypted DM each produced acknowledged attachments. All three were
downloaded through https://crew.ominix.io:19443 and verified against SHA-256
901b49d032c66e911bcf78faf69e02b439d2ce6568238f0806915c387ac0411e.
The group upload did not create an Agent input before the subsequent mention;
its output retained that thread root. Both DM outputs had no thread relation.
Encrypted DM input was uploaded through actual Playwright/Element attachment UI;
output media was ciphertext, the event was m.room.encrypted, and decryption
recovered the exact expected bytes. No native Robrix UI automation is claimed.

The isolated Element test server's CSP originally set frame-ancestors 'none' on
its sandboxed /usercontent/ download helper too. This blocked browser downloads
with ERR_BLOCKED_BY_RESPONSE despite valid media and rendered attachments. Its
local serve.py now permits only same-origin ancestors for that helper; the main
page policy and sandbox remain intact. The prior server file is backed up.
This is test client configuration, not a Palpo change.

Private evidence root:
/Users/yuechen/Library/Caches/palpo-admin-e2e/2026-09-06

- session-files-deployment-0908.json
- session-files-group-0908.json
- session-files-dm-0908.json
- session-files-encrypted-0908.json
- session-files-browser-0908.json and per-scenario screenshots/downloads
- session-files-live.mjs, session-files-encrypted.mjs, session-files-browser.mjs

After correcting the local CSP, Playwright clicked the actual attachment controls
and saved files in all three conversations. The browser independently decrypted
the encrypted attachment, preserved its filename and recovered the same expected
hash. Group display retained its thread relation; DM displays had none.

The Playwright upload sender was initially closed immediately after HTTP ACK,
leaving one stale not_sent local echo in that test profile. The exact remote
event was read back, then only its duplicate local pending entry was cancelled
using the client's local pending-event API; the uploaded Matrix event was not
redacted. Cancelling the already-acknowledged local copy triggered an Element
timeline listener error; a fresh browser load was used to check recovery. This
test-harness cleanup is recorded separately and does not involve the user's
native Robrix profile.
