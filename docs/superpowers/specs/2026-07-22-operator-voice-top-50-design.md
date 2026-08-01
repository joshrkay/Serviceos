# Operator voice Top-50 completion design

## Objective
Make every operator voice corpus workflow produce its valid, tenant-scoped
outcome through the authenticated Development application: a reviewable
proposal when the command is a mutation, a typed read-only result when
applicable, or durable on-call callback/appointment evidence for emergency
dispatch. Every proposal remains human-approved before execution.

## Scope
This design covers the existing 50-case corpus and its 27 known non-pass
cases. It includes classifier observability and context, resolver-compatible
QA fixtures, tenant alias learning, document/appointment/technician
resolution, emergency scoring, and authenticated acceptance evidence.

It does not auto-execute proposals, use fixture data as canonical authority
outside the explicit QA tenant, or treat generic model text as success.

## Architecture
The acceptance harness is the source of failure classification. It records the
first turn, sends confirmation only when the state machine requests it, and
checks the persisted proposal or emergency side effect through tenant-scoped
API/repository reads.

An explicit QA fixture runner creates only the corpus entities in the QA
tenant using production domain/repository paths. It is idempotent through
stable provenance keys and records audits for every canonical write. Fixtures
contain the needed customer, lead, document, appointment, and technician
references but never seed entities whose creation is being tested.

The resolver checks active owner-approved aliases before fuzzy matching, then
validates tenant, entity lifecycle, and intent compatibility. When candidates
are ambiguous or unavailable, it produces a typed one-tap clarification rather
than escalating or guessing. Manual correction becomes an auditable candidate;
owner approval activates the tenant alias and revocation removes it from
matching.

The classifier receives authorized, bounded operator context and emits typed
outcomes that preserve provider, quota, deadline, and parse failures instead
of flattening them into low confidence. Resolver hints never establish
canonical identity or prices.

## Data and safety controls
- All generated records, aliases, proposals, reads, and audit events are
  tenant-scoped and RLS-tested.
- Fixture writes are Development QA-tenant-only, idempotent, provenance-tagged,
  and audited; reruns create no duplicates.
- All LLM calls remain behind the gateway. Proposals use typed Zod contracts,
  catalog resolution, and the existing human-approval gate.
- Emergency dispatch is never converted into a standard proposal merely to
  satisfy the scorer.
- Raw voice text, audit payloads, and draft proposals are never injected into
  classifier context; only bounded, allowlisted labels/IDs and approved aliases
  may be used.

## Delivery sequence
1. Make the acceptance harness distinguish provider, classifier, resolver,
   confirmation, proposal persistence, and emergency side effects.
2. Build and real-Postgres-test the audited QA fixture catalog for Khan,
   Johnson, Mrs Lee, Smith, Garcia, appointments, invoices, estimates, Carlos,
   and the Greenfield lead.
3. Add alias-first resolution and the corrected/approved/revoked alias learning
   flow, then add safe document, appointment, technician, shorthand, and
   read-only resolution.
4. Add bounded classifier context and explicit infrastructure outcomes for the
   eight reprompt cases.
5. Execute the authenticated 50-case run, API persistence checks, proposal
   approval checks, audit verification, cross-tenant denial checks, and a
   browser recording of the command-to-approved-domain-record flow.

## Verification
Unit tests cover each pure classifier, alias, and scoring decision. Resolver,
fixture, audit, and tenant-isolation work receives Docker-gated PostgreSQL
integration coverage. The live acceptance artifact lists all 50 workflow IDs,
their command/confirmation behavior, persisted proposal or emergency record,
post-approval domain result, audit actor/action/tenant evidence, and
cross-tenant denial result. Browser validation uses the authenticated QA
operator session and records the proposal card, approval, saved record, and
inbox/audit evidence.
