---
kind: decision
id: ADR-020
title: "Resume a completed thread task for fresh authenticated requester input"
status: Accepted
tags: [matrix, sessions, tasks, recovery]
---

## Context

The operator completed a JavaScript task and explicitly mentioned its agent in
the same Matrix thread with a Python follow-up. Intake durably attached this new
message and queued a fresh dispatch against the unique task binding. The task
was done, so claimDispatch silently skipped the new dispatch forever.

## Decision

Continue the existing one-task-per-assignee/thread contract. A completed task may
return to in_progress when claiming a never-started dispatch containing unprocessed
supplementary Matrix input from the original human requester, in that same
durably activated task/session/room/thread. Preserve the same task, session and
thread identities and all prior dispatches, outputs and immutable inputs. Record
the previous completion timestamp and triggering input in a router audit event;
clear the task's current completion timestamp for the newly requested work.

The requester is verified from the original task root's full Matrix sender, not
from a display name, model statement or a generic peer message. The triggering
input must belong to the queued batch and the task, and must not already be
processed. Completed batches, replayed inputs and another sender cannot reopen
the task. Ordinary task transition APIs retain their existing state machine.

Reopening commits in the same transaction as the new dispatch claim, only after
existing runner, unresolved-outcome, workspace quarantine and lease gates pass.
An earlier runner still publishing its result is allowed to settle before this
transition. A blocked or uncertain task requires its existing explicit recovery.
Pending ineligible work on a done task receives a deduplicated thread notice.

This also recovers the operator's already-queued, never-started follow-up through
normal startup scheduling. It does not replay a started dispatch, recreate the
Matrix message, bypass runtime approval, or modify runtime data directly.

## Validation

Bounded tests cover fresh follow-up execution, a restart with the existing queued
message, exactly-once processing across subsequent completions, correct thread
context, running-work serialization, blocked/uncertain/quarantined work, and
foreign, peer, mismatched, missing or processed inputs. The live queued Python
request is a separate acceptance check after deployment.
