spec: task
name: "Handle Codex native MCP approval requests without unattended hangs"
inherits: project
satisfies: [REQ-OWNER-UI-APPROVAL-CODEX-COORDINATION, REQ-OWNER-UI-APPROVAL-BINDING, REQ-OWNER-UI-APPROVAL-FAIL-CLOSED, ADR-005, ADR-011]
tags: [codex, mcp, approval, regression]
---

## Intent

Repair a real Codex 0.153.4 dispatch blocked before its first Hagency MCP call.
The app-server sends mcpServer/elicitation/request, which the current runner
silently ignores. Preserve the accepted narrow control-plane exception and
route other identified tool approvals through the existing owner flow.

## Constraints

### Must
- Correlate a native MCP request to exactly one unconsumed active tool item in the same thread, turn and server with identical arguments.
- Reuse the existing Hagency coordination predicate injected by the backend; preserve the exact whitelist and attachment policy.
- Bind owner decisions to the real correlated item id, native request id and complete operation digest before replying.
- Return native single-call responses without session or persistent approval grants.
- Make unsupported, malformed, stale and ambiguous server requests fail closed with a visible reason.

### Must Not
- Do not infer tool identity or authority from display text, disable an approval feature or invent an item id.
- Do not import application lib modules into the router or modify MCP tool implementations.
- Do not contact live services in deterministic tests.

## Decisions

- Support native form requests with codex_approval_kind=mcp_tool_call and an empty object schema.
- Track structured item/started and item/completed events for native mcpToolCall correlation.
- The backend injects codexPermissionRequestNeedsOwnerApproval; absence of this policy keeps tools owner-gated.
- Use the existing park, owner decision, durable apply and resume sequence for owner-gated tools.
- Cancel unsupported URL/auth or input-requiring forms; reject unknown server RPC with JSON-RPC -32601 and settle started work as outcome_unknown.
- [JS-only] Verify through a real child fake app-server and real router store using Vitest, then rebuild checked-in JavaScript.

## Boundaries

### Allowed Changes
- router/src/runner.ts
- router/dist/**
- backend-v2.js
- tests/router-codex-mcp-approval.test.js
- tests/router-runner.test.js
- tests/fixtures/fake-codex-mcp-elicitation.mjs
- specs/task-codex-native-mcp-approval.spec.md

### Forbidden
- lib/mcp-server-core.js
- remote/**
- Global Codex configuration and active runtime processes

## Acceptance Criteria

Scenario: Exact Hagency coordination avoids recursive owner approval
  Test: native Hagency coordination uses the existing exact predicate and accepts only once
  Given one current Hagency tool item matches its native request
  When the existing predicate identifies a coordination operation without attachments
  Then the exact native request receives accept without parking or persistent grant

Scenario: Other tools remain durably owner gated
  Test: native MCP owner approval binds actual item request and digest before native response
  Given a current non-exempt MCP call or Hagency message with attachments
  When its owner allows or denies the parked operation
  Then the durable decision is applied before the corresponding accept or decline response

Scenario: Missing policy does not grant coordination authority
  Test: missing injected coordination policy keeps even get_task owner gated
  Given the backend has not supplied the established predicate
  When a matching get_task approval arrives
  Then it follows owner approval

Scenario: Ambiguous or stale tool identity fails closed
  Test: rejects missing ambiguous stale wrong-turn and mismatched-argument MCP candidates
  Given no current unique candidate or a mismatched thread turn server or arguments
  When native elicitation arrives
  Then it receives cancel and the dispatch records a visible outcome_unknown reason

Scenario: Repeated elicitation cannot reuse a tool item
  Test: duplicate elicitation cannot consume the same tool item twice
  Given a tool item already supplied one native approval
  When another native request targets that same item
  Then the second request is canceled without another local or owner grant

Scenario: Unsupported elicitation forms cannot fabricate user input
  Test: rejects URL input-form malformed and uncorrelated elicitation requests
  Given a URL request, required form input, malformed parameters or null turn id
  When the runner receives the request
  Then it emits cancel and records the unsupported or mismatched reason

Scenario: Unknown server RPC cannot silently hang
  Test: unknown server RPC receives a protocol error and visible outcome_unknown
  Given a started dispatch receives an unknown native request method
  When the adapter reads that request
  Then it writes error -32601 and records outcome_unknown before the execution deadline

Scenario: Approval transport failure cannot permit a tool
  Test: owner approval rejection and persistence refusal cancel without accepting
  Given owner delivery fails or a decision cannot be durably applied
  When native MCP approval is handled
  Then the response never accepts and the dispatch records outcome_unknown

Scenario: Late owner decisions cannot revive a terminated runner
  Test: a late owner allow after duplicate or unknown RPC cannot resume or accept
  Given an owner decision is pending when a duplicate or unsupported RPC terminates the dispatch
  When the owner decision later allows the operation
  Then no durable apply, resume or native accept occurs

Scenario: Malformed request identity cannot receive approval
  Test: malformed or absent native request IDs fail visibly without accepting
  Given a native request lacks a string or safe integer request id
  When the adapter reads the request
  Then it returns invalid-request error with null id and records outcome_unknown without approval

Scenario: Waiting owner approval cannot revive an invalidated tool item
  Test: an item completed or restarted while owner approval waits cannot receive a late allow
  Given a correlated tool item completes or repeats its start while owner approval is pending
  When the owner later allows the operation
  Then the adapter cancels before durable apply or resume and records outcome_unknown

Scenario: Canonical arguments preserve every own property
  Test: operation digest binds all MCP arguments without depending on display order
  Given JSON arguments contain a prototype-named own property
  When operation digests are compared
  Then key order is irrelevant but each own property changes the bound digest

## Out of Scope

- Changing the established Hagency coordination whitelist or task capability authorization.
- Collecting generic form input, opening authentication URLs, or modifying UI approval schemas.
- Stopping or replaying the currently blocked real dispatch; the operator owns that recovery.
