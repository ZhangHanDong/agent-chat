spec: task
name: "Scoped Palpo fleet reception and verified target requests"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE, REQ-OWNER-UI-APPROVAL, REQ-THREAD-SCOPED-SESSIONS, ADR-019, ADR-023]
tags: [active, matrix, authorization, onboarding]
---

## Intent

Implement the operator-authorized Palpo admin integration. This bounded extension
permits a verified reception event to request service in a different, authorized
target project. Existing direct-room !request authorization remains unchanged.

## Constraints

### Must
- Authenticate the narrow versioned protocol on the appservice listener with that fleet's own hs_token.
- Verify full Matrix sender, exact immutable source event and reception, target membership and invite authority, and a separate encrypted owner approval room.
- Persist source, target, fleet, request identity and authorization version; conflicting replay must fail before allocation.
- Require provider manual approval and return public status to the original reception context.
- Record connection receipts only from actual authenticated push delivery of a custom probe event.
- Keep private runtime approval authority unchanged and exclude custom events from task dispatch.
- Require explicit authenticated task transitions after verified work; a completed model turn alone cannot complete its task.
- Route provisioned task-writer commands to the canonical task only while a complete ephemeral dispatch context is present.
- Resolve mentionless thread replies only from an exact active task binding for the same project room and authenticated original requester, with current admitted membership.

### Must Not
- Do not expose operator APIs, tokens, private owner rooms or runtime profiles through the callback listener.
- Do not infer target authority from room names, requester localparts or arbitrary chat text.
- Do not use reception whitelist membership to approve a target request.
- Do not contact live services from deterministic tests.

## Boundaries

### Allowed Changes
- backend-v2.js
- bridge-matrix.js
- lib/fleet-protocol.js
- lib/appservice-receiver.js
- lib/engagement-store.js
- lib/engagement-notice.js
- scripts/write-v1-agent-task.js
- router/src/runner.ts
- router/dist/runner.js
- router/dist/runner.d.ts
- tests/ephemeral-session-tools.test.js
- tests/router-runner.test.js
- tests/bridge-representative-intake.test.js
- tests/router-backend.test.js
- tests/fixtures/fake-codex-app-server.mjs
- specs/project.spec.md
- mockup/app/engagements/page.jsx
- mockup/components/CredentialForm.jsx
- mockup/lib/fleet-credential-import.js
- mockup/lib/i18n.js
- mockup/next.config.mjs
- mockup/.gitignore
- tests/fleet-protocol.test.js
- tests/api-fleet-protocol.test.js
- tests/bridge-fleet-protocol.test.js
- tests/fleet-credential-import.test.js
- tests/appservice-receiver.test.js
- scripts/architecture-boundaries.json
- specs/task-palpo-fleet-protocol.spec.md
- docs/**

### Forbidden
- Live deployment configuration, credentials and direct runtime-state edits.

## Acceptance Criteria

Scenario: Project thread discussion requires a mention before waking its worker
  Test: project thread discussion is archived without waking until explicitly mentioned
  Test: thread recipient lookup requires one active bound task for the exact room root and requester
  Given a restarted bridge sees a joined borrower's mentionless thread reply
  When the message has no agent mention
  Then the discussion is archived without waking a worker
  And an explicit mention can target only an admitted agent in that room
  And canonical lookup still rejects unknown, ambiguous, foreign-room and foreign-requester roots

Scenario: Provisioned commands update the canonical task explicitly
  Test: ephemeral task writer completes only its canonical task after explicit done
  Test: ephemeral task writer refuses incomplete context foreign tasks and expired dispatches
  Given an active task and its authenticated one-shot runner in a provisioned home
  When the runner records heartbeat, waiting, resume or explicit completion through task-writer
  Then the existing canonical task API records only its own authorized transition
  And incomplete or expired authority cannot fall back to legacy agent metadata

Scenario: A successful model turn preserves unfinished work
  Test: runner asks for explicit task completion and a successful turn keeps the task open
  Given a task runner has verified its current deliverable or yielded unfinished work
  When the model receives its authoritative execution context
  Then the prompt requires explicit canonical completion only for verified finished work
  And a completed model turn without that transition leaves the task unfinished

Scenario: Readiness proves actual inbound delivery
  Test: fleet probe requires exact durable push receipt and never dispatches a task
  Given a configured fleet appservice and its representative's reception event
  When the HTTP probe is checked before and after authenticated push delivery
  Then only the matching received event establishes readiness

Scenario: Reception requests preserve target and manual authority
  Test: verified reception request remains pending and its context survives replay
  Given an authorized requester, target project and private owner room
  When the fleet submits the exact custom Matrix request event
  Then the persisted request names its source and target separately and remains pending

Scenario: Request tampering and unauthorized targets fail closed
  Test: fleet requests reject source target owner and cross-fleet tampering
  Given a request event and a fleet-scoped credential
  When its sender, target, owner, authority version or fleet is changed
  Then no engagement or allocation is created

Scenario: Scoped callback cannot become an operator proxy
  Test: fleet callback routes require their own appservice token and expose no generic proxy
  Given multiple appservice registrations
  When callbacks use another fleet token or an unrelated API path
  Then the authenticated fleet boundary and narrow route allowlist remain enforced

Scenario: The real bridge adapter preserves callback authority
  Test: real bridge records the push probe and forwards only verified private-owner requests
  Given the loaded inbound registration and its acting credential
  When a custom event and scoped request pass through the real callback router
  Then delivery is durable, owner-room reads use the private bot and no chat handler runs

Scenario: Approval returns to the reception context
  Test: reception approval receipts name the target and contain no private owner data
  Given a verified reception request that the provider manually approves
  When the public receipt is materialized
  Then it replies to the source event and directs work to the verified target room
  Test: approved fleet engagement admits the target and queues its result only in reception

Scenario: Owner download imports into the selected server
  Test: registration JSON import validates fleet server namespace and token scope before save
  Given an owner-download registration file and a selected project side
  When the operator imports the file
  Then only a matching supported registration populates the masked credential form

Scenario: Revoked target authority cannot receive resources
  Test: fleet approval rechecks current target authority before allocating
  Given a pending request whose project owner has lost room authority
  When the provider attempts to approve its earlier authorization context
  Then approval fails and no allocation is reserved

## Out of Scope

- Automatic resource approval, arbitrary remote administration, credential rotation,
  and treating a Matrix identity's connection as proof of local task completion.
