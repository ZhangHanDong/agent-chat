---
kind: decision
id: ADR-019
title: "Live workflow authority and independently verified runner termination"
status: Accepted
tags: [matrix, runtime, approvals, recovery, ux]
---

## Context

The operator requested closure of the failures observed in the September 6 live
workflow and another complete run. This records the bounded implementation choices
under that instruction and the active `specs/task-live-ux-closure.spec.md` and
`specs/task-live-matrix-intake.spec.md` contracts. It extends ADR-011, ADR-016 and
ADR-018 without asserting that the deployed workflow has passed.

The prior run exposed missing representative intake, inconsistent console and
backend authority, unsupported ephemeral tools, and runtime status derived from
tmux even when a disposable thread runner owned the work. Independent review also
showed that workspace inspection and process termination require different proof.

## Decision

**Backend web launches retain the originating deployment environment.** A local
operator start already supplies the backend's resolved environment. Its launcher
chain marks this environment ready and does not source repository or runtime
dotenv files again. Standalone CLI entry continues to load repository defaults
followed by runtime dotenv. The marker changes configuration loading only; it
does not bypass authentication, approval readiness or session ownership. Console
onboarding waits for actual health and reports observed failures at their actual
phase; process creation and invented restart counts are not readiness evidence.

**Backend admission owns imported room bindings.** A representative credential
establishes transport identity and side scope; it does not establish a human owner.
For admitted side rooms, the bridge imports only current authoritative backend
room-agent bindings after checking membership, exact sender identity and the
addressed agent. Imported bindings are marked `backend_admission`; current backend
revocation removes them. Existing inviter-derived bindings replaced by this import
do not remain a second competing authority. The bridge retains its trust and
command-authorization gates, including for joined borrowers in staffed rooms.

Registration-token representatives collect events with their recorded credentials.
Credential replacement or side removal invalidates old collectors. Delivery must
complete before its cursor commits; transient backend hydration failures must
remain retryable in both representative and bot intake. An unavailable appservice
registry cannot become authoritative merely because another registry is empty.
Limited timelines without a provable earlier event boundary retain blocked gap
recovery and an operator warning; the collector must not claim complete history.

**The backend validates the first private owner binding.** Explicit console input
does not bypass validation. An approval room equal to the public project room, an
agent identity, or the side representative cannot establish the intended private
human owner binding. Exact MXIDs, room bindings and operation digests remain the
approval authority. Native private approval uses the existing canonical approval
protocol. This decision does not resolve the separately recorded conflict between
public-project-room and private-DM execution-approval requirements.

**Ephemeral tools use dispatch authority.** Task reads, task transitions, comments,
delegation and coordination require the authenticated agent and current dispatch
capability, runner identity and fence generation. The backend derives the session,
task relationship, project room and eligible peer from that authority. A runner
cannot choose another room or acquire another task's authority through a tool body.
Task creation is a scheduling receipt; a completed response or queued child is not
proof that delegated implementation or integration finished.

Codex MCP confirmation elicitation is answered through the owner-bound approval
flow only for the supported server, matching thread/turn and supported confirmation
schema. Foreign requests and forms needing arbitrary input are declined rather
than filled with invented data. Claude homes receive the managed MCP and owner
approval configuration required by their selected runtime, and dispatch argv uses
the selected primary model unless an explicit validated override applies. Native
sandbox and permission rules remain authoritative.

Each native approval wait belongs to its runtime request identity, in addition to
the dispatch and exact operation digest. A fresh upstream request may ask about
identical parameters after a denial; the previous decision is neither permission
for that new request nor a permanent ban on asking again. Consumed waits retain
their immutable decisions and cannot resume a later wait. The router permits one
unconsumed wait per dispatch and refuses a new approval id that reuses a recorded
runtime request identity. Schema migration preserves all historical waits and
decision receipts; for a parked dispatch, only its latest recorded wait remains
current. A request-id collision with ambiguous historical identity fails migration
rather than discarding records.

**Console capacity and runtime are projections of different facts.** Eligible
unused Claude/Codex presets contribute to provisionable roles and model families
without inventing an agent instance. An existing eligible agent's preset is not
counted again as unused capacity. Other frameworks remain visible as unavailable
for on-demand provisioning. Preset projections expose model metadata and declared
ceilings, never resolved credentials. Allocation admission is distinct from
measured usage and runtime enforcement.

For thread runtimes, router dispatch state controls activity, approval waiting,
blocking and duration. Tmux observations cannot make a started ephemeral dispatch
idle. Unknown duration remains unknown. Shared response snapshots avoid querying
the entire router once per agent, and public runtime failure projections redact
local paths while authorized inspection retains its separate evidence.

