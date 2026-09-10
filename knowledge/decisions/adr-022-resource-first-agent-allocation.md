---
kind: decision
id: ADR-022
title: "Provider console configures resources and provisions agents on approval"
status: Accepted
tags: [console, resource, agent, engagement]
---

## Context

The operator explicitly removed manual agent creation from the provider's product
workflow: configure resources, approve a borrower's request, let Hagency create or
select the agent, then manage its activity and allocation. The console still linked
to a separate creation wizard and described an empty roster as missing capacity,
contradicting ADR-019's existing provisionable-resource projection.

## Decision

Remove manual Create/Onboard Agent controls from the provider console. Keep the
old /onboard URL as a redirect to /resources so saved links enter the current
workflow. Resource configuration is the first section on that page; navigation
counts resource configurations independently of instantiated agents. Empty
agent and seat lists explain provisioning after approval and never require
pre-creating an agent. Both English and Chinese use this same workflow.

The Agent roster and detail controls continue to manage existing instances.
This presentation change does not remove backend provisioning, standalone CLI
operation, framework detection, approval gates or resource eligibility checks.
Existing agents are retained. Configuring a resource is not a claim that runtime
authentication, publication, quota or project admission has succeeded.

## Evidence

The task contract is specs/task-resource-first-console.spec.md. The separate
browser regression uses controlled localhost API fixtures; deployment verification
reads the operator's console without creating or approving a new request.
