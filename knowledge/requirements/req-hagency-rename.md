---
kind: requirement
id: REQ-HAGENCY-RENAME
title: Ship Hagency as a fresh product identity
status: Accepted
---

The operator requests a complete product rename to Hagency and explicitly states
that there are no users and no backward compatibility is required. Hagency is
the only supported product name, CLI entrypoint, environment prefix, home
directory, service identity, console API prefix and application protocol namespace.
Use `hagency`, `HAGENCY_*`, `.hagency`, `/api/hagency`, `com.hagency.*` and
`io.hagency.*`. Both ends must use the new protocol together. The operator
explicitly excludes the generic word `fleet` from this rename: retain fleet
identifiers (`hf_`), variable names and `/api/fleet` endpoints.

Do not introduce old-name aliases, config fallbacks, redirects or migrations.
Existing command functionality, Matrix authorization and default execution
policies remain enforced. Retain historical evidence and Git history as history;
do not rewrite system-provisioned root agent entry files or delete live data.
The companion Palpo web app and website must present the same product identity.

This requirement supersedes prior brand-preservation and migration requirements
only for the product rename. Transport choices and security boundaries are not
removed by a branding change. Validate a fresh installation with isolated data.
