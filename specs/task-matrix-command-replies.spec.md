spec: task
name: "Restore repeated project command replies"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE, ADR-019]
tags: [active, matrix, ux]
---

## Intent

Repair the live borrower workflow where a fresh !offer receives no visible reply
because the representative reuses an earlier reply's Matrix transaction id.

## Constraints

### Must
- Distinguish fresh command events even when their replies have identical text.
- Keep replayed replies for one authenticated input event idempotent.
- Isolate concurrent command reply identities and preserve room authority.
- Run deterministic tests without contacting a live service.

### Must Not
- Do not change project admission, credentials, approval authority or existing engagements.
- Do not treat an unaddressed room message as agent work.

## Boundaries

### Allowed Changes
- bridge-matrix.js
- lib/bot-commands.js
- tests/bot-command-reply-delivery.test.js
- specs/task-matrix-command-replies.spec.md
- docs/agent-knowledge.md
- docs/progress.md

### Forbidden
- Credentials, runtime state, root workspace instructions and unrelated deployments.

## Acceptance Criteria

Scenario: Fresh offers produce fresh replies through either representative route
  Test: identical fresh offers remain visible on the bot homeserver
  Test: identical fresh offers remain visible on another homeserver
  Given two distinct authenticated command events asking for the same offer book
  When the representative sends their identical answers
  Then Matrix records one visible reply for each input event

Scenario: Replay and concurrent handling retain the correct command identity
  Test: replaying one offer after command handler recreation does not duplicate its reply
  Test: overlapping offer handlers preserve independent replay identities
  Given representative command replies can be retried or handled concurrently
  When the same authenticated input event is handled again
  Then its existing reply is reused without suppressing a different command's reply

Scenario: Calls without a replay identity remain independent
  Test: commands without an event id do not suppress later identical replies
  Test: independent bridge notices do not share a content-derived transaction id
  Given two independent calls with identical reply content and no input event id
  When both calls send their answers
  Then both answers are visible

## Out of Scope

- Replacing bot SDK encrypted message delivery or its retry policy.
- Automatically submitting or approving the operator's next engagement request.
