spec: task
name: "Dashboard refresh and unavailable preset writes"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE-PROVENANCE, REQ-CONTRIBUTION-CONSOLE-BLANK, REQ-PROJECT-BOARD-REFRESH]
tags: [dashboard, regression, refresh]
---

## Intent

Refresh visible Dashboard observations without overlapping automatic requests or
restoring stale responses. Refuse unavailable preset deletion without reporting
a successful mutation.

## Constraints

### Must
- Poll every 15 seconds only while the document is visible.
- Refresh immediately on window focus and restored document visibility.
- Skip automatic refresh while a load is pending and preserve explicit refresh supersession.
- Remove timers and listeners on cleanup and reject responses after cleanup.
- Preserve the explicit fixture query without fetching live data.
- Disable preset deletion without live provenance and refuse its callback without a success toast.

### Must Not
- Do not restart services, operate a browser, build production assets or commit changes.
- Do not change API credentials, usage aggregation or unrelated controls.

## Decisions

- [JS-only] Vitest fake timers and EventTarget events execute the actual DataProvider effect with injected React hooks and fetch results.
- Preserve the existing generation counter as the stale-response guard.
- Live preset deletion continues to use the existing write and refresh path.

## Boundaries

### Allowed Changes
- mockup/app/config/page.jsx
- mockup/components/Data.jsx
- tests/dashboard-refresh.test.js
- specs/task-dashboard-refresh.spec.md
- knowledge/observations/dashboard-refresh.md

## Completion Criteria

Scenario: Visible observations refresh periodically
  Test: refreshes the visible provider every fifteen seconds
  Given the initial Dashboard load has completed
  When 15 seconds pass with a visible document
  Then one additional load starts

Scenario: Hidden observations do not poll
  Test: skips hidden polling and refreshes immediately on visibility and focus
  Given the document becomes hidden after its initial load
  When timers and a hidden focus event fire
  Then no additional load starts
  When visibility is restored or the visible window receives focus
  Then observations refresh immediately

Scenario: Pending automatic loads do not overlap
  Test: skips automatic refresh while a load is pending
  Given a Dashboard load remains pending
  When polling focus and visibility events fire
  Then the pending load remains the only request

Scenario: Explicit refresh supersedes old results
  Test: explicit refresh supersedes a pending load without accepting its stale result
  Given an automatic load remains pending
  When the operator requests a refresh and its response arrives first
  Then the explicit response remains visible after the old request resolves

Scenario: Cleanup prevents later updates
  Test: cleanup removes timers listeners and pending response updates
  Given an automatic load is pending
  When the provider is cleaned up
  Then subsequent timers and focus events start no load
  And the pending response does not update state

Scenario: Explicit fixture mode does not fetch live data
  Test: preserves the fixture query across automatic refresh triggers
  Given the URL explicitly selects fixture data
  When initial load polling and focus events run
  Then no live request starts

Scenario: Unavailable deletion is disabled
  Test: disables preset deletion without live provenance
  Given preset provenance is fixture or absent
  When the configuration page renders
  Then its preset delete button is disabled

Scenario: Unavailable deletion refuses direct invocation
  Test: refuses unavailable preset delete callbacks without a request or success toast
  Given preset provenance is not live
  When the delete callback is invoked directly
  Then no write occurs and no success toast appears

## Out of Scope

- Changing other data projections, polling pane contents or adding write endpoints.
