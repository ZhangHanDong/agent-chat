# Palpo projects define Agents; Hagency approves resources

The operator clarified that Agent definitions belong on the Palpo project side.
ADR-025 supersedes the earlier provider-owned web definition implementation.

Hagency now configures and publishes Resources. Its web definition form and
definition mutation proxy routes are removed. Existing local records and backend
APIs remain compatible. Palpo's request form collects Agent name, role, resource
and quota. Each request card shows its own name, requested resource and status.
Multiple definitions can request one Resource without pre-creating local templates.

Published resources expose stable opaque IDs and safe model metadata, excluding
other projects' Agent definitions. The exact definition is part of the Matrix
source-event comparison and durable request fingerprint. Palpo requires Hagency
to acknowledge it; an older integration that drops the definition cannot silently
fulfill the wrong request. Retries retain the definition and source event.

Approval displays the project's definition and selected resource. It provisions
a distinct runtime identity and refuses substitution of an existing Agent.
Project/role/resource qualification, owner authority and capacity are checked at
commit. Publication withdrawal blocks fresh approval but preserves an interrupted
reservation for recovery. The reserved resource profile cannot be changed or
deleted during recovery. Project-scoped names permit independent projects to use
the same display label. Runtime names convert hyphens for the installed App
Service namespace and include a stable project/request suffix. Existing operation
approvals and default runtime permissions are unchanged.

## Verification

- 115 Vitest tests pass in 13 related files. Real backend provisioning uses a
  localhost Matrix fixture and a controlled launcher; two definitions create two
  distinct medium Agents despite an existing high Agent. Other cases cover source
  tampering, duplicate names, unpublished/private resources, foreign projects,
  owner authority changes, overcommit, interrupted launch and stable retry.
- Hagency Playwright passes both languages for publication, absence of the local
  definition form and exact project-definition approval. Eight prior Resource
  browser flows also pass. The deployed console repeats the two corrected flows
  with intercepted fixture requests, without changing real allocations.
- Palpo's 33 Node tests and both browser suites pass. Browser checks create two
  project definitions selecting the same Resource and preserve name/resource
  across connection expiry and retry. Role and Resource have explicit accessible
  names; actual browser inspection exposed the earlier nested-label ambiguity.
- Next production build, scoped ESLint, architecture ownership and all 294 spec
  selectors pass. Native agent-spec records four unsupported behavioral skips
  and is **not passing**; the deterministic Vitest results are separate evidence.

The live check publishes only a temporary Resource through the actual Hagency
console, selects it in the actual Mini1 Palpo form and confirms the provider
definition entry is absent. It does not submit an extra live project request or
approve capacity. Temporary publication/resource cleanup preserves the operator's
three Resources. Before/after restart checks also preserve both existing Agents,
engagement allocations and all 18 completed dispatches. Existing project-side
allocation is fully committed; the operator must increase it for another Agent.

## Deployment and evidence

Local backend18194 runs PID20010, bridge18195 PID20071, and console13202 PID20150
with `.next-resource-agents-v9`. The bridge restart loads the expanded request
protocol while retaining its existing Matrix credentials and device stores.
Consistent router SQLite and private JSON backups preceded the idle restart.
Mini1 runs `palpo-web-admin:5b0d9a4e5bc00b35`; the Matrix server is preserved.

Private evidence is under the existing `palpo-admin-e2e/2026-09-06` cache:
`palpo-definition-deployment.json`, `palpo-definition-palpo-deploy-layout.log`,
`palpo-definition-live-result.json`, `palpo-definition-live-cleanup.json`,
`palpo-definition-after-restart.json`, browser screenshots and the copied test
and native lifecycle logs. Initial failed browser/test attempts remain available.

The revised operator guide is `docs/guides/resource-agents.zh.md`. There is no
canonical task-writer in this source checkout. No task state was fabricated and
no commit or push was performed.
