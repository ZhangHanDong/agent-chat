spec: task
name: "Make missing project ownership explicit before approval"
inherits: project
satisfies: [REQ-CONTRIBUTION-CONSOLE, REQ-OWNER-UI-APPROVAL, ADR-019]
tags: [active, console, approvals]
---

## Intent

Prevent first-project approvals from submitting empty owner fields and repeatedly
failing with owner_unavailable. Preserve the authoritative room binding and the
operator's explicit choice of owner and private approval room.

## Constraints

### Must
- Derive owner setup readiness from the backend's current project-scoped binding.
- Show missing owner fields as required before submitting an approval.
- Recover visibly when ownership is revoked after the form was loaded.
- Preserve existing binding reuse and runtime approval authority.

### Must Not
- Do not infer project ownership from the requester or borrow another project's binding.
- Do not bypass backend checks or replace server credentials to repair project ownership.
- Do not contact live services in deterministic fixtures.

## Boundaries

### Allowed Changes
- backend-v2.js
- mockup/app/engagements/page.jsx
- mockup/lib/console-workflow.js
- mockup/lib/api.js
- mockup/lib/i18n.js
- tests/console-live-ux.test.js
- tests/engagement-binding.test.js
- specs/task-first-project-owner.spec.md
- docs/**

### Forbidden
- Credentials, root workspace instructions, direct runtime-state edits and unrelated deployments.

## Acceptance Criteria

Scenario: The approval queue identifies missing ownership for this project
  Test: pending approval owner readiness follows only the current project binding
  Given an unbound project and an unrelated project's owner binding
  When the operator reads the pending approval queue before and after binding changes
  Then only a current binding for the requested project makes owner setup optional

Scenario: First approval cannot silently omit ownership
  Test: console blocks empty first-owner approval while preserving existing binding reuse
  Given a pending request whose backend requires explicit owner setup
  When the operator leaves both ownership fields empty
  Then no approval payload is produced until a complete explicit private binding is entered

Scenario: A stale owner binding is reported as actionable setup
  Test: console writes retain the owner-unavailable error code for form recovery
  Given an owner binding disappears after the form was read
  When the backend rejects the approval with owner_unavailable
  Then the console receives the structured error code to reopen required owner setup

## Out of Scope

- Automatic approval, new server credentials, customer CRM and Matrix room creation.
