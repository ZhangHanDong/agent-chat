spec: task
name: "Bind backend test requests to their owned loopback listener"
inherits: project
satisfies: [ADR-001]
tags: [tests, transport, isolation]
---

## Intent

Prevent backend API tests from reaching an unrelated IPv4 listener when Supertest
binds an IPv6 wildcard socket to the same port on macOS. Bind and await the owned
IPv4 loopback listener before exposing the Supertest target, and close it during
fixture cleanup.

## Constraints

### Must
- Preserve backend Express exports and expose the original Express application separately in test contexts.
- Keep existing API status, authorization, persistence, and lifecycle assertions.
- Use only owned local fixture servers for collision and cleanup verification.

### Must Not
- Do not change production source, monkeypatch Node or Supertest globally, add request retries, or weaken timeouts.
- Do not contact live external services or attribute every historical failure to the demonstrated mechanism.

## Decisions

- [JS-only] The shared backend context app remains a Supertest target backed by an awaited IPv4 loopback HTTP server.
- Direct backend import tests use the same awaited server helper and retain module lifecycle access.
- Fixture shutdown stops accepting connections synchronously and returns an awaitable close completion.

## Boundaries

### Allowed Changes
- tests/helpers/backend-test-runtime.js
- tests/helpers/loopback-test-server.js
- tests/backend-test-loopback.test.js
- tests/api-smoke.test.js
- tests/api-provenance.test.js
- tests/api-messages.test.js
- tests/backend-lifecycle.test.js
- tests/fsf0-b1-services.test.js
- tests/delivery-queue.test.js
- scripts/run-kernel-tests.sh
- docs/TESTING.md
- specs/task-backend-test-loopback.spec.md
- .agent-spec/runs/**

## Acceptance Criteria

Scenario: Backend requests reach their owned ready listener
  Test: backend context exposes an awaited IPv4 server that reaches its own handler
  Given an isolated backend with a uniquely seeded agent
  When its context is returned and Supertest reads the agent list
  Then the listener is already bound to 127.0.0.1 on IPv4
  And exactly one request reaches the owned listener and returns the seeded agent

Scenario: Cleanup releases the fixture listener
  Test: backend context cleanup closes the owned listener and remains awaitable
  Given an isolated backend context with a ready request server
  When cleanup runs
  Then the server stops accepting connections immediately
  And awaiting cleanup observes the close event and removal of the runtime directory

Scenario: An occupied loopback address fails without misrouting
  Test: loopback fixture refuses an occupied IPv4 port without reaching another handler
  Given an owned IPv4 listener occupies a port
  When a second loopback fixture requests that port
  Then binding fails with EADDRINUSE
  And neither handler receives a request

Scenario: Direct backend imports preserve restart persistence
  Test: registered agent records survive a backend module restart
  Given agents registered through the first backend module's owned listener
  When that module stops and a new module binds an owned listener
  Then the new module returns the same persisted agent names

Scenario: A direct delivery router still rejects conflicting work
  Test: DELETE /api/queue/:id refuses while delivery is in flight
  Given the delivery router is served by an owned loopback listener
  When deletion conflicts with an active delivery request
  Then the existing HTTP 409 assertion remains enforced

## Out of Scope

- Changing production listener policy or replacing Supertest.
- Module-retention and environment-isolation debt unrelated to the demonstrated socket collision.
