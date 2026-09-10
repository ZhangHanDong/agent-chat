---
kind: decision
id: ADR-017
title: "Align acceptance with the operator's completed portal retirement"
status: Accepted
tags: [acceptance, portal, contribution-console]
---

This records an existing decision, not a new removal. Commit `0b7784b` records
the operator's instruction that the old :8084 portal is unused and must have no
remaining relationship to the product. It removed the page routes, renderers,
and their tests. Commit `48cebe6` moved the delivery queue to the backend and
removed `server.js` and its service. The contribution console lives in `mockup/`.

The backend project-board projection, privacy, grouping and resource-binding
requirements remain active. Four old project-board page acceptance scenarios
and REQ-PROJECT-BOARD-REFRESH are withdrawn with their subject: old page rendering,
old proxy routing, old refresh coalescing and old Monitor navigation. They must
not appear as either missing executable selectors or passing tests. Replacement
console acceptance remains governed by REQ-CONTRIBUTION-CONSOLE and ADR-013.

The September review initially counted these four obsolete selectors among its
13 unmatched selectors. The other nine select retained behavior and are rebound
to the tests that actually assert it. Historical review evidence is retained.