**Operator Stop requires host termination evidence.** Stop first persists an
admission fence. Start, agent registration and online-state patches cannot revive
an agent while lifecycle cleanup or an unconfirmed termination receipt remains.
New engagement selection, explicit agent hints and existing-agent capacity also
exclude manually stopped agents and agents with unconfirmed cleanup receipts.
Acceptance may provision a fresh home from a qualifying resource within the
existing side and seat budgets; it does not restart the old agent or rewrite its
engagements and owner bindings. An idle provisioned home without either fence
remains eligible, because a running model process is not required for admission.
Queued work may be cancelled before start; started or parked work settles as
`outcome_unknown` and retains its independently inspectable workspace state.

A settled runner promise is insufficient proof of process termination: guardian
cleanup can time out while the dispatch settles. The owned runner reports confirmed
cleanup only after the guardian's close channel is drained and its
`cleanup_complete` receipt was observed. Unconfirmed cleanup retains a durable
agent fence. The same owned close channel may later provide confirmation and clear
that termination receipt; the manual stop still does not automatically restart
the agent. Stop must await owned live guardians even if a prior cancellation has
already settled their router rows.

The live Stop counterexample showed that original process-group exit is not
descendant termination evidence: an observed tool may create a separate session
and keep writing after its runtime exits. The guardian now observes process
ancestry during runtime execution, retains observed PID and process-start
identities across reparenting, and checks those identities before signaling.
Stop pauses its unreaped direct runtime for a fresh ownership census before
terminating ancestors. Cleanup includes the original group and observed detached
descendants, with TERM followed by KILL when needed; unrelated processes are not
selected by command name or a user-provided PID. Failed or malformed inspection
prevents confirmation even if a later process-group check appears empty.

This portable process-table observer is not kernel process containment. A daemon
that forks, detaches and loses all observable ancestry entirely between process
observations can escape attribution, especially if it closes inherited stdio.
The receipt proves termination of the observed owned processes; it must not be
presented as proof of containment for arbitrary unobserved daemonization. Stronger
guarantees require a platform supervisor with durable child-creation tracking or
an enforceable containment boundary. The concrete observed detached-tool failure
and normal tracked reparenting have separate subprocess and live acceptance tests.

Successful Stop also verifies no unsettled dispatch remains and the resulting
state was persisted. A recorded tmux target additionally requires its exact
session name to match the agent name, satisfy this host's management policy and
be confirmed absent. Local Claude/Codex agents running in thread mode without a
tmux target use dispatch and owned guardian evidence; Stop does not infer a
terminal target from their name or touch an unrelated same-name terminal. It
reports `stopped: true` only after the applicable termination conditions hold.
A differing legacy session name, remote host or separately supervised ACP process
is not silently treated as an owned stoppable process.

## Consequences

Positive outcome: console state and process actions depend on their respective
authoritative records. Backend admission imports remove competing bridge ownership, while
dispatch capabilities limit tools to their actual work. Additional validation can
refuse an operator configuration that previously appeared accepted. These refusals
require correction rather than an inferred owner, task or room.

Negative outcome: shutdown may remain unavailable after a timeout even when workspace inspection
has completed. This prevents an apparent recovery from overlapping an unverified
process, at the cost of the host recovery limitation below.

### Recovery limit

Workspace outcome inspection authenticates an operator and the inspected workspace
generation. It does not observe a guardian, process tree or process exit. Therefore
an `outcome_unknown` resolution, including `continue` or `accept_completed`, cannot
clear `stopUnconfirmedDispatches` by itself. The separate workspace resolution
remains valid without changing the truth of an unconfirmed host termination.

When this backend no longer owns the runner's close channel, there is currently no
supported API that can re-establish trustworthy process termination evidence and
clear that agent fence. Stop remains unconfirmed and Start remains refused. This
is an operational recovery limitation, not a completed recovery feature. Deleting
the agent, editing its state file, accepting an arbitrary PID, or clearing the
receipt because a dispatch was inspected are not supported substitutes.

A future recovery contract must bind evidence to the exact host, runner identity
and process ownership generation, confirm termination through a supervising host,
and persist the audited result before permitting restart. It must retain
`stopped: false` while that evidence is unavailable. Such a host recovery protocol
is outside this bounded closure.

## Alternatives Considered

Clearing the agent fence whenever its dispatch has a workspace resolution was
rejected because it cannot establish process termination. Treating a settled
runner promise or missing tmux pane as sufficient was rejected because an
ephemeral guardian or descendant may still be running. Accepting a self-reported
PID would not prove process ownership and could target an unrelated process.

Retaining competing inviter-derived and backend admission bindings was rejected
because revocation would depend on which copy happened to be read. Granting broad
MCP access to the legacy task and messaging endpoints was rejected because it
would allow tool arguments to select authority outside the active dispatch.

## Verification and release limits

The task contracts bind deterministic Vitest regressions for these boundaries.
The installed agent-spec lifecycle does not execute those Node tests; its skipped
or unproven results must be preserved alongside separately executed Vitest output.
Live Matrix, model, private approval, delegation and integration acceptance remains
a separate gate. Development Agent Operations artifacts and the mismatched client
namespace do not establish released interoperability; no provenance or feature
gate is bypassed by this decision.
