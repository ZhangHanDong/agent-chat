spec: task
name: "Close live contribution and agent execution workflow blockers"
inherits: project
satisfies: [REQ-THREAD-SCOPED-SESSIONS, REQ-CONTRIBUTION-CONSOLE, REQ-OWNER-UI-APPROVAL, REQ-AGENT-OPS-CLIENT, ADR-016, ADR-018, ADR-019]
tags: [active, security, matrix, runtime, ux]
---

## Intent

Repair the reproducible failures from docs/reviews/2026-09-06-live-ux.md and
rerun the operator-authorized dedicated Palpo and Robrix workflow. Preserve
historical failed evidence and distinguish deterministic checks from live results.

## Constraints

### Must
- Route each runtime approval through the supported protocol and exact private owner binding.
- Bind every runner tool read and mutation to its authenticated dispatch/session.
- Provision launch-ready homes using the selected runtime profile.
- Keep representative intake authenticated, durable and specific to its project side.
- Expose real allocation, ownership and runtime controls in the console.
- Retain uncertain outcomes and resource fences until inspected or terminated.
- Keep released-client provenance gates intact and report unavailable external evidence.

### Must Not
- Do not auto-approve protected operations or weaken sandbox, Matrix trust or owner validation.
- Do not publish credentials, private room details or remote host inventory.
- Do not treat queued delegation, model replies or active engagements as completed work.
- Do not contact external services from deterministic test fixtures.

## Boundaries

