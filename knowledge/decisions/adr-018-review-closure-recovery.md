---
kind: decision
id: ADR-018
title: "Durable contribution fulfillment and credential-last cleanup"
status: Accepted
tags: [engagements, matrix, recovery, review]
---

Implementation decision under the operator's September 5 instruction to close
the specification review findings. It implements ADR-016, the contribution
requirements and the project contract. It does not settle the conflicting
public-project-room versus private-DM execution-approval channel requirements.

An approved resource request reserves its allocation in the engagement ledger
before asynchronous provisioning. Its deterministic agent name, preset, side,
borrower binding and phase are durable. Retries use that plan. A partial setup
remains pending and holds its reservation; rejection releases it. An agent
whose setup never completed is excluded from reuse, including after rejection.
New-resource activation requires a home, Matrix identity, owner binding, joined
room and successful launch or eligibility for thread dispatch. Legacy existing
agent admission continues to return its explicit room-admission outcome.

Appservice identity work uses the side's acting credential. Registration-token
identity and membership work crosses a bridge-authenticated durable command
queue. The queue contains intent, lease and public result metadata; access
tokens remain in the bridge's canonical `bridge-state.json`, written atomically
at mode 0600. A credential is persisted before the queue acknowledges identity
creation. A lost acknowledgement can be retried after claim expiry without
registering another account. Claim tokens fence stale completion messages.

Matrix registration itself is not transactional with local storage. A process
crash after account creation but before credential persistence can require
homeserver administrator recovery. The durable identity command identifies the
agent, side and localpart; `GET /api/matrix-work` exposes its operator-only result,
including `M_USER_IN_USE`. It exposes neither registration/access tokens nor
claim tokens. The engagement stays pending. No derived-password fallback or
silent recreation is introduced. Unexpected returned identities retain their
credential for recovery but cannot activate the requested identity.

Side removal closes admission, waits for in-flight fulfillment and Matrix work,
withdraws known agent and representative memberships, revokes owned user access
tokens on registration-token sides, ends engagements, deactivates bindings and
retires identities before dropping the side credential. Appservice registration
credentials are issuer-managed; removing a side does not claim to revoke the
homeserver's installed appservice registration.

Transient failures retain the deactivated side for retry. A permanently missing
or mismatched bridge credential can be abandoned only through the operator-only
`force=true&abandon_unreachable=true` request. The response remains `partial` and
the removal audit records unswept memberships and token outcomes. This override
does not bypass an in-flight command or a transient Matrix HTTP failure.
Historical references to a deleted, unregistered agent are also reported as
partial; the fleet never masquerades as an identity absent from its roster.

The configured provider owner is a bootstrap fallback only while the requested
room has no configured project side. A configured side requires a room-scoped
borrower binding or an explicit owner in the operator's verdict. Existing private
approval controls continue to require that owner's exact MXID and approval room.

The cross-family rule gates offer disclosure, previews, automatic admission and
operator acceptance consistently. A one-family deployment cannot accept the
cross-family review role. This is a capacity condition; proof that agents actually
perform a complete author/reviewer/integration workflow remains an end-to-end gate.
