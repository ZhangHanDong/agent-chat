---
kind: decision
id: ADR-024
title: "Multiple Agent definitions per resource and explicit provider allocation"
status: Accepted
tags: [resources, agents, console, engagement]
---

The provider-owned web definition workflow below is superseded by ADR-025 after
the operator clarified that projects define Agents on Palpo. Retain this decision
as implementation history and compatibility context for existing local records.

The operator now requests multiple resources, each containing multiple named
Agent definitions. This amends ADR-022: keep creation within Resource management,
with no independent onboarding wizard. Defining an Agent saves its name and role;
its resource supplies model, reasoning and ceiling. Approval provisions its home
and Matrix identity only when needed. Definitions are not running processes or
additional subscription capacity.

Provider approval can select a defined Agent or an eligible existing Agent.
Selection must survive reservation, retries and restart and cannot change an
already reserved or active assignment. Verify role qualification, existing
identity ownership, project-side scope, owner authority and capacity again at
commit. Never silently substitute a stronger existing Agent for an explicit
definition. Existing automatic allocation remains for clients without a choice.

Palpo displays published roles and their resource/Agent configurations. Projects
continue to request a role; the provider makes the allocation decision. Public
catalogs disclose names and model metadata only after the provider explicitly
publishes the resource. Existing resource labels remain private by default.
Catalogs never disclose internal preset identifiers,
credentials, paths, seat records or private owner rooms. Multiple definitions
share the existing seat and project allocation checks. Editing or removing a
definition that has been instantiated or reserved must be refused; disabling
future availability does not revoke existing work.

Validate local API persistence and authorization, multiple definitions, explicit
second-Agent provisioning, conflicting retry, shared budgets, both web workflows,
and the existing Matrix room/approval boundaries. Live acceptance is recorded
separately from deterministic tests.
