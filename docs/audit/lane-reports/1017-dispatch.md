# §8.4 Dispatch — Sonnet lane report (#1017)

Branch: `cloud/dispatch-8-4` off `origin/main` (d869cea). Scope: TEST-ONLY,
Sonnet-class rows only. No files under `packages/api/src` or
`packages/web/src` were touched. Nothing here claims a rung — only Fable
states a new rung per the map's rules.

Docker was available throughout; each touched integration file was run
individually via `RLS_RUNTIME_ROLE=true npx vitest run --config
vitest.integration.config.ts --reporter=verbose <file>` against a
testcontainer, with `docker ps --filter ancestor=pgvector/pgvector:pg16 -q |
xargs -r docker rm -f` after each run. A final pass re-ran all four touched
files against one kept, external Postgres container per the evidence
protocol (raw dumps at the bottom).

---

## Row 4.2 — drag → proposal, no appointment mutation until approval

**File:** `packages/api/test/integration/dispatch-drag-proposal.test.ts` (new)

**Command:** `cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run
--config vitest.integration.config.ts --reporter=verbose
test/integration/dispatch-drag-proposal.test.ts`

Drives the ACTUAL path the dispatch board's drag handler
(`packages/web/src/components/dispatch/useCreateScheduleProposal.ts`) uses:
`POST /api/proposals` → `routes/proposals.ts`'s bare `POST /` handler →
`createSchedulingProposal` (`src/proposals/create-scheduling.ts`) →
`PgProposalRepository.create`. Real Postgres throughout — proposal repo,
appointment repo, assignment repo, working-hours repo, unavailable-block
repo; `HaversineFallbackProvider`/`StubSkillMatcher` stand in only for the
travel-time/skill signals feasibility also consults, which this row isn't
about.

**RED (assertion validity check, two deliberately-wrong expectations):**
```
× a reschedule drag creates a real proposal row and mutates NO appointment column
  → expected 'scheduled' to be 'canceled'
× T1 — tenant B never sees tenant A's proposal...
  → expected [] to have a length of 1 but got +0
```

**GREEN (corrected):**
```
✓ a reschedule drag creates a real proposal row and mutates NO appointment column  68ms
✓ T1 — tenant B never sees tenant A's proposal, and tenant B's own appointment is untouched  33ms
```

**Evidence class:** real Postgres, both legs attempted (see gap below for
why the audit leg is not GREEN).

**Tenant grade:** T1. `grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants"` → 6 matches (tenantB fixture, seed, cross-tenant read, `findByTenant` check).

**Gap surfaced, not invented around:** the row also asks for "the audit
event read back through `PgAuditRepository.findByEntity`". Reading
`routes/proposals.ts`'s bare `POST /` handler and `create-scheduling.ts`
line by line: neither calls `auditRepo.create` or `logProposalEvent`
(`src/proposals/audit.ts`) on this path, and `PgProposalRepository.create`
is a bare `INSERT ... RETURNING *` with no audit side effect. Grepping
every call site of `logProposalEvent` in `src/` turns up exactly two
(`proposals/actions.ts:332` approve, `:541` undo) — never create. Contrast
with the voice `create_customer` path (`telephony/twilio-adapter.ts:3019-3041`),
which DOES emit `proposal.created` at its own call site — the drag/HTTP
path simply never got the same treatment.

