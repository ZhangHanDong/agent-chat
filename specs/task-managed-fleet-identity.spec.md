spec: task
name: "Derive managed fleet agent identity from imported side registration"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE, ADR-019]
tags: [active, matrix, onboarding, identity]
---

## Intent

Close the real onboarding blocker where importing a fleet registration still
requires a manual MATRIX_AGENT_PREFIX override. Its validated side registration
must determine naming consistently across minting, admission, sending and intake.

## Constraints

### Must
- Derive the managed fleet prefix from its exact accepted sender and namespace.
- Preserve the configured legacy prefix for other credential types and legacy App Services.
- Retain exact side, namespace, roster and full Matrix identity authorization.
- Fail closed for inconsistent managed registration scope.
- Recognize modern Matrix mentions and existing text addressing for the admitted identity.

### Must Not
- Do not mutate the global process prefix or another side's registration.
- Do not infer ownership from a foreign fleet's matching agent name.
- Do not contact live services from deterministic tests.

## Boundaries

### Allowed Changes
- backend-v2.js
- bridge-matrix.js
- lib/matrix-agent-identity.js
- tests/managed-fleet-identity.test.js
- tests/api-fleet-protocol.test.js
- tests/bridge-representative-intake.test.js
- specs/task-managed-fleet-identity.spec.md
- docs/**

### Forbidden
- Live runtime state, existing credentials, process restarts and unrelated code.

## Acceptance Criteria

Scenario: Managed naming does not require a global override
  Test: imported fleet identity overrides only its own side while legacy naming stays unchanged
  Given a global ac_ default and a valid imported fleet registration
  When identities are derived for managed and legacy sides
  Then each side uses its own authorized namespace and malformed scope fails closed

Scenario: The backend admits its generated fleet identity
  Test: default prefix backend mints and admits the imported fleet identity
  Given a managed side and an agent without a recorded Matrix identity
  When the backend mints the identity and manually approves its engagement
  Then the registered MXID uses the imported fleet prefix and joins the target

Scenario: The bridge recognizes only the admitted fleet mention
  Test: default prefix bridge routes the admitted managed identity and rejects foreign fleet mentions
  Given an admitted agent and a global ac_ default
  When a requester mentions its assigned Matrix identity
  Then the bridge selects that agent and sends under the same identity
  And another fleet's same-name identity cannot select it
