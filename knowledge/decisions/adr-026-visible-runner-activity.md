---
kind: decision
id: ADR-026
title: "Matrix display names and visible runner activity"
status: Accepted
tags: [matrix, runtime, ux]
---

The operator requests readable Agent names and work status in both threads and
DMs. Initialize generated Matrix profile names from the project Agent definition,
repair existing generated names, and preserve manually customized profiles. Full
MXIDs and existing App Service namespaces remain the authorization identity.

Observe Codex app-server item events and Claude stream-json tool events in the
host runner. Publish only fixed activity categories, elapsed time and tool counts;
never publish arguments, output, paths, reasoning or private approval details.
Validate Codex thread/turn identity and fence activity writes to the active runner.

Persist one editable status message per dispatch through the existing reliable
Matrix outbox. Coalesce frequent updates and provide periodic liveness while the
runner is active. Approval parking/resumption and terminal status derive from the
router, not model claims. A completed turn is not canonical task completion.
Edits keep their original thread and Agent identity; DM edits remain private and
use the existing encryption transport. Status events are not conversational input.
Status is a projection, not a second task truth source, and grants no permissions.