This is captured as a **RED test, then skipped** (not deleted, not forced
green) so a future lane can un-skip it once the audit call lands:
```
× [BLOCKED — no product-code audit call exists yet] emits a proposal.created
  audit event, readable via PgAuditRepository.findByEntity
  → expected false to be true
```
**Judgment call:** did not add the missing `auditRepo.create` call — that is
one line in `create-scheduling.ts` or the route handler, but it is
product code, explicitly out of scope for this lane ("Do NOT touch product
code"). Flagging for the Opus/product lane or a follow-up ticket.

**Row verdict:** **3 → 3+ (partial)** — drag→proposal and no-mutation-until-
approval are proven GREEN at T1; the audit-readback quarter of the
criterion is a confirmed, documented gap in product code, not a test gap.

---

## Row 4.3 — concurrent-drag presence

**No new test written** (per the routing note: "if it is in-process/in-memory
only, write NO fake DB test — report honestly").

**File:line evidence that presence is NEVER Postgres:**
- `packages/api/src/dispatch/presence-store.ts:66` — `InMemoryDispatchPresenceStore`, a process-local `Map`.
- `packages/api/src/dispatch/redis-presence-store.ts:53` — `RedisDispatchPresenceStore`, a Redis `HASH` (`dispatch:presence:<tenant>:<date>`).
- `packages/api/src/dispatch/presence-store.ts:137-149` — `createDispatchPresenceStore` selects between ONLY those two by `REDIS_URL`; there is no third, Postgres-backed implementation.
- `grep -n "presence" packages/api/src/db/schema.ts` → **zero matches**. No migration, no table.

This confirms #1008's grading note exactly: "4.3's ceiling is 3 while
presence is Redis/in-memory." A DB-backed integration test for this row
would have to assert against a table that does not exist — the honest
report is that this stays where it is.

**Row verdict: stays 3.** Not moved, and the reason is architectural (presence
is intentionally ephemeral/advisory state, never persisted), not a testing
gap this lane can close.

---

## Row 4.5 — "on my way" parity (tap / speak / text)

**File:** `packages/api/test/integration/en-route-sms-keyword.test.ts` (new)

**Command:** `cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run
--config vitest.integration.config.ts --reporter=verbose
test/integration/en-route-sms-keyword.test.ts`

`test/integration/en-route-voice.test.ts` already proves the voice, phone
(Gather), and chat legs at real Postgres. `test/sms/tech-status/en-route-
keyword.test.ts` proves the SMS-keyword handler's own logic but only against
in-memory repos and a mocked `enRouteCoordinator` — the Docker gap #1008
named ("the SMS-keyword leg is the Docker gap"). This file drives
`dispatchInboundSms` with the real `registerEnRouteSmsKeyword` handler
(exactly as `app.ts` wires it) against real Postgres.

**RED (two deliberately-wrong expectations):**
```
× ...fires the SAME audited act + delay_notice_state row...
  → expected 'queued' to be 'sent'
× T1 — a second tenant's tech texting OMW never touches the first tenant's rows
  → expected [] to have a length of 1 but got +0
```

**GREEN (corrected):**
```
✓ a registered tech texting OMW fires the SAME audited act + delay_notice_state row as the app button/voice/chat legs  109ms
✓ T1 — a second tenant's tech texting OMW never touches the first tenant's rows  84ms
```

**Evidence class:** real Postgres, both legs (audit event AND
`delay_notice_state` row) — parity with the voice/phone/chat legs already
proven in `en-route-voice.test.ts`.

**Tenant grade:** T1. 2 tenant fixtures seeded independently; cross-tenant
read + untouched-rows assertions both present.

**Row verdict: → 4** (the SMS-keyword leg now has the same real-Postgres
proof the other three legs already had; #1008 confirmed 4/3 at T1 overall
with the SMS-keyword leg named as the remaining Docker gap — that gap is
now closed).

---

## Row 4.6 — "running late" in one tap

**File:** `packages/api/test/integration/running-late.test.ts` (new)

**Command:** `cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run
--config vitest.integration.config.ts --reporter=verbose
test/integration/running-late.test.ts`

`test/routes/appointments.running-late.test.ts` pins the route's
permission/validation logic but entirely against in-memory repos and a
`vi.fn()` stand-in for `DelayNotificationCoordinator` — never opens a pool,
never proves what lands in `delay_notice_state`. This file drives the same
route (`POST /:id/running-late`) with a real `DelayNotificationCoordinator`
+ `PgDelayNoticeStateRepository` + `PgAuditRepository`.

**RED (two deliberately-wrong expectations):**
```
× a technician tapping running-late writes a real audit row + delay_notice_state row
  → expected 'queued' to be 'failed'
× T1 — a tenant B technician cannot see or trigger...
  → expected [Array(1)] to have a length of +0 but got 1
```

**GREEN (corrected):**
```
✓ a technician tapping running-late writes a real audit row + delay_notice_state row  205ms
✓ T1 — a tenant B technician cannot see or trigger a running-late notice against tenant A's appointment  166ms
```

**Evidence class:** real Postgres, both legs.

**Tenant grade:** T1. Second tenant's technician gets a 404 against tenant
A's appointment id (RLS-scoped read returns nothing); tenant A's rows stay
at zero; tenant B's own trigger still works and produces only tenant B's
rows.

**Gap surfaced, not invented around:** the ticket's stated target for this
row is *"running late produces a customer message as a comms-class PROPOSAL
(never auto-sent), consent-gated."* Reading `routes/appointments.ts`'s
`handleRunningLate`/`enqueueRunningLate` and
`DelayNotificationCoordinator.enqueueDelayNotice`
(`src/notifications/delay-notifications.ts:340-411`) shows the ACTUAL
behavior: a **direct, audited act** — the identical shape to "on my way"
(the code's own doc comment at `dispatch/routes.ts:84-94` calls en-route
"the human acting directly, not an AI proposal") — gated on SMS consent +
DNC (`isSmsSuppressed`) but **never gated behind a proposal an owner
approves**. It auto-sends (once consent/DNC clears) the instant the
technician taps. No `reschedule_appointment`-shaped (or any other)
comms proposal is created anywhere on this path — confirmed by grepping
`enqueueDelayNotice`'s only two call sites (`routes/appointments.ts:117,
504`), neither of which touches a `ProposalRepository`.

This test proves the REAL behavior (direct act, consent-gated) rather than
asserting the proposal-gated behavior the ticket describes, because the
latter does not exist in product code. **This is a discrepancy for
Fable/Josh to resolve** — either the ticket's target is wrong (running-late
was always meant to be a direct act, matching "on my way"), or product code
needs a real proposal gate added (out of scope here).

**Row verdict: → 4** for the parity/audit/T1 proof that DOES match reality;
flagging the proposal-vs-direct-act mismatch as a separate open question,
not a blocker to the parts that are true.

---

## Row 4.8 — one tech texting OUT → one proposal per affected customer

**File:** `packages/api/test/integration/tech-status-sms.test.ts` (modified — added a `describe('T1 — a second tenant', ...)` block)

**Command:** `cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run
--config vitest.integration.config.ts --reporter=verbose
test/integration/tech-status-sms.test.ts`

The file already ran at real Postgres with an audit read-back
(`auditRepo.findByEntity(tenant.tenantId, 'tech_status', techId)`,
asserting `tech_status.recorded`) — #1008 confirmed this but flagged it
single-tenant ("4.8 → 3 (single tenant) — neighbour"). Added a wholly
separate tenant B fixture (own tech, customer, job, appointment) driven
through the SAME registered keyword handler.

**RED (one deliberately-wrong expectation):**
```
× T1 — a second tenant > routes tenant B's tech OUT...
  → expected [ {…(8)} ] to have a length of +0 but got 1
```

**GREEN (corrected):**
```
✓ routes a verified tech OUT → unavailable block + reschedule proposal + audit  57ms
✓ is idempotent — a second OUT the same tenant-local day is a no-op  18ms
✓ anti-spoof — an OUT from an unregistered number is not actioned  7ms
✓ T1 — a second tenant > routes tenant B's tech OUT to tenant B's own block + proposal + audit, and never touches tenant A's  60ms
```

**Evidence class:** real Postgres, both legs (already true before this
change; T1 was the only gap).

**Tenant grade:** T1 (new). 13 matches for the tenant-grade grep, covering
seed, the block/proposal/audit assertions for tenant B, and the reverse
cross-tenant read.

**Row verdict: 3 → 4**, T1.

---

## Row 4.11 — Carlos is told when assigned

**No new file.** `test/integration/assignment-notifier-wiring.test.ts`
(landed via PR #1029) already proves this at real Postgres. Re-ran it to
confirm it still holds on this branch:

```
✓ characterizes today's production default: an assignment commit produces zero technician notifications when no notifier is registered  113ms
✓ GREEN: registering the notifier the way app.ts now does makes one assignment fire exactly one push + one SMS, with the audit event intact  72ms
✓ T1 — a second tenant's technician is never notified by the first tenant's assignment  55ms
```

Tenant-grade grep: 2 matches (`tenantB` fixture + seed, line 255/257).
3/3, T1, confirmed. Nothing to add — cited per the routing note, not
duplicated.

---

## Rows 4.1 / 4.4 — grading-only (tenant-grep, no test changes)

**4.1** — proving file `packages/api/test/integration/dispatch.test.ts`:
```
grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" test/integration/dispatch.test.ts
95:    it('rejects cross-tenant access to board data', async () => {
96:      const otherTenant = await createTestTenant(pool);
100:        otherTenant.tenantId,
```
1 cross-tenant test, 3 matching lines. T1 confirmed present.

**4.4** — two proving files named in the ticket:
- `test/integration/dispatch-technician-day-window.test.ts`: **0 matches.**
  This file is single-tenant only (a timezone-boundary test — `describe('Postgres integration — technician day window (tenant tz)')`), no cross-tenant assertion anywhere in it.
- `test/integration/technician-location-authz.test.ts`: **1 match** —
  ```
  76:  it('does not leak across tenants — a technician of tenant B is not submittable by tenant A', async () => {
  ```

**Grading note:** the ticket calls 4.4's technician day-window "the T1
showcase (a neighbour tenant's tech sees nothing)" — that showcase is
real, but it lives entirely in `technician-location-authz.test.ts`, not in
`dispatch-technician-day-window.test.ts` (which #1008 also cited as a
proving file and which carries zero tenant isolation coverage of its own).
Worth Fable/Josh confirming that citing both files together is intended —
the day-window file alone would not clear a T1 bar.

---

## Not done / judgment calls

1. **Row 4.2's audit-readback assertion** — genuine product-code gap
   (`createSchedulingProposal`/`routes/proposals.ts` never emits
   `proposal.created`). Captured as a RED-confirmed, `it.skip`'d test with a
   comment explaining exactly what's missing and where. Not fixed (out of
   scope: TEST-ONLY, no `packages/api/src` changes).
2. **Row 4.6's proposal-vs-direct-act mismatch** — the ticket's stated
   target ("comms-class proposal, never auto-sent") does not match the
   actual, tested behavior (a direct consent-gated act, same shape as "on
   my way"). Tested the real behavior; flagged the mismatch rather than
   inventing a proposal path that doesn't exist.
3. **Row 4.3** — no test added at all, by design; presence is confirmed
   in-process/Redis-only via file:line + a schema grep, never Postgres.
4. **Rows 4.1/4.4** — grading-only, as scoped; 4.4's two named proving files
   split the T1 coverage unevenly (see above) — flagged, not resolved.
5. **Not touched:** 4.7 (Opus wire-or-park), 4.9/4.10 (rung 0, #1001), any
   Playwright/`chromium-devauth`/`qa-matrix` reachability run, money/pricing/
   RLS/auth/`ai/supervisor/review-gate.ts`, migrations.

---

## Evidence — kept Postgres container, final pass

Container: `pgvector/pgvector:pg16` on `127.0.0.1:32768`, `serviceos_test`,
started fresh, migrations applied by the harness via
`EXTERNAL_TEST_DB_URL`. All four touched integration files re-run against it
individually — all green (see per-row sections above for per-file output;
this container ran the correctly-asserted versions only, after the RED/GREEN
cycles above had already been captured against the ephemeral testcontainer).

```sql
SELECT left(tenant_id::text,8), event_type, entity_type, count(*)
FROM audit_events GROUP BY 1,2,3 ORDER BY 2,1;

   left   |             event_type             | entity_type | count
----------+------------------------------------+-------------+-------
 064541b3 | appointment.en_route_triggered     | appointment |     1
 4e3a1a20 | appointment.en_route_triggered     | appointment |     1
 93032b5a | appointment.running_late_triggered | appointment |     1
 aecacf54 | appointment.running_late_triggered | appointment |     1
 7c7ff4b5 | tech_status.duplicate              | tech_status |     1
 5ba662ff | tech_status.recorded               | tech_status |     1
 7c7ff4b5 | tech_status.recorded               | tech_status |     1
 7c7ff4b5 | tech_status.unverified_mobile      | tech_status |     1
(8 rows)
```

```sql
SELECT left(tenant_id::text,8), proposal_type, status, count(*)
FROM proposals GROUP BY 1,2,3 ORDER BY 2,1;

   left   |     proposal_type      |      status      | count
----------+------------------------+------------------+-------
 5ba662ff | reschedule_appointment | ready_for_review |     1
 7c7ff4b5 | reschedule_appointment | ready_for_review |     1
 a1239d11 | reschedule_appointment | draft            |     2
(3 rows)
```
`a1239d11` = row 4.2's dispatch-drag-proposal tenant A — 2 draft proposals
(one per test case), still `draft` — never auto-approved, never executed.
`5ba662ff`/`7c7ff4b5` = row 4.8's tenant A / tenant B — each advanced to
`ready_for_review` by `from-tech-out.ts`, never auto-approved.

```sql
SELECT left(tenant_id::text,8), appointment_id, channel, status
FROM delay_notice_state ORDER BY 1;

   left   |             appointment_id             | channel | status
----------+--------------------------------------+---------+--------
 064541b3 | ef02b574-146c-466b-96ab-55f66c6011a4 | sms     | queued
 4e3a1a20 | d11b4024-8f11-4c44-b968-ebc406592cb8 | sms     | queued
 93032b5a | c2f95bb0-d091-4194-8b6d-c2591f35b1a5 | sms     | queued
 aecacf54 | 4393652a-4cd5-4259-b7b1-0ce2b268b196 | sms     | queued
(4 rows)
```
4 distinct tenants, 4 distinct rows — rows 4.5 (2 tenants) and 4.6 (2
tenants) each writing exactly their own row, never colliding.

```sql
SELECT left(tenant_id::text,8), status, scheduled_start FROM appointments
WHERE job_id IN (SELECT id FROM jobs WHERE job_number LIKE 'JOB-A' OR job_number LIKE 'JOB-B')
ORDER BY 1;

   left   |  status   |    scheduled_start
----------+-----------+------------------------
 51169d4d | scheduled | 2026-08-10 15:00:00+00
 a1239d11 | scheduled | 2026-08-10 15:00:00+00
(2 rows)
```
Row 4.2's appointments: still `scheduled`, still at their ORIGINAL
`scheduled_start` (`15:00:00Z`, one hour after `NOW`) — not the proposed
`19:00`/`21:00` the drag tests tried to move them to. No mutation.

```sql
SELECT left(tenant_id::text,8), count(*) FROM tech_unavailable_blocks GROUP BY 1;

   left   | count
----------+-------
 5ba662ff |     1
 7c7ff4b5 |     1
(2 rows)
```
Row 4.8: one block per tenant, no cross-tenant duplication.

---

## Build verification

```
$ cd packages/api && npx tsc --project tsconfig.build.json --noEmit
(clean — no output)
```

`git status --porcelain` empty on the branch after this report's commit.
