spec: task
name: "Fresh Hagency product identity"
inherits: project
satisfies: [REQ-HAGENCY-RENAME]
tags: [active, cli, matrix, branding]
---

## Intent

Rename the complete product and its Palpo integration without old-name aliases.

## Constraints

- Preserve sandbox defaults and exact Matrix identity checks.
- Use isolated test data and preserve concurrent work and historical evidence.
- Test native Node scenarios through Vitest separately from agent-spec lifecycle.

## Boundaries

### Allowed Changes
- bin/**
- lib/**
- router/**
- mockup/**
- remote/**
- scripts/**
- services/**
- install/**
- deploy/**
- src/**
- schemas/**
- skills/**
- tests/**
- specs/**
- knowledge/**
- docs/**
- .github/**
- *.js
- *.sh
- *.service
- *.plist
- ./.env.example
- ./.gitignore
- ./package.json
- ./package-lock.json
- README.md
- README.zh-CN.md
- OPERATIONS.md
- ROADMAP-remote.md
- CHANGELOG.md
- ./NOTICE

### Forbidden
- Root agent entry files, live configuration and unrelated concurrent changes.
- Old-brand aliases, redirects and credential migration fallbacks.

## Acceptance Criteria

Scenario: Fresh command and configuration identity
  Test: Hagency starts from its own command and home without old-name fallback
  Given a fresh installation with an obsolete environment variable present
  When its command help and default home are resolved
  Then only Hagency commands and configuration are used

Scenario: Fleet identity stays independent of branding
  Test: Hagency imports Palpo fleet credentials without changing fleet identifiers
  Given a fresh Palpo fleet configuration
  When the configuration is imported and its representative is resolved
  Then its fleet ID and fleet endpoint remain unchanged

Scenario: Product namespace remains consistent
  Test: Hagency uses one namespace across console routes and Matrix protocol
  Given the installed console and bridge
  When the API route and Matrix event types are inspected
  Then all use the Hagency namespace without an obsolete route
