# Resource Agent definitions and explicit provider allocation

Historical implementation: the operator subsequently clarified that Palpo
projects define Agents. ADR-025 and
`2026-09-08-palpo-agent-definitions.md` supersede the provider definition UI
described below. Use the revised `docs/guides/resource-agents.zh.md` walkthrough.

The operator requested multiple resource configurations with multiple named
Agents under each resource. ADR-024 amends the previous resource-first console
decision while retaining approval-time provisioning and project ownership.

## Delivered behavior

- Definitions persist inside `framework-presets.json`, with stable definition
  IDs, unique runtime names, qualified roles and future-allocation availability.
  Creation writes no Agent home or Matrix identity. The resource supplies the
  model, reasoning and ceiling. Unused definitions can be edited/deleted through
  the API; the console provides definition creation, enable/disable and removal.
- Approval exposes eligible definitions and existing Agents. Explicit selection
  overrides automatic reuse only after qualification, side, owner and capacity
  checks. A new definition provisions its own named home and Matrix identity.
  Reservation and retry retain the choice; an active or interrupted assignment
  cannot be switched to another definition. Definitions share existing seat and
  project limits. Existing automatic allocation remains available.
- Definition names and resource catalogs are operator writes with narrow console
  proxy routes. Existing labels remain private until Publish resource in Palpo.
  Published roles expose only resource names, framework/model/reasoning and
  enabled Agent names/status. Palpo sanitizes these fields again. It continues
  to request a role, with the provider choosing the exact Agent at approval.
- Public catalog withdrawal and definition disable affect future availability.
  Existing approvals are retained. Provisioned/reserved names and runtime
  configurations cannot be changed underneath an assignment; resource ceilings
  can still be adjusted through the existing Resource API.

## Verification

105 related Vitest tests pass in 10 files. The updated console proxy suite also
passes its 11 tests after adding the exact definition/catalog/candidate routes
and cross-site, unauthenticated and adjacent-route refusals. Tests exercise real
backend provisioning against a localhost Matrix fixture, two named definitions
sharing capacity, failed-launch reservation/retry, foreign-side refusal and
public-field privacy. No real external model is invoked by those tests.

Controlled Playwright flows pass in English and Chinese: two definitions under
the medium resource, isolation from the strong resource, publication and explicit
selection of the second definition on approval. Eight existing resource-first
browser scenarios still pass. The Next production build, scoped ESLint and
architecture ownership checks pass. All 290 specification selectors resolve.
The native agent-spec lifecycle has four unsupported behavioral skips and is
**not passing**; Vitest evidence is recorded separately.

The companion Palpo source is `/Users/yuechen/home/palpo-admin-web/web-admin`.
Its 31 Node tests and both browser workflow suites pass, including fresh catalog
refresh, multiple named definitions, private-field removal, expired-connection
recovery and retained request identity.

Live Playwright verification created a temporary Resource, then used the actual
Hagency console proxy to save two Agent definitions and publish the Resource.
The actual Mini1 Palpo browser displayed both names and medium reasoning. The
test withdrew the catalog entry and removed only its own definitions/resource;
an independent before/after comparison confirms the original three Resources,
Agent roster and engagement allocations are unchanged. No second live project
request or resource approval was fabricated. Exact approval/provisioning is
covered by the backend and controlled-browser scenarios above.

Initial browser runs exposed overbroad accessible labels on the approval and
role selectors. Both controls now use explicit label associations, and the
regression selects each by its exact accessible label. Final screenshot review
also aligned the new Resource buttons with the existing button styling.

## Deployment and evidence

Backend18194 runs PID89234. The console remains at13202 with an isolated
`.next-resource-agents-v8` build. Bridge18195 retains its existing process and
device state. Mini1 Palpo web-admin image is `palpo-web-admin:318f47082b8092da`;
the Matrix server itself was not replaced. A consistent SQLite snapshot and
private JSON backups preceded the idle backend restart.

Private evidence lives in `palpo-admin-e2e/2026-09-06`: the
`resource-agent-deployment.json`, `resource-agent-palpo-deploy.log`,
`resource-agent-live-result.json`, `resource-agent-live-cleanup.json`,
`resource-agent-lifecycle.json`, the corresponding screenshots and verification
logs. The operator guide is `docs/guides/resource-agents.zh.md`.

At inspection, the project's1M allocation is fully committed to the first Agent.
An additional request needs additional project-side allocation; no budget was
silently increased. This change does not complete separate fleet-wide metering,
delegation or native-agent-spec release gates. No commit or push.
