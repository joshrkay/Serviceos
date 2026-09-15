# §8.4 Dispatch — product fixes (ticket #1017)

Branch `fix/8-4-proposal-audit-and-skills`, cut from `origin/main` (`d81220455`).

Two bounded product fixes. Neither touches pricing, money, RLS or auth.

- **Fix 1 — issue #1040:** the drag→proposal path wrote a `proposals` row with
  no `proposal.created` audit event. Now it emits one through the audit
  repository the router is already wired with, and the lane's
  `it.skip('[BLOCKED — no product-code audit call exists yet] …')` is
  un-skipped.
- **Fix 2 — 4.9 / issue #1001 ("fix the lie"):** the nine-line
  `StubSkillMatcher` returns `[]`, which `checkFeasibility` turned into an
  empty issue list — indistinguishable from "skills were checked and matched".
  The feasibility outcome now names the reason explicitly
  (`skillConstraints: 'none_configured' | 'evaluated' | 'not_evaluated'`) and
  the dispatch creation path persists that outcome on the `proposal.created`
  audit row. **No skills-based assignment was built** (out of scope per
  #1001).

---

## What changed

| File | Change |
|---|---|
| `packages/api/src/proposals/create-scheduling.ts` | Optional `auditRepo` 5th param; emits `proposal.created` after the proposal row lands; carries the feasibility check's `skillConstraints` onto the event. Input gains optional `actorRole` + `correlationId`. |
| `packages/api/src/routes/proposals.ts` | The bare `POST /` handler now passes `auditRepo`, `req.auth!.role`, and the request's `x-correlation-id` (when present) into `createSchedulingProposal`. |
| `packages/api/src/scheduling/feasibility-types.ts` | New `SkillConstraintStatus` type; `FeasibilityResult.skillConstraints` (non-optional — silence is the bug). |
| `packages/api/src/scheduling/feasibility.ts` | `skillMatchIssues` returns `{ issues, constraints }`; `partition` takes and returns the status; the no-technician early return reports `not_evaluated`. |
| `packages/api/src/scheduling/skill-matcher.ts` | Doc only: `[]` is a real answer ("no skill constraints configured"), and assignment stays out of scope. |
| `packages/web/src/components/dispatch/feasibility-types.ts` | Mirror type gains the optional `skillConstraints` field. |
| `packages/api/test/integration/dispatch-drag-proposal.test.ts` | Audit assertion un-skipped + strengthened (actor, role, correlation id, metadata); two new legs for the skill-constraint outcome incl. a tenant-B-drags-its-own-board T1. |
| `packages/api/test/scheduling/feasibility-skill.test.ts` | Five new unit pins incl. a T2 (two tenants, divergent skill models). |
| `packages/api/test/scheduling/skill-matcher.test.ts` | Doc header pointing at where `[]`'s meaning is pinned. |

### Audit event shape (mirrors the existing `proposal.created` emitters)

`telephony/twilio-adapter.ts:3024` and `ai/voice-turn/create-voice-turn-processor.ts:4117`
already emit `proposal.created` with `createAuditEvent` — entityType
`proposal`, the created row's id, a correlation id, and metadata naming the
`proposalType` and the `source` surface. The dispatch path uses the same
shape, with `source: 'dispatch'` and the drag's own fields:

```
eventType   proposal.created
entityType  proposal
entityId    <created proposal id>
actorId     <the dragging user>        actorRole  <their role>
correlationId  <x-correlation-id, else minted>
metadata    { proposalType, status, source: 'dispatch', appointmentId,
              proposedScheduledStart, proposedScheduledEnd, skillConstraints }
```

Wiring verified, not assumed: `packages/api/src/app.ts:5654` passes `auditRepo`
into `createProposalsRouter`; `app.ts:1175` makes that `webhookAuditRepo` =
`new ForwardingAuditRepository(pool ? new PgAuditRepository(pool) : new InMemoryAuditRepository())`
(`app.ts:1000`). So with `DATABASE_URL` set the row goes to Postgres. The
wiring was **not** the bug — the create path simply never called it.

The audit write is **not** swallowed. The voice adapters wrap theirs in
try/catch because they run mid-call; this is a synchronous operator request,
and `proposals/actions.ts` lets an audit failure surface on approve / reject /
edit / undo. Creation is not made the quiet exception.

---

## Evidence

Real Postgres, plain container (no mocked Pool, no in-memory repos), driving
the SAME HTTP route the dispatch board's drag handler POSTs to.

### RED — unit pin for 4.9 / #1001, against unchanged product code

```
$ cd packages/api && npx vitest run test/scheduling/feasibility-skill.test.ts --reporter=verbose
 ✓ checkFeasibility — skill match sub-check > produces no issue when StubSkillMatcher is wired (required=[])
 ✓ checkFeasibility — skill match sub-check > blocks when the technician is missing a required skill
 × … > reports skillConstraints: 'none_configured' when the job models no required skills
   → expected undefined to be 'none_configured' // Object.is equality
 × … > reports skillConstraints: 'evaluated' when required skills exist and the technician holds them
   → expected undefined to be 'evaluated' // Object.is equality
 × … > reports skillConstraints: 'evaluated' when a required skill is missing (the blocking case)
   → expected undefined to be 'evaluated' // Object.is equality
 × … > reports skillConstraints: 'not_evaluated' when there is no technician to check (the gate never ran)
   → expected undefined to be 'not_evaluated' // Object.is equality
 × … > T2 — a second tenant with a DIFFERENT skill model gets its own outcome, not tenant A's
   → expected undefined to be 'none_configured' // Object.is equality

 Test Files  1 failed (1)
      Tests  5 failed | 4 passed (9)
```

`undefined` is exactly the lie: the outcome carried no statement about skills
at all.

### RED — integration, at real Postgres, against unchanged product code

```
$ cd packages/api && RLS_RUNTIME_ROLE=true \
    EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32775/serviceos_test \
    npx vitest run --config vitest.integration.config.ts --reporter=verbose \
    test/integration/dispatch-drag-proposal.test.ts

 ✓ … > a reschedule drag creates a real proposal row and mutates NO appointment column 58ms
 ✓ … > T1 — tenant B never sees tenant A's proposal, and tenant B's own appointment is untouched 32ms
 × … > emits a proposal.created audit event, readable via PgAuditRepository.findByEntity 30ms
   → expected false to be true // Object.is equality
 × … > persists the explicit skill-constraint outcome (none_configured) on the audit row — 4.9 / #1001 3ms
   → expected undefined to be defined
 × … > T1 — tenant B's own drag writes its OWN skill-constraint record; neither tenant can read the other's 18ms
   → expected undefined to be defined

 Test Files  1 failed (1)
      Tests  3 failed | 2 passed (5)
```

`expect(events.some((e) => e.eventType === 'proposal.created')).toBe(true)` →
`false`: `findByEntity` returned nothing at all for the created proposal.

### GREEN — unit

```
$ cd packages/api && npx vitest run test/scheduling/feasibility-skill.test.ts \
    test/scheduling/skill-matcher.test.ts test/scheduling/feasibility-overlap.test.ts \
    test/scheduling/feasibility-availability.test.ts test/scheduling/feasibility-travel-time.test.ts --reporter=verbose
 Test Files  5 passed (5)
      Tests  26 passed (26)

$ cd packages/api && npx vitest run test/scheduling test/audit
 Test Files  21 passed (21)
      Tests  115 passed (115)

$ cd packages/api && npx vitest run test/proposals test/routes/proposals.route.test.ts \
    test/routes/proposals-inbox.route.test.ts test/routes/proposals-approve-batch.route.test.ts \
    test/routes/proposals-approve-undo-window.route.test.ts test/audit/audit-coverage-d2-1c.test.ts
 Test Files  122 passed (122)
      Tests  1926 passed (1926)

$ cd packages/web && npx vitest run src/components/dispatch
 Test Files  15 passed (15)
      Tests  109 passed (109)
```

### GREEN — integration, at real Postgres

```
$ cd packages/api && RLS_RUNTIME_ROLE=true \
    EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32777/serviceos_test \
    npx vitest run --config vitest.integration.config.ts --reporter=verbose \
    test/integration/dispatch-drag-proposal.test.ts

 ✓ … > a reschedule drag creates a real proposal row and mutates NO appointment column 53ms
 ✓ … > T1 — tenant B never sees tenant A's proposal, and tenant B's own appointment is untouched 23ms
 ✓ … > emits a proposal.created audit event, readable via PgAuditRepository.findByEntity 20ms
 ✓ … > persists the explicit skill-constraint outcome (none_configured) on the audit row — 4.9 / #1001 2ms
 ✓ … > T1 — tenant B's own drag writes its OWN skill-constraint record; neither tenant can read the other's 21ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

Every other proposal integration file, and every feasibility / dispatch
integration file, on a clean container:

```
$ … npx vitest run --config vitest.integration.config.ts --reporter=dot \
    test/integration/correction-repetition-meta-proposal.test.ts \
    test/integration/pg-proposal-execution-find-by-key.test.ts \
    test/integration/pg-proposal-update-status-if.test.ts \
    test/integration/proposal-approval-system-actor.test.ts \
    test/integration/proposal-expiry-sweep-3-11.test.ts \
    test/integration/proposal-sms-events.test.ts \
    test/integration/record-payment-refund-proposal-flow.test.ts \
    test/integration/voice-proposal-ai-run-fk.test.ts \
    test/integration/voice-proposal-ai-run-link.test.ts
 Test Files  9 passed (9)
      Tests  45 passed | 1 expected fail (46)

$ … test/integration/feasibility-no-technician.test.ts \
    test/integration/place-hold-feasibility-gap.integration.test.ts \
    test/integration/dispatch.test.ts test/integration/dispatch-availability.test.ts \
    test/integration/dispatch-availability-stale-defaults.integration.test.ts \
    test/integration/dispatch-technician-day-window.test.ts \
    test/integration/reschedule-appointment-voice.test.ts \
    test/integration/emergency-dispatch-hold.test.ts
 Test Files  8 passed (8)
      Tests  18 passed | 1 expected fail (19)
```

### Row dump from the kept container (the rows the product wrote)

```
$ docker exec <pg> psql -U test -d serviceos_test -x -c \
  "SELECT id, tenant_id, actor_id, actor_role, event_type, entity_type, entity_id,
          correlation_id, metadata, created_at
     FROM audit_events WHERE event_type = 'proposal.created' ORDER BY created_at;"

-[ RECORD 1 ]--+-------------------------------------------------------------
id             | 9771ef87-54f5-4a20-a78e-693537eed707
tenant_id      | cfbee537-d944-4574-9323-083dd6647056
actor_id       | 0f034f45-f95e-4f1f-bf36-f850a40261b9
actor_role     | dispatcher
event_type     | proposal.created
entity_type    | proposal
entity_id      | 87da91b1-9f80-409f-8699-e27800b90667
correlation_id | 1e19e026-0099-4181-bc25-56d1308339cd
metadata       | {"source": "dispatch", "status": "draft", "proposalType": "reschedule_appointment", "appointmentId": "d9100417-76d9-42ea-b54f-878017f09c24", "skillConstraints": "none_configured", "proposedScheduledEnd": "2026-08-10T20:00:00.000Z", "proposedScheduledStart": "2026-08-10T19:00:00.000Z"}
created_at     | 2026-09-13 05:22:59.348+00
-[ RECORD 2 ]--+-------------------------------------------------------------
id             | 78f92175-f1bc-4c20-8bef-f23f1f3423b2
tenant_id      | cfbee537-d944-4574-9323-083dd6647056
…
entity_id      | 91746aa7-5982-4473-bfd2-f229ab37f6b8
correlation_id | 63503594-7933-418e-8b31-78851c4abe1a
metadata       | {"source": "dispatch", "status": "draft", "proposalType": "reschedule_appointment", "appointmentId": "d9100417-76d9-42ea-b54f-878017f09c24", "skillConstraints": "none_configured", "proposedScheduledEnd": "2026-08-10T22:00:00.000Z", "proposedScheduledStart": "2026-08-10T21:00:00.000Z"}
-[ RECORD 3 ]--+-------------------------------------------------------------
id             | ff5ae55b-1eb1-4028-bcff-a8ab711f0b3e
tenant_id      | cfbee537-d944-4574-9323-083dd6647056
…
entity_id      | 9ae967c8-7062-4ef8-95e4-c2fbd318bbc8
correlation_id | e545ac58-deb5-40f8-a6ae-2affc9c70496
metadata       | {"source": "dispatch", "status": "draft", "proposalType": "reschedule_appointment", "appointmentId": "d9100417-76d9-42ea-b54f-878017f09c24", "skillConstraints": "none_configured", "proposedScheduledEnd": "2026-08-11T00:00:00.000Z", "proposedScheduledStart": "2026-08-10T23:00:00.000Z"}
-[ RECORD 4 ]--+-------------------------------------------------------------   ← TENANT B
id             | 1489753a-7997-43e4-9eec-19c513ba0fae
tenant_id      | 44d2c9a3-f0bd-4d31-9c64-e4eede0b9b07
actor_id       | 1b9db015-6dd3-4098-9a42-cc9c8082b34d
actor_role     | dispatcher
entity_id      | 7c1562f4-c390-479d-85f9-8fb0eee0d245
correlation_id | f4386798-9b30-47ff-87ec-78beb743d666
metadata       | {"source": "dispatch", "status": "draft", "proposalType": "reschedule_appointment", "appointmentId": "2a2b6d10-19bb-494d-a3c5-89584043e7a9", "skillConstraints": "none_configured", "proposedScheduledEnd": "2026-08-11T02:00:00.000Z", "proposedScheduledStart": "2026-08-11T01:00:00.000Z"}
```

Two distinct tenants, each row naming its OWN actor and its OWN appointment.

Proposals and appointments in the same container — four drafts, and **not one
appointment column moved** (`updated_at` is still the seeded `14:00`, and the
scheduled times are still the seeded `15:00–16:00`, not any of the proposed
windows):

```
$ docker exec <pg> psql -U test -d serviceos_test -c \
  "SELECT id, tenant_id, proposal_type, status, created_by FROM proposals ORDER BY created_at;"
 87da91b1-… | cfbee537-… | reschedule_appointment | draft | 0f034f45-…
 91746aa7-… | cfbee537-… | reschedule_appointment | draft | 0f034f45-…
 9ae967c8-… | cfbee537-… | reschedule_appointment | draft | 0f034f45-…
 7c1562f4-… | 44d2c9a3-… | reschedule_appointment | draft | 1b9db015-…
(4 rows)

$ docker exec <pg> psql -U test -d serviceos_test -c \
  "SELECT id, tenant_id, status, scheduled_start, scheduled_end, updated_at FROM appointments ORDER BY tenant_id;"
 2a2b6d10-… | 44d2c9a3-… | scheduled | 2026-08-10 15:00:00+00 | 2026-08-10 16:00:00+00 | 2026-08-10 14:00:00+00
 d9100417-… | cfbee537-… | scheduled | 2026-08-10 15:00:00+00 | 2026-08-10 16:00:00+00 | 2026-08-10 14:00:00+00
(2 rows)
```

### Typecheck

```
$ cd packages/api && npx tsc --project tsconfig.build.json --noEmit 2>&1 \
    | grep -E 'scheduling/feasibility|scheduling/skill-matcher|proposals/create-scheduling|routes/proposals'
(no output — zero errors in any file this branch touches)
```

Pre-existing, unrelated noise in this unbuilt worktree (present before this
branch, in files it does not touch): every `src/**` file importing `uuid`
reports `TS7016` (no `@types/uuid` resolvable from here), and
`src/routes/assistant.ts` reports four `TS2305`s against
`@ai-service-os/shared` because `node_modules/@ai-service-os/shared` symlinks
to the MAIN checkout's `packages/shared`, whose `dist/` predates those
exports. Same cause for the three `TS2305`s in `packages/web`
(`InboxPage.tsx`, `AIProposalCard.tsx` — untouched files). The root
`npx tsc --noEmit -p tsconfig.json` is dominated by 3,254 `TS6305`
("output file has not been built from source file") for the whole repo — a
project-references artifact of a worktree with no build, not a type error, and
it names every file including ones this branch never touched.

---

## Tenant grades

- **T1** (both fixes): tenant A's proposal and its audit row are invisible
  under tenant B (`proposalRepo.findById` → `null`, `findByTenant` → `[]`,
  `auditRepo.findByEntity` → `[]` in both directions), and tenant B drags on
  its OWN seeded board — divergent data, not an empty tenant.
- **T2** (fix 2, unit): two tenants with DIFFERENT skill models through the
  same matcher — `t-1` models nothing (`none_configured`, feasible), `t-2`
  models `gas_fitting` its tech lacks (`evaluated`, infeasible).

## What is NOT proven

- **No browser leg.** Nothing here drives the real dispatch board in
  Chromium; the integration tests drive the same HTTP route the drag handler
  POSTs to (`packages/web/src/components/dispatch/useCreateScheduleProposal.ts`),
  not the drag gesture itself. The e2e spec
  `e2e/journeys/dispatch-drag-proposal.spec.ts` is deliberately untouched
  (another lane owns e2e) and still does not assert the audit row.
- **No production evidence.** Nothing was proven against Railway.
- **`skillConstraints` is not surfaced in any UI.** The API returns it on
  `POST /api/dispatch/check-feasibility` and on the `422 INFEASIBLE` body
  (both already spread the whole `FeasibilityResult`), and the web mirror type
  declares it — but no dispatch component renders it. A dispatcher reading the
  screen still cannot see "no skill constraints configured"; only the audit
  trail and the API response carry it.
- **Skills-based assignment does not exist** and was not built. `4.9`'s story
  ("closest certified tech assigned automatically") remains unbuilt by
  decision; only the silent-lie half was fixed.
- **No migration.** The skill-constraint outcome is persisted on the
  `proposal.created` audit row (`audit_events.metadata`), not as a column on
  any proposal/feasibility table. There is no dedicated feasibility record in
  the schema to hang it on, and #1001's instruction was to stop short of a
  migration. If a queryable column is wanted later, that is a schema change
  Fable decides on.
- **Audit failure behaviour is untested.** The write is deliberately not
  swallowed (an audit-store failure will fail the request after the proposal
  row has landed, matching `proposals/actions.ts`), but no test exercises a
  broken audit store on this path.
- **Only the dispatch creation path is audited.** Other proposal-creation
  surfaces outside `createSchedulingProposal` were not touched.
