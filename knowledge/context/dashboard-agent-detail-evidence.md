---
kind: context
id: CTX-DASHBOARD-AGENT-DETAIL-EVIDENCE
title: "Dashboard detail evidence and on-demand runner semantics"
status: Observed
tags: [dashboard, runtime, provenance, regression]
---

The 2026-09-06 local Dashboard E2E exposed independent display bugs. A successful
headless agent with no persistent pane was shown as `TMUX · null`; absent logs
were described as no activity with an `acp-up` suggestion. The header pause button
only toggled its own state and never affected the Runtime timer. Profile displayed
a hardcoded creation date and editable fixture guidance whose Save handler only
raised a success toast. Oversight invented assessment times, work evidence and
decision history for live agents.

The detail view now consumes the backend's explicit `runner.mode = on-demand`
projection. Availability describes whether dispatch may start; activity describes
the durable dispatch record and is not an OS process observation. No pane is
expected for this mode. `runner.model` is declared configuration, and a null model
remains provider default instead of being inferred from a preset or global file.
A resolved runtime profile also takes precedence over a subsequently edited
preset, including when its model is null.

The header has no pause or cadence control. Real pane polling is owned by the
mounted pane component and occurs only for a live roster entry with a named tmux
pane. Changing tabs unmounts the poller and cancels its timer. Fixture data never
starts capture requests, even when its name matches a real agent.

Activity consumes `agentLog` samples only when agent provenance is explicitly
fixture, and labels those samples at their point of use. Live logs and supervisor
assessments have no connected endpoint in this Dashboard: their panels say the
data is not provided. This absence makes no claim about whether an agent has
previously run. Profile remains read-only, preserves actually supplied identity
fields and reports missing creation, guidance and ownership facts explicitly.

`tests/dashboard-agent-detail.test.js` renders the real JSX with React's server
renderer and bounded data hooks, plus direct runtime/pane policy tests. The first
16 render cases failed against the previous behavior before the repair. A further
two failing cases caught preset model drift and availability/activity conflation.
The final suite has 21 passing cases. This is deterministic rendering evidence,
not a browser E2E or a live poll-timer test; GUI verification belongs to the parent
E2E run. Lifecycle skip verdicts for Node scenarios remain distinct from these
independently executed Vitest results.

The final read-only review found a separate destructive path: `AgentActions`
accepted fixture records and sent a real force-delete request keyed only by the
sample name. Its existing `busy` state did not disable submission, and the handler
did not independently verify the typed name. A sample/live name collision could
therefore delete a real agent, including after automatic polling changed the
roster source while a confirmation was open.

AgentActions now requires the current record's live provenance, current name and
exact typed confirmation before issuing its existing delete operation. It disables
non-live action controls with a visible explanation. An immediate ref guard closes
the same-render double-submit window and remains held through response handling,
refresh and navigation; failure releases it for a fresh retry. The real backend
permission and deletion-confirmation semantics are unchanged.

`tests/dashboard-agent-actions.test.js` adds eight actual-component rendering and
callback cases. Seven failed before the fix; all eight pass after it, including
direct invocation of non-live callbacks, a callback captured before provenance
changes, duplicate submissions during the request and refresh, and a rejected
delete followed by a fresh retry. The combined detail, action and refresh suites
passed 37 tests. No real delete request or GUI operation was issued by these tests.
