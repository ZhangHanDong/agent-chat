# Palpo fleet reception protocol v1

This is the bounded HAFleet integration for the operator-authorized Palpo admin
application. It extends the existing direct-room request path with a separate,
verified reception-to-project path. Ordinary `!request` still targets its source
room; no chat parameter can select another target.

## Authority and transport

The four public operations share the existing App Service listener. They require
that registration's `hs_token`; the authenticated registration selects the side.
They do not expose HAFleet's backend listener or accept its operator token.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/fleet/v1/capabilities` | Public offers, fleet identity, representative and actual private approval bot |
| POST | `/api/fleet/v1/probe` | Check a particular received Matrix challenge event |
| POST | `/api/fleet/v1/requests` | Submit a verified Matrix request for manual resource approval |
| GET | `/api/fleet/v1/requests/:requestId` | Public request and fulfillment status for this fleet |

The bridge forwards only fixed operations to its local `/api/fleet-control`
endpoint using the existing bridge authority. The backend rechecks the current
registration before recording or disclosing any result. There is no arbitrary
path, URL, HTTP method or operator-token forwarding surface.

The fleet identity is the installed registration's `hf_<32 hex digits>` prefix,
with sender localpart `<fleetId>_representative`. HAFleet derives its working-agent
prefix `<fleetId>_agent_` from that side's accepted sender and exact namespace.
Importing the registration therefore needs no `MATRIX_AGENT_PREFIX` override.
Minting, admission, sending and mention recognition use the same side scope;
legacy registrations retain their configured prefix. Inconsistent managed sender
and namespace pairs fail closed.
As before, one HAFleet instance has one registration per project server. Separate
HAFleet instances on the same Palpo retain distinct registrations and namespaces.

## Connection receipt

Palpo sends `com.hafleet.connection.probe.v1` in the fleet reception as that fleet's
representative, containing `fleetId` and a fresh 16–128 character base64url/UUID
challenge. Only an authenticated **push** received through the normal provenance
gate records evidence. Sync polling and HTTP readback cannot manufacture a push
receipt. The probe operation supplies `fleetId`, `sourceRoomId`, `sourceEventId`
and `challenge`; all must match the durable receipt and Matrix event readback.

The reception must be invite-only, unencrypted, and joined by the representative.
A registration binds one verified reception; attempting to replace it with another
room conflicts. Credential-generation changes invalidate old reception evidence.
The bridge persists receipts in its existing protected state, bounded to the most
recent 100 per fleet. Custom protocol events never become chat commands or tasks.

## Request identity and ownership

The requester's actual Matrix session sends
`com.hafleet.engagement.request.v1` with these fields:

```text
v: 1
fleetId, requestId, requesterMxid, sourceRoomId
targetProjectId, targetRoomId, ownerMxid
role, requestedTokens, ratePerDay, authVersion: 1
```

The scoped HTTP POST adds the returned `sourceEventId` and `ownerDmRoomId`.
**The private approval room ID is not included in the plaintext reception event.**
Its full value stays in the authenticated submission and operator-only persisted
request context. Public status and result messages omit it.

HAFleet independently verifies the immutable event ID, full authenticated sender
and every public request field. It requires requester and representative membership
in the source reception. Target requester and owner must be joined; requester and
representative must have invitation authority, while the declared owner must have
room administrator power (at least 100). The target is invite-only and plaintext.

The target room must carry `com.hafleet.admin.binding.v1` state with state key
`fleetId` and exact content:

```text
v: 1, fleetId, purpose: "project", projectId, ownerMxid, authVersion: 1
```

This binds the project identifier and authorization version to the actual room.
The private approval bot separately reads the approval room: it must be invite-only,
Megolm encrypted, and have exactly the owner and that bot joined. The representative
does not gain access to the private room.

The backend persists the canonical context with the engagement. Its digest includes
source event, source room, target, ownership proposal, version and request identity.
An identical retry reuses the engagement; a changed context under the same request
ID conflicts before allocating anything. Provider approval remains manual even if
either source or target is whitelisted. The ordinary direct-room whitelist behavior
is unchanged.

The operator sees the verified ownership proposal prefilled in the approval form
and must still confirm it. Approval rechecks current target membership, owner power,
room policy and the registered project marker before reserving resources. A revoked
or unreadable authorization leaves the request pending. Approval cannot substitute
an unverified owner/private-room pair into this protocol's request.

## Results and execution

The existing durable approval-notice queue sends the approved allocation and actual
agent identity to the source reception, replying to the original custom request
event and naming the target room for work. Agent admission and runtime bindings
remain attached to the target. Private runtime approval details never enter either
public result. The representative's output remains excluded from task dispatch.

Scoped status reports allocation, public serving configuration, fulfillment phase
and a sanitized failure. Its `ready` flag requires active/bound state and an actual
joined-members read observing that agent in the target room. This is service
admission readiness, not proof of a completed task or a healthy local process.

Task completion is an explicit canonical transition, separate from successful
model-turn settlement. Runner context instructs the agent to verify its complete
deliverable and confirm `transition_task(..., status: "done")` or
`./task-writer done` before claiming completion. Waiting or delegated work stays
open. Inside an authenticated ephemeral dispatch, the provisioned task writer
uses the existing scoped session-task API for heartbeat, wait, resume and done;
it never substitutes legacy agent metadata for the router task. Missing, partial
or expired dispatch authority fails closed. Ordinary home and graph commands keep
their legacy behavior outside an ephemeral dispatch.

A mentionless followup in an existing project thread resolves through the
bridge-authenticated approval-binding read. The lookup requires the exact project
room, original thread root and full original requester MXID; exactly one unfinished
task and its current approval binding must identify the recipient. The bridge
separately verifies current requester, representative and agent membership before
routing. Unknown or ambiguous roots, another requester and revoked admission do
not fall back to a room's last active agent. This lookup reads durable backend
bindings, so it also works in a newly started bridge without prior thread memory.

Private execution approvals still use the existing native Matrix/Robrix owner UI.
The Palpo web app does not implement browser decryption or that native approval
protocol. A Playwright test of onboarding, resource approval and a non-escalating
task cannot be reported as a browser test of private execution approval.

## Operator UI and deployment

The existing Engagements page's project-side credential form accepts the owner
download `{fleetId, serverName, credentialVersion: 1, registration}` or the raw
registration object. Import checks the selected server, exact fleet representative,
exclusive assigned user namespace, empty unrelated namespaces, callback URL and
distinct required tokens. It shows nonsecret scope and fills masked inputs locally;
only the explicit Save action writes the credential. Importing another server or
a broader namespace is refused.

Set `HAFLEET_CONSOLE_DIST_DIR=.next-admin-e2e` for both build and start when running
the isolated admin E2E console. This preserves the existing console's `.next`
artifact. No new backend/bridge protocol environment variables are required beyond
the normal isolated runtime, AS listener and side credentials.

## Verification limits

The task contract is `specs/task-palpo-fleet-protocol.spec.md`. Deterministic tests
cover scope rejection, immutable request matching, owner and target authorization,
durable push receipt, real bridge adapters, replay, target admission, reception
notices and credential import. All Matrix I/O in these tests is injected or served
by local fixtures. Native agent-spec does not execute Node/Vitest scenarios: its
skips remain nonpassing, separate from the passing Vitest evidence. Live deployment
and browser acceptance are recorded by the coordinating deployment task.