### Allowed Changes
- backend-v2.js
- bridge-matrix.js
- lib/**
- router/src/**
- router/dist/**
- mockup/**
- tests/**
- specs/**
- knowledge/**
- docs/**
- scripts/**
- bin/hagency-up
- bin/hagency-down
- remote/**
- ./package.json
- ./package-lock.json

### Forbidden
- Root AGENTS.md and CLAUDE.md, credentials, runtime state and unrelated deployment files.
- Existing remote services outside the dedicated operator-authorized test deployment.

## Acceptance Criteria

Scenario: MCP elicitation receives an owner-bound protocol verdict
  Test: Codex MCP elicitation parks for owner approval and returns a protocol verdict
  Given the current Codex turn requests approval for an MCP operation
  When the authenticated owner permits or denies that exact operation
  Then the runner consumes the decision and answers the matching server request

Scenario: A fresh runtime request can ask again after denial
  Test: Codex can deny then freshly allow identical MCP parameters in one dispatch
  Test: approval retries preserve one-use decisions and exact runtime request bindings
  Given an owner denied an MCP operation and its decision was consumed
  When the same dispatch requests identical input under a fresh upstream request id
  Then a new owner decision is required while the original decision remains immutable
  And replaying the original request or decision cannot resume the new parked wait

Scenario: Approval history survives request-identity migration
  Test: approval request migration preserves historical decisions and the current parked wait
  Given historical decisions and a currently parked approval wait in the previous schema
  When the router migrates approval request identity
  Then every historical record is retained and only the current wait can resume its dispatch

Scenario: Runtime setup follows the selected resource
  Test: provisioned Claude runtime prepares MCP configuration and selects its primary model
  Given a Claude resource has no preexisting home
  When its accepted engagement provisions a thread runner
  Then launch configuration and selected model are available without manual repair

Scenario: Task tools cannot escape their dispatch
  Test: ephemeral task tools remain restricted to their authenticated session
  Given two tasks belong to different sessions
  When a runner reads or transitions a task
  Then its own task is accessible and the unrelated task is refused

Scenario: Coordination cannot acquire arbitrary room authority
  Test: ephemeral messaging derives its scope from the active dispatch
  Given an ephemeral runner sends a coordination message
  When its target is evaluated
  Then only admitted peers in the authenticated project scope may receive it

Scenario: A completed child returns durable input to its parent task
  Test: a scoped child reply resumes its completed parent dispatch exactly once
  Test: pending scoped replies recover their task association without replaying completed work
  Test: peer reply recovery retains pending data when current project authority is revoked
  Test: peer input attachment failure rolls back its message and session projection
  Test: parent settlement preserves shared task input processing in the child session
  Given the parent yielded and its child returns an authenticated scoped reply
  When the reply is accepted or an unassigned persisted reply is reconciled
  Then the exact recipient task receives the immutable input in a new dispatch
  And duplicate input cannot replay a completed dispatch or select another task

Scenario: Delegation from a follow-up preserves a valid Matrix thread
  Test: delegation from a threaded human follow-up uses the original Matrix root
  Test: task intents refuse nested or substituted Matrix thread roots
  Given an authenticated human follow-up already belongs to a Matrix thread
  When a runner delegates work derived from that source message
  Then the child acknowledgement uses the stored top-level thread root
  And the original follow-up remains immutable task input in a separate agent session
  And existing bindings and Matrix history are not rewritten

Scenario: Unsupported elicitation fails closed
  Test: Codex refuses foreign-thread and unsupported form elicitation without fabricating input
  Given a foreign turn or a form requiring structured input
  When the runtime asks for a verdict
  Then the client denies it without inventing a form response

Scenario: Operator setup exposes actual authorization and allocation controls
  Test: console first approval requires a complete explicit private owner binding
  Test: console allocation distinguishes unset, closed and positive capacity
  Given a fresh project side without a budget or owner binding
  When the operator configures the side and approves its first request
  Then explicit allocation and complete private ownership reach the backend

Scenario: Saved resources are visible before their first agent exists
  Test: unused eligible resources can staff roles and supply the second review family
  Test: published offers disclose qualifying unprovisioned resources without private deployment fields
  Test: offer book does not advertise unusable presets or relax the review family gate
  Test: offer replies distinguish a qualifying resource from an existing agent
  Test: project requests read the room label through its representative authority
  Given a qualifying resource preset without an agent instance
  When capability is read
  Then the resource contributes its model family without exposing credentials

Scenario: Runtime status and shutdown follow owned dispatches
  Test: started runner stop awaits owned cleanup and preserves uncertain workspace outcome
  Test: provisioned thread Stop waits for real guardian cleanup before confirming termination
  Test: thread guardian ownership does not bypass a recorded tmux target policy
  Test: runtime projection follows queued started and parked dispatches rather than tmux telemetry
  Test: a settled owned runner without cleanup proof remains fenced across stop retries
  Test: authenticated workspace outcome resolution does not prove unowned runner termination
  Test: stop awaits owned cleanup after another cancellation already settled the dispatch
  Given a local ephemeral runner owns a live task
  When its state changes or the operator stops it
  Then status reflects the dispatch and shutdown waits for confirmed owned cleanup
  And workspace inspection alone cannot prove that a host process terminated
  And a thread agent without a tmux target never acquires authority over a same-name terminal

Scenario: Shutdown retains observed descendants across process groups and reparenting
  Test: guardian confirms a detached grandchild is gone and leaves a foreign process untouched (still-parented)
  Test: guardian confirms a detached grandchild is gone and leaves a foreign process untouched (already-reparented)
  Test: lost process inspection cannot produce a guardian cleanup receipt
  Given an owned runtime launches a detached tool while its ancestry is observable
  When the tool changes process group or its intermediate parent exits before Stop
  Then the guardian retains the observed process birth identity and waits for that tool to stop
  And an unrelated process remains untouched
  And failed ownership inspection cannot produce a cleanup receipt

Scenario: New admission respects operator stop and cleanup fences
  Test: a new role request provisions a fresh agent after operator Stop without rewriting old admission
  Test: unconfirmed cleanup excludes an agent from new admission even without manualDown
  Given an existing agent was stopped by its operator or still has unconfirmed runner cleanup
  When a project requests its role again
  Then selection and capacity exclude that agent and acceptance may provision an eligible resource
  And existing engagements and owner bindings retain their original identity
  And an idle provisioned agent without either fence remains eligible for reuse

Scenario: Representative intake preserves scope and delivery across failures
  Test: registration representative sync delivers invites and retries before committing its cursor
  Test: ordinary representative sync joins before reading membership when stripped invite metadata comes first
  Test: representative room hydrates authoritative bindings and routes an admitted mention without a bot
  Test: representative room rejects unbound targets and removes revoked imported bindings
  Test: an unloaded appservice registry remains retryable beside an empty representative registry
  Test: bot sync retries side-room hydration from the committed cursor
  Test: native Markdown mentions produce readable task titles without changing source input
  Test: task title normalization preserves interior mentions links email and code
  Given a verified project representative and admitted room-agent bindings
  When representative or bot intake receives addressed work during a transient failure
  Then the authenticated message remains retryable without using stale ownership

## Out of Scope

- Publishing an unverified Agent Operations release or bypassing client provenance gates.
- Replacing native Claude or Codex permission semantics.
- Reusing or altering other deployments on the remote test host.
