# Palpo request visibility and expired connection recovery

The operator clicked Send agent request for `octos-code-use` but saw no HAFleet
engagement. Read-only inspection found no request for the provider session and no
engagement for this project. Project ownership and its private encrypted approval
channel were ready, and the configured HAFleet side had a one-million-token
allocation. Palpo's previous actual-event connection evidence had expired at
2026-09-07T22:46:07Z. Its request API rejects expired readiness before creating a
request or sending its source event. The original browser response was not
captured, so its exact HTTP response cannot be claimed from the later inspection.

The deployed form checked published roles but ignored fleet readiness. It still
enabled Send after expiry, and its generic failure notice appeared only at the
top of a long page. This explains why a failed submission could look unresponsive.

Updated the Palpo admin source at `/Users/yuechen/home/palpo-admin-web/web-admin`:

- Gate Send on project readiness, current connection expiry and role availability.
- Show connection recovery beside the request form, with a Verify connection
  action for the fleet owner or the responsible owner's MXID for other members.
- Reuse the existing owner-authenticated real-event verification. Preserve rooms,
  quotas, project/role selection and request ID; reconnection submits no request.
- Display sending, acknowledged delivery and failures beside the form. A failed
  submission retains its ID, and refreshing after failure cannot re-enable an
  unavailable Send button. An open page becomes blocked when evidence expires.
- Keep reconnection errors local to this form so a successful retry does not
  leave an obsolete error banner at the top of the page.

No backend authorization, Matrix server implementation or thirty-minute evidence
policy changed. Compared with the previously deployed snapshot, production
changes are limited to package.json and the three public web assets.

Validation: all 30 Node service/HTTP/workflow tests pass with no skips; syntax
checks, the existing controlled browser workflow and six new Playwright recovery
scenarios pass. These fixtures are not live Matrix acceptance. New coverage checks
owner/borrower recovery, failed reconnect, successful reconnect without room or
request duplication, a late server rejection, expiry without refresh and exactly
one manually pending request after explicit submission.

Live Mini1 Playwright observed the expired form, then used its new Verify
connection button. The first attempt retained `probe_pending`; retry observed
the exact pushed event and succeeded at 2026-09-07T22:56:35.610Z, valid until
23:26:35.610Z. The reception and project IDs and form fields stayed unchanged.
Send became enabled. Before/after request lists remained empty: the assistant
did not infer the operator's quotas, submit a replacement request or approve
resources. The operator's next action is to submit their original intended values
and check the inline delivery receipt, then approve in HAFleet Engagements.

Private evidence is under the existing `palpo-admin-e2e/2026-09-06` cache:
`request-readiness-live.json`, `request-readiness-live-expired.png`,
`request-readiness-live-recovered.png`, and the request-readiness deployment logs.
The isolated local HAFleet backend/bridge and the separate manual rig were not
restarted. Deployment replaces only the labelled Mini1 web-admin container and
retains its persistent data; browser sessions require a fresh login afterward.

Final deployed image: `palpo-web-admin:8c4becdb2b078719`, healthy. A fresh provider
browser verified the served app.js exactly matches local source, connection and
owner approval remain ready after the update, Send is enabled, and there is no
new request. Final receipt/screenshot: `request-readiness-final-deployed.json/png`.
