# Lane report — #1023 §8.8 collections and billing structures (money, Opus)

Branch `cloud/collections-8-8`, cut from `origin/main` at `a306aa7`.
**Tests only. No money code was changed** — not pricing, totals, the billing
engine, late-fee math, discount/tax math, dunning cadence, memberships, RLS,
auth or migrations. Every row below is proven against real Postgres through
`getSharedTestDb()`; no row rests on a mocked DB, an in-memory audit repo, a
doc-comment or a directory path.

**This lane does not state rungs.** Each row reports the command, its raw
output (RED then GREEN), the seam driven with `file:line`, the evidence class
and the tenant-grade grep. Fable grades.

Input taken as authoritative: the G1 comment from the §8.8 entry audit (#1009,
PR #1027) on this ticket, which replaces the printed rung column.

---

## Row summary

| Row | What this lane proved | Evidence class | Tenant grade | Files |
|---|---|---|---|---|
| **8.9** dunning cadence | cadence step keys at the real `UNIQUE` index; duplicate send refused by the INDEX (raw SQL, no app code); re-sweep raises nothing; audit read-back; **fan-out entry added (T4)** | D (real Postgres, real repos, real enumerator) | T1 (+T4 fan-out) | `dunning-cadence.test.ts` (new), `sweep-tenant-fanout.test.ts` |
| **8.10** late fees | audit read-back (exactly once); second tenant + foreign-proposal refusal; **cap clamped on the persisted invoice row**, re-sweep and re-execution add nothing | D | T1 | `late-fee-idempotency.test.ts` |
| **8.11** milestones | Σ milestones === schedule total with the remainder cent on the last, on persisted rows; `schedule-completion.ts` row shape; `milestoneBillingEnabled` control; idempotent re-entry | D | T1 | `milestone-billing.test.ts` (new) |
| **8.2** exact tier billed | the invoice bills exactly the accepted selection; declined tiers absent as ROWS; down-tier case; audit | D | T1 | `tier-billed-exactly.test.ts` (new) |
| **8.12** memberships | what the sweep really does (renew / bill / member pricing / **auto-collect**) **plus three gap-pinning tests for the default-path clauses the story promises and the code does not do**; fan-out entry added | D | T1 (+T4 fan-out) | `membership-renewal-sweep.test.ts` (new), `sweep-tenant-fanout.test.ts` |
| **8.1**, **8.3** | grading only — no code or test changed | D (pre-existing) | T1 both | — |

---

## Row 8.9 — dunning cadence at the real UNIQUE index

**Files:** `packages/api/test/integration/dunning-cadence.test.ts` (new),
`packages/api/test/integration/sweep-tenant-fanout.test.ts` (dunning entry added).

**Seam driven:**
- `src/workers/overdue-invoice-worker.ts:269` `raiseDunningProposals` → the
  record-first ledger write at `:316`, through `PgDunningEventRepository`
  (`src/invoices/pg-dunning-config.ts`) against
  `UNIQUE (tenant_id, invoice_id, kind, step_key)` (`src/db/schema.ts:3533`).
- The gap G1 named: `src/invoices/dunning-config.ts:221` — the in-memory repo
  **hand-codes** `err.code = '23505'`, so every prior duplicate-send proof was a
  claim about a test double. The duplicate here is attempted with **raw SQL on a
  pool client** — no repository, no worker, no in-memory guard — so the refusal
  can only come from the index.

**Command**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  --reporter=verbose test/integration/dunning-cadence.test.ts
```

**RED** (each assertion first written wrong, raw output):
```
 × writes the cadence step keys 3:sms / 7:sms / 14:sms as real ledger rows, and audits each proposal 135ms
   → expected [ '14:sms', '3:sms', '7:sms' ] to deeply equal [ '3:sms' ]
 × rejects a duplicate cadence key at the INDEX — a raw INSERT that runs no application code 53ms
   → expected '23505' to be undefined
 × re-sweeping the same overdue invoice raises no second reminder for an already-recorded step 85ms
   → expected [ '3:sms', '7:sms' ] to deeply equal [ '14:sms', '3:sms', '7:sms' ]
 × T1 — each tenant is chased on its OWN cadence in one pass, and neither can read the other ledger 106ms
   → expected [ '5:email' ] to deeply equal [ '3:sms' ]

 Test Files  1 failed (1)
      Tests  4 failed (4)
```

**GREEN** (after the boundary correction below — 5 tests, not the original 4)
```
 ✓ writes the cadence step keys 3:sms / 7:sms / 14:sms as real ledger rows, and audits each proposal 147ms
 ✓ fires each step ON its offset day and not before — the 13/14-day boundary 123ms
 ✓ rejects a duplicate cadence key at the INDEX — a raw INSERT that runs no application code 48ms
 ✓ re-sweeping the same overdue invoice raises no second reminder for an already-recorded step 81ms
 ✓ T1 — each tenant is chased on its OWN cadence in one pass, and neither can read the other ledger 111ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

**Boundary correction (review finding, PR #1053).** The first test originally
seeded **20** days overdue and swept once. The §8.9 acceptance criterion says
*"an invoice 15 days past due, when swept twice"* — so the boundary the
criterion names was never exercised: at 20 days the 14-day step has six days of
slack, and a regression delaying it to day 16+ would have kept the suite green
while breaking the row. It now matches the criterion verbatim, plus a boundary
pair (13 days → two steps; exactly 14 → three) that pins
`elapsed < step.offsetDays` (`dunning-schedule.ts:56`) in both directions:

```
 × fires each step ON its offset day and not before — the 13/14-day boundary
   → expected [ '3:sms', '7:sms' ] to deeply equal [ '14:sms', '3:sms', '7:sms' ]   (RED)
```

What each test pins:
1. A **15-day-overdue** invoice (the criterion's own figure), **swept twice**,
   on a tenant whose persisted cadence is 3/7/14 SMS
   yields three `invoice_dunning_events` rows keyed `3:sms`, `7:sms`, `14:sms`
   (read back both through `PgDunningEventRepository.findByInvoice` and by raw
   `SELECT`), three `ready_for_review` `send_payment_reminder` proposals, and
   three `invoice.dunning_proposed` audit rows plus one `invoice.overdue`,
   through `PgAuditRepository.findByEntity`.
2. The second attempt at `3:sms` is a **raw** `INSERT INTO invoice_dunning_events`
   on a pool client with `app.current_tenant_id` set. It returns
   `code = '23505'` on a constraint whose name contains `step_key`, and the
   ledger still holds exactly one row for that step. A duplicate send is
   impossible because the database refuses it.
3. Three sweeps of a 9-day-overdue invoice leave two rows (`3:sms`, `7:sms` —
   `14:sms` is not yet due) and two proposals.
4. **T1** — two tenants with different persisted cadences (3+14 SMS vs 5 email)
   are chased on their own cadence in one pass; `findByInvoice(tenantB, invoiceA)`
   returns `[]`.

**Fan-out entry (T4)** — `sweep-tenant-fanout.test.ts`, new
`describe('overdue-invoice (dunning) sweep')`, mirroring the estimate-expiry
entry: real `listAllTenantIds(pool)` reach, one tenant's failure isolated
(`failed >= 1`, thrower chosen by enumerator order), and — on the real
repositories — a tenant whose invoice is **not yet due** left with no ledger
row, no reminder proposal and no `invoice.dunning_proposed` audit row in the
same pass that chases its neighbour.

The two seam tests carry the reach-across-the-whole-database claim on the real
enumerator. The third test WRITES through real repositories, so it asserts
`listAllTenantIds(pool)` contains both of its seeded tenants (the D-032 claim)
and then drives the sweep with just those two ids — handing a writing sweep
every tenant in the shared container would chase other integration files'
invoices and make the suite order-dependent. Changed in response to a review
finding on PR #1053; see **Review follow-ups** at the end.

```
 × overdue-invoice (dunning) sweep > reaches every tenant through the real enumerator 20ms
   → expected [ …(68) ] to deeply equal []          (RED)
 × overdue-invoice (dunning) sweep > keeps going when one tenant throws 8ms      (RED)
 × overdue-invoice (dunning) sweep > chases the overdue tenant and leaves another tenant
   with nothing overdue untouched in the same pass 343ms                          (RED)
 Tests  3 failed | 19 passed (22)
---
 ✓ overdue-invoice (dunning) sweep > reaches every tenant through the real enumerator 5ms
 ✓ overdue-invoice (dunning) sweep > keeps going when one tenant throws 5ms
 ✓ overdue-invoice (dunning) sweep > chases the overdue tenant and leaves another tenant
   with nothing overdue untouched in the same pass 306ms
 Tests  22 passed (22)
```

**Evidence class:** D — real Postgres, production repositories, production
enumerator, audit through `PgAuditRepository`.

**Tenant-grade grep**
```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" \
    test/integration/dunning-cadence.test.ts
283:    const tenantB = await seedOverdueInvoice(20, now);
288:    await seedCadence(tenantB.tenantId, [{ offsetDays: 5, channel: 'email' }]);
290:    await sweepFor([tenantA.tenantId, tenantB.tenantId], now);
293:    const bEvents = await dunningEventRepo.findByInvoice(tenantB.tenantId, tenantB.invoiceId);
300:      tenantB.tenantId,
306:    const bProposals = await proposalRepo.findByStatus(tenantB.tenantId, 'ready_for_review');

$ grep -nE "…" test/integration/sweep-tenant-fanout.test.ts   # dunning entry
671:    it('chases the overdue tenant and leaves another tenant with nothing overdue untouched in the same pass', …
721:      const tenantB = await seedInvoice(new Date(asOf.getTime() + 10 * 86_400_000));
743:      expect(await dunningEventRepo.findByInvoice(tenantB.tenantId, tenantB.invoiceId)).toEqual([]);
```

T1 is what this earns: two differently-configured tenants in one pass plus a
cross-tenant read that returns nothing. It is **not** T3 — no assertion turns on
two tenants' divergent *outcomes* of the same configuration knob beyond the
cadence itself.

---

## Row 8.10 — late fees: audit, a second tenant, and the cap

**File:** `packages/api/test/integration/late-fee-idempotency.test.ts`
(extended; the original idempotency test is preserved and strengthened).

**Seam driven:**
- `src/proposals/execution/apply-late-fee-handler.ts:121` — the deterministic
  `lateFeeLineId(invoice.id, stepKey)` idempotency guard, across a real reload.
- `src/invoices/late-fee.ts:69` — the cap clamp
  (`fee = Math.min(fee, lateFeeMaxCents - alreadyAccruedCents)`), reached through
  the **real sweep** (`overdue-invoice-worker.ts:352`), not called directly.

**Command**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  --reporter=verbose test/integration/late-fee-idempotency.test.ts
```

**RED** (two passes — the second isolates assertions the first pass never
reached because an earlier assertion failed first):
```
 × … audits it exactly once (real DB reload) 87ms
   → expected [ { …(10) } ] to have a length of 2 but got 1
 × T1 — a second tenant fee applies to its own invoice only, and a foreign proposal is refused 57ms
   → expected 84000 to be 80000 // Object.is equality
 × the late-fee cap … clamps a fee above the cap on the persisted invoice 75ms
   → expected 2000 to be 5000 // Object.is equality
 Tests  3 failed (3)

(RED pass 2)
 ✓ … audits it exactly once (real DB reload) 86ms
 × T1 — a second tenant fee applies to its own invoice only, and a foreign proposal is refused 66ms
   → expected false to be true // Object.is equality
 × the late-fee cap … 116ms
   → expected 2000 to be 5000 // Object.is equality
 Tests  2 failed | 1 passed (3)
```

**GREEN**
```
 ✓ re-executing the same proposal does not append a second fee line, and audits it exactly once (real DB reload) 86ms
 ✓ T1 — a second tenant fee applies to its own invoice only, and a foreign proposal is refused 73ms
 ✓ the late-fee cap, end to end at real Postgres > clamps a fee above the cap on the persisted invoice, and a re-sweep adds no second fee line 128ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

The two halves, reported separately as the ticket asks:

- **Idempotency half (was already D).** Unchanged in substance, now with the
  audit leg: exactly one `invoice.late_fee_applied` through
  `PgAuditRepository.findByEntity` across a re-execution, carrying
  `{stepKey:'initial', feeCents:2500, newAmountDueCents:17500}`. The no-op
  second execution must not log a second application, which nothing checked
  before.
- **Second tenant (T1).** Tenant A (15000 base) and tenant B (80000 base) each
  take their own fee in the same run: 17500 and 84000. Tenant B executing a
  proposal that names tenant A's invoice fails with *"not found in this
  tenant"* and moves nothing; `findByEntity(tenantB, 'invoice', invoiceA)`
  is empty.
- **Cap half (was unit-only; now D).** A tenant persists `flat 5000, cap 2000,
  grace 0` and has a 1000.00 invoice 30 days overdue. The sweep records
  `amount_cents = 2000` in the ledger and raises a proposal for
  `feeCents: 2000`. On approval the **persisted invoice row** carries a single
  `Late fee` line of 2000 and `amount_due_cents = 102000` — never 105000. A
  re-sweep sees 2000 accrued against the 2000 cap, so no second ledger row and
  no second proposal; re-executing the approved proposal adds no second fee
  line.

**Evidence class:** D.

**Tenant-grade grep**
```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" \
    test/integration/late-fee-idempotency.test.ts
214:    const tenantB = await seedInvoice(80000, 'tenant-b');
220:    expect((await handler.execute(makeProposal(tenantB, 4000), {
226:    const b = await invoiceRepo.findById(tenantB.tenantId, tenantB.invoiceId);
245:    const bAudit = await auditRepo.findByEntity(tenantB.tenantId, 'invoice', tenantB.invoiceId);
247:    expect(await auditRepo.findByEntity(tenantB.tenantId, 'invoice', tenantA.invoiceId)).toEqual([]);
```

Not covered by this lane: the voice-collections leg (leg 4), which G1 already
grades T1 and which no change here touches.

---

## Row 8.11 — the milestone split, persisted

**File:** `packages/api/test/integration/milestone-billing.test.ts` (new).

**Seam driven:** both minting paths, because only both together make
`Σ milestones === total` a statement about rows —
`src/proposals/execution/invoice-schedule-handler.ts:186`
(`createInvoiceWithNextNumber` for each `on_accept` allocation) and
`src/invoices/schedule-completion.ts:79` (the savepoint-wrapped mint for each
`on_completion` allocation), over `splitMilestones`
(`src/invoices/invoice-schedule.ts:146`).

The schedule is 100.00 split `3333 bps / 3333 bps / remainder`, so the split is
3333 + 3333 + **3334** — the extra cent is visible on the last milestone and any
drift shows up as a sum that is not 10000.

**Command**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  --reporter=verbose test/integration/milestone-billing.test.ts
```

**RED**
```
 × mints one invoice per milestone whose amounts sum to the schedule total, with the remainder cent on the last 134ms
   → expected [ 3333, 3333, 3334 ] to deeply equal [ 3334, 3333, 3333 ]
 × the completion path mints NUMBERED DRAFT invoices — one labelled line each, linked to the schedule, audited 84ms
   → expected 'draft' to be 'open' // Object.is equality
 × mints no completion milestone for a tenant that has not enabled milestone billing (PR #1029 owner control) 39ms
   → expected [ +0 ] to deeply equal [ +0, 1, 2 ]
 × T1 — a second tenant mints its own milestones in the same run and neither schedule is visible to the other 158ms
   → expected null not to be null
 Tests  4 failed (4)
```

**GREEN**
```
 ✓ mints one invoice per milestone whose amounts sum to the schedule total, with the remainder cent on the last 147ms
 ✓ the completion path mints NUMBERED DRAFT invoices — one labelled line each, linked to the schedule, audited 107ms
 ✓ mints no completion milestone for a tenant that has not enabled milestone billing (PR #1029 owner control) 44ms
 ✓ T1 — a second tenant mints its own milestones in the same run and neither schedule is visible to the other 172ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Pinned:
- three persisted invoices at `milestone_index` 0/1/2 carrying 3333, 3333, 3334;
  the sum read straight out of `invoices` is exactly 10000 and equals
  `invoice_schedules.total_amount_cents`; the odd cent is on the remainder
  milestone (`amounts[2] - amounts[1] === 1`);
- **the row shape `schedule-completion.ts` writes** (what the ticket asked for):
  `status = 'draft'`, a real number off the tenant's own sequence
  (`INV0001`/`INV0002`/`INV0003`, never a `PENDING-` placeholder), exactly one
  taxable line labelled with the milestone (`Progress`, `Balance`),
  `amount_paid_cents = 0`, `amount_due_cents = total_cents`, linked by
  `schedule_id` + `milestone_index`, each with exactly one
  `invoice.milestone_minted` audit row through
  `PgAuditRepository.findByEntity`; a retried completion mints nothing more;
- PR #1029's owner control: with `milestoneBillingEnabled = false` the
  completion path returns `[]` and only the `on_accept` deposit exists — the
  balance is never billed;
- **T1** — a second tenant mints its own three milestones in the same run, the
  first tenant's set is byte-identical afterwards, and neither tenant can read
  the other's schedule, invoices or audit rows.

**Evidence class:** D.

**Tenant-grade grep**
```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" \
    test/integration/milestone-billing.test.ts
283:    const tenantB = await seedJob(true);
286:    const bInvoices = await mintAll(tenantB);
301:    expect(await scheduleRepo.findById(tenantB.tenantId, aSchedule.id)).toBeNull();
302:    expect(await invoiceRepo.findByJob(tenantB.tenantId, tenantA.jobId)).toEqual([]);
304:      await auditRepo.findByEntity(tenantB.tenantId, 'invoice', aInvoices[0].id),
```

---

## Row 8.2 — the invoice bills exactly the tier the customer chose

**File:** `packages/api/test/integration/tier-billed-exactly.test.ts` (new).

**Seam driven:** `src/invoices/convert-estimate.ts:67` —
`resolveSelectedLineItems(estimate.lineItems, estimate.acceptedSelection)` —
driven from a real customer acceptance through
`PublicEstimateService.approve` (`src/estimates/public-estimate-service.ts:271`),
not from a hand-set `acceptedSelection`.

The accept half was already proven (`estimate-phases.test.ts` Phase 3). The
billing half had nothing. The estimate is a real good/better/best — always-billed
diagnostic 5000, tier group Good 10000 (**default**) / Better 25000 / Best 40000,
plus an add-on 2500 that is not pre-checked — so every wrong answer is a
different number: 82500 (the whole sheet), 15000 (the default they were shown),
32500 (what they chose).

**Command**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  --reporter=verbose test/integration/tier-billed-exactly.test.ts
```

**RED**
```
 × bills the upgraded tier and the chosen add-on — the declined tiers are absent as invoice rows 158ms
   → expected 32500 to be 15000 // Object.is equality
 × bills the DOWN-tier choice too — a customer who keeps the cheapest option is not billed the upgrade 88ms
   → expected 15000 to be 30000 // Object.is equality
 × T1 — two tenants choose different tiers in the same run; each invoice bills its own choice 139ms
   → expected 45000 to be 15000 // Object.is equality
 Tests  3 failed (3)

(RED pass 2 — the row-level assertion the first pass never reached)
 × bills the upgraded tier and the chosen add-on — the declined tiers are absent as invoice rows 149ms
   → expected [ 'Diagnostic', …(2) ] to include 'Good — builder heater'
 Tests  1 failed | 2 passed (3)
```

**GREEN**
```
 ✓ bills the upgraded tier and the chosen add-on — the declined tiers are absent as invoice rows 145ms
 ✓ bills the DOWN-tier choice too — a customer who keeps the cheapest option is not billed the upgrade 76ms
 ✓ T1 — two tenants choose different tiers in the same run; each invoice bills its own choice 144ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

Pinned: the upgrade case bills 32500 and the declined tiers are absent as **rows**
in `invoice_line_items` (a `SELECT description …` that must not contain
`Good — builder heater` or `Best — premium heater`), with exactly one
`estimate.converted` audit row carrying `totalCents: 32500`; the down-tier case
bills 15000 and not the declined add-on; **T1** — two tenants pick Best and Good
in the same run, each invoice bills its own tenant's choice, converting one
leaves the other untouched, and neither tenant can read the other's invoice,
estimate or audit rows.

**Evidence class:** D.

**Tenant-grade grep**
```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" \
    test/integration/tier-billed-exactly.test.ts
296:    const tenantB = await seedTieredEstimate();
304:      token: tenantB.token,
306:      selectedLineItemIds: [tenantB.ids.diagnostic, tenantB.ids.good],
310:    const bInvoice = await convert(tenantB);
322:    expect(await invoiceRepo.findById(tenantB.tenantId, aInvoice!.id)).toBeNull();
```

---

## Row 8.12 — memberships (story-not-met)

**Files:** `packages/api/test/integration/membership-renewal-sweep.test.ts`
(new), `packages/api/test/integration/sweep-tenant-fanout.test.ts`
(recurring-agreements entry added).

G1 is right and the PRD's premise was wrong: `runRecurringAgreementsSweep`
(`src/workers/recurring-agreements-worker.ts:38`) exists and is wired at
`src/app.ts:5793` on a 60s interval behind the `recurringAgreements` sweep lock.
What was true is that nothing tested its *behaviour*.

**The ports in this test are copied from the production wiring**
(`src/app.ts:5658-5713`) so what is asserted is what ships — including its
invoice-numbering choice.

**Command**
```
cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts \
  --reporter=verbose test/integration/membership-renewal-sweep.test.ts
```

**RED** — note the three story-not-met tests were first run as plain `it(…)`, so
the gap itself is shown failing rather than asserted in prose:
```
 × renews a lapsed auto-renew membership: ends_on rolls forward, renewal_count bumps, and it is audited 82ms
   → expected 1 to be +0 // Object.is equality
 × catches up several missed terms in ONE pass rather than leaving the member lapsed 33ms
   → expected 3 to be 1 // Object.is equality
 × bills the due cycle: a job, an invoice and a run row land, next_run_at advances, and a re-sweep does not double-bill 57ms
   → expected 'generated' to be 'failed' // Object.is equality
 × member pricing resolves from real agreement rows — the best EFFECTIVE discount, never a lapsed one 40ms
   → expected 1500 to be 4000 // Object.is equality
 × T1 — two tenants are renewed and billed on their own memberships in one pass, with no cross-tenant reach 117ms
   → expected 4900 to be 19900 // Object.is equality
 × RED the dues invoice is ISSUED so the customer can pay it — today it is left a draft 49ms
   → expected 'draft' to be 'open' // Object.is equality
 × RED the dues invoice carries a due date so the collections cadence can chase it — today it has none 50ms
   → expected undefined to be defined
 × RED the dues invoice is numbered off the tenant invoice sequence — today it is AGREEMENT-<epoch ms> 52ms
   → expected 'AGREEMENT-1789237564239' to match /^INV\d{4}$/
 × the tenant invoice sequence is NOT advanced by a membership cycle (the numbering gap, asserted positively) 50ms
   → expected true to be false // Object.is equality
 Tests  9 failed (9)
```

**GREEN**
```
 ✓ renews a lapsed auto-renew membership: ends_on rolls forward, renewal_count bumps, and it is audited 87ms
 ✓ catches up several missed terms in ONE pass rather than leaving the member lapsed 36ms
 ✓ bills the due cycle: a job, an invoice and a run row land, next_run_at advances, and a re-sweep does not double-bill 90ms
 ✓ member pricing resolves from real agreement rows — the best EFFECTIVE discount, never a lapsed one 51ms
 ✓ T1 — two tenants are renewed and billed on their own memberships in one pass, with no cross-tenant reach 109ms
 ✓ the dues invoice is ISSUED so the customer can pay it — today it is left a draft 54ms
 ✓ the dues invoice carries a due date so the collections cadence can chase it — today it has none 51ms
 ✓ the dues invoice is numbered off the tenant invoice sequence — today it is AGREEMENT-<epoch ms> 59ms
 ✓ the tenant invoice sequence is NOT advanced by a membership cycle (the numbering gap, asserted positively) 57ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
```

### What the code DOES do (proven on real rows)

- **Renewal.** `renewExpiringAgreements` (`agreement-service.ts:557`) rolls
  `ends_on` forward by `renewal_term_months` until it is strictly in the future,
  bumps `renewal_count`, and audits `service_agreement.renewed` with
  `{termsAdded, renewalCount}`. Three missed annual terms are caught up in ONE
  pass (`renewal_count = 3`) rather than leaving the member lapsed.
- **Billing the cycle.** The due membership produces a job, an invoice at the
  membership price in integer cents, and a `service_agreement_runs` row with
  `status = 'generated'`; `next_run_at` advances past now, `last_run_at` is
  stamped, `service_agreement.run.generated` is audited, and a second sweep the
  same day bills nothing more (the `(agreement_id, scheduled_for)` UNIQUE plus
  the pre-check).
- **Member pricing resolves.** `getCustomerMemberDiscountBps` over real rows
  returns the best **effective** discount (1500 bps) and ignores a richer one
  (4000 bps) whose term has lapsed; another tenant's scoped call for the same
  customer id returns 0.
- **T1** — two tenants renewed and billed on their own memberships in one pass
  (19900 and 4900), only the auto-renew one renewed, and no cross-tenant reach
  into agreements, runs or invoices.

### The AUTO-COLLECT branch — dues that DO collect themselves

**Correction (review finding on PR #1053, Codex P2).** An earlier revision of
this report stated the draft/no-due-date gap below as universal. It is not.
When a membership has `autoCollectDues: true`, the tenant has a saved default
card, and `STRIPE_SECRET_KEY` is configured, `app.ts:5760-5766` issues the
draft with a **30-day** term *before* charging:

```ts
ensureIssuedAmountDue: async (tenantId, invoiceId) => {
  let inv = await invoiceRepo.findById(tenantId, invoiceId);
  if (inv && inv.status === 'draft') {
    inv = (await issueInvoice(tenantId, invoiceId, 30, invoiceRepo)) ?? inv;
  }
  return inv?.amountDueCents ?? 0;
}
```

That branch is now proven on real rows, with only the Stripe HTTP call injected
at the `stripeFetch` seam (the collector, the invoice ops, `issueInvoice`,
`recordPayment` and every repository are production code):

- **card succeeds** → the invoice is `paid`, carries a due date,
  `amount_paid_cents = 19900`, `amount_due_cents = 0`, and
  `service_agreement.dues_collected` is audited;
- **card declined** → the invoice is left **`open` WITH a due date** and
  `amount_due_cents = 19900`, `service_agreement.auto_collect_failed` is
  audited — and the collections cadence really does reach it: running the real
  overdue sweep 10 days past that due date records `3:sms` against it. This is
  the whole point of issuing before charging, and it works;
- **no saved card** → `no_card` returns *before* issuance
  (`dues-collector.ts:85`), so the default path's gap reappears for a member
  who never completed card setup: `draft`, no due date.

### What it does NOT do — the story-not-met findings, scoped to the default path

Each is an ordinary test in the file asserting the CURRENT (wrong) value, so it
goes RED the moment the gap is closed — the signal to update the row. They were
first written as `it.fails`; two reviewers independently showed that `it.fails`
passes on ANY throw, so a setup regression (no run generated → a TypeError on
`run.generatedInvoiceId`) would read as "expected fail" and the gap would
silently stop being tested. Each now opens with setup assertions so a broken
seed is unmistakable. **This lane does not decide what memberships minimally
are; that is a story-not-met decision for the orchestrator's decision list.**

These hold for the DEFAULT path — `autoCollectDues` defaults to false in
`createAgreement` (`agreement-service.ts:206`), so this is what a membership
gets unless the owner opts in — and for an opted-in member with no saved card.
They do **not** hold for a fully-configured auto-collect membership.

1. **The dues invoice is never issued.** `runDueAgreements`
   (`agreement-service.ts:402`) calls `createDraftInvoice`, and `createInvoice`
   (`src/invoices/invoice.ts:336`) hardcodes `status: 'draft'`. On this path
   nothing in the sweep issues or sends it, so "recurring revenue is actually
   recurring" requires a human to open each cycle's draft.
2. **The dues invoice has no due date.** The production port
   (`src/app.ts:5689-5710`) passes no `dueDate`. The overdue sweep's prefilter
   is `status IN ('open','partially_paid') AND due_date <= now`
   (`overdue-invoice-worker.ts:163-172`), so such a dues invoice can never be
   selected: an unpaid membership on the default path is never chased, however
   long it goes unpaid. Findings 1 and 2 compound — for the default path, the
   collections cadence proven in row 8.9 cannot reach membership revenue.
3. **The dues invoice is numbered `AGREEMENT-<epoch ms>`** (`src/app.ts:5693`)
   rather than through `createInvoiceWithNextNumber`. Proven positively: the
   invoice number starts with `AGREEMENT-` and the tenant's
   `next_invoice_number` is still 1 after a billed cycle, so the tenant's books
   have a hole. This is also a latent collision: `idx_invoices_number` is
   `UNIQUE (tenant_id, invoice_number)`, so two agreements for one tenant billed
   in the same millisecond would collide (the run is then recorded `failed`, not
   silently lost — but the cycle is not billed).

**Fan-out entry (T4)** — new `describe('recurring-agreements (membership) sweep')`
in `sweep-tenant-fanout.test.ts`: real enumerator reach, failure isolation, and
a tenant whose cycle is not due left unbilled in the same pass that bills its
neighbour (run rows and `service_agreement.run.generated` both absent). As in
the dunning entry, the two seam tests carry the reach claim on the real
enumerator and the writing test asserts the enumerator reaches its tenants, then
confines the sweep to them.

Isolation here needed a second case (review finding, PR #1053). The worker
wraps renewal and billing in **separate** try/catch blocks
(`recurring-agreements-worker.ts:60` and `:79`), and the seam injects failures
only through `findDue` — so it exercised the billing catch and said nothing
about the renewal one, which could have been deleted with the suite still
green. A fourth test drives the renewal phase directly and pins the promise
that catch's own comment makes at `:58` — *"a renewal failure must not block
this tenant's run sweep"*: the tenant whose `findRenewable` throws is still
billed, and so is every other tenant. Verified load-bearing (asserting the
doomed tenant is NOT billed fails).

```
 × recurring-agreements (membership) sweep > reaches every tenant through the real enumerator 19ms
   → expected [ …(42) ] to deeply equal []                                       (RED)
 × recurring-agreements (membership) sweep > keeps going when one tenant throws 8ms
   → expected [ …(45) ] to not deeply equal ArrayContaining{…}                   (RED)
 × recurring-agreements (membership) sweep > bills the due membership and leaves another
   tenant whose cycle is not due untouched 285ms
   → expected 'generated' to be 'failed'                                          (RED)
 Tests  3 failed | 22 passed (25)
---
 ✓ recurring-agreements (membership) sweep > reaches every tenant through the real enumerator 7ms
 ✓ recurring-agreements (membership) sweep > keeps going when one tenant throws 5ms
 ✓ recurring-agreements (membership) sweep > bills the due membership and leaves another
   tenant whose cycle is not due untouched 239ms
 Tests  25 passed (25)
```

**Observation recorded in that entry, not fixed:** this worker's isolation shape
differs from its siblings. `recurring-agreements-worker.ts:103-108` logs a
tenant failure and swallows it **without a counter** — its `failed` return counts
failed *runs*, not failed *tenants* — so the proof that the loop survived is
that every later tenant was still reached, not a `failed >= 1` assertion.
`overdue-invoice-worker.ts` and `execution-worker.ts` both count. Worth a
follow-up ticket; out of scope here (it is worker code, not a test).

**Evidence class:** D.

**Tenant-grade grep**
```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" \
    test/integration/membership-renewal-sweep.test.ts
(tenantA/tenantB pair in the T1 test; `another tenant` in the member-pricing test;
 cross-tenant assertions on agreementRepo/runRepo/invoiceRepo at the end of T1)
```

---

## Rows 8.1 and 8.3 — grading only

No code and no test changed. Both files run on real Postgres via
`getSharedTestDb()`.

**8.1 — `test/integration/draft-invoice-execution.test.ts`** (745 lines, 5
`getSharedTestDb()` call sites).
```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" \
    test/integration/draft-invoice-execution.test.ts
197:  it('does not expose the invoice to another tenant (scoped read)', async () => {
```
One cross-tenant assertion, and it is a read-only scoped-read refusal
(`invoiceRepo.findById(other.tenantId, invoiceId)` → null). **T1.** No second
tenant is configured differently and no second tenant's outcome is asserted in
the same pass, so this is short of T2/T3. Consistent with G1's "8.1 → 4 at T1
(5 waits on #1025)".

**8.3 — `test/integration/update-job-execution.test.ts`** (796 lines, 3
`getSharedTestDb()` call sites).
```
$ grep -nE "tenantB|otherTenant|secondTenant|cross-tenant|another tenant|across tenants" \
    test/integration/update-job-execution.test.ts
11: * completion effects, the job.updated audit event, and the cross-tenant
228:  it('does not expose the job to another tenant (scoped read) and a cross-tenant jobId fails cleanly', …
242:        summary: 'cross-tenant attempt',
252:    // The row is untouched — no cross-tenant write leaked through.
759:  it('cross-tenant: the same sentence resolves to nothing for another tenant, and a borrowed jobId stays GATED', …
```
Stronger than 8.1's: a cross-tenant **write attempt** through the production
execution registry is refused and the row is verified untouched, and a borrowed
jobId stays gated on the voice path. Still **T1** — a refusal, not two tenants
with divergent configuration served in one pass. Consistent with G1's "8.3
confirmed 4 at T1", including its note that the completed-transition test logs
auto-invoice effects as *not wired* (control on #1010).

---

## Evidence — artifact before sign-off

After the final green run, a **plain** Postgres container (not the testcontainer
harness) was started and every touched integration file re-run against it, then
the rows dumped.

```
$ docker run -d --rm -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=serviceos_test -p 127.0.0.1:0:5432 pgvector/pgvector:pg16 -c max_connections=300
2a4059d50a7a8914bea01bf9d40961fd3547f20e8f3bd8839557d18ba8e14d54      (port 32768)

$ cd packages/api && EXTERNAL_TEST_DB_URL=postgres://test:test@localhost:32768/serviceos_test \
  RLS_RUNTIME_ROLE=true npx vitest run --config vitest.integration.config.ts --reporter=verbose \
  test/integration/dunning-cadence.test.ts test/integration/late-fee-idempotency.test.ts \
  test/integration/milestone-billing.test.ts test/integration/tier-billed-exactly.test.ts \
  test/integration/membership-renewal-sweep.test.ts test/integration/sweep-tenant-fanout.test.ts

 Test Files  6 passed (6)
      Tests  51 passed (51)
   Duration  7.50s
```

### audit_events

```
$ docker exec <cid> psql -U test -d serviceos_test -P pager=off -c "SELECT left(tenant_id::text,8), event_type, entity_type, count(*) FROM audit_events GROUP BY 1,2,3 ORDER BY 2,1;"
   left   |           event_type            |      entity_type      | count
----------+---------------------------------+-----------------------+-------
 056eac30 | estimate.converted              | estimate              |     1
 30d239a7 | estimate.converted              | estimate              |     1
 ca78fc9b | estimate.converted              | estimate              |     1
 e26822e7 | estimate.converted              | estimate              |     1
 d7d93266 | estimate.expired                | estimate              |     1
 056eac30 | invoice.created                 | invoice               |     1
 0ace9546 | invoice.created                 | invoice               |     1
 14e7ab05 | invoice.created                 | invoice               |     1
 30d239a7 | invoice.created                 | invoice               |     1
 67d44a6e | invoice.created                 | invoice               |     1
 68e0b167 | invoice.created                 | invoice               |     1
 b5b494ba | invoice.created                 | invoice               |     1
 bdbd85b6 | invoice.created                 | invoice               |     1
 bdbdebb3 | invoice.created                 | invoice               |     1
 ca78fc9b | invoice.created                 | invoice               |     1
 e26822e7 | invoice.created                 | invoice               |     1
 fa23a847 | invoice.created                 | invoice               |     1
 51c8590d | invoice.dunning_proposed        | invoice               |     1
 566f8de6 | invoice.dunning_proposed        | invoice               |     2
 ad09b4fc | invoice.dunning_proposed        | invoice               |     1
 adca1e37 | invoice.dunning_proposed        | invoice               |     3
 c055582a | invoice.dunning_proposed        | invoice               |     1
 d497fd8a | invoice.dunning_proposed        | invoice               |     2
 efd5a336 | invoice.dunning_proposed        | invoice               |     1
 51c8590d | invoice.late_fee_applied        | invoice               |     1
 7c26c84d | invoice.late_fee_applied        | invoice               |     1
 8e8172bb | invoice.late_fee_applied        | invoice               |     1
 c5acfaf1 | invoice.late_fee_applied        | invoice               |     1
 1a7fdde1 | invoice.milestone_minted        | invoice               |     2
 5230182f | invoice.milestone_minted        | invoice               |     2
 a824e9c5 | invoice.milestone_minted        | invoice               |     2
 ea953a84 | invoice.milestone_minted        | invoice               |     2
 51c8590d | invoice.overdue                 | invoice               |     1
 566f8de6 | invoice.overdue                 | invoice               |     1
 ad09b4fc | invoice.overdue                 | invoice               |     1
 adca1e37 | invoice.overdue                 | invoice               |     1
 c055582a | invoice.overdue                 | invoice               |     1
 d497fd8a | invoice.overdue                 | invoice               |     1
 efd5a336 | invoice.overdue                 | invoice               |     1
 0ace9546 | job.created                     | job                   |     1
 14e7ab05 | job.created                     | job                   |     1
 67d44a6e | job.created                     | job                   |     1
 68e0b167 | job.created                     | job                   |     1
 b5b494ba | job.created                     | job                   |     1
 bdbd85b6 | job.created                     | job                   |     1
 bdbdebb3 | job.created                     | job                   |     1
 fa23a847 | job.created                     | job                   |     1
 51c8590d | job.money_state_changed         | job                   |     1
 566f8de6 | job.money_state_changed         | job                   |     1
 ad09b4fc | job.money_state_changed         | job                   |     1
 adca1e37 | job.money_state_changed         | job                   |     1
 c055582a | job.money_state_changed         | job                   |     1
 d497fd8a | job.money_state_changed         | job                   |     1
 efd5a336 | job.money_state_changed         | job                   |     1
 056eac30 | public_estimate.approved        | estimate              |     1
 30d239a7 | public_estimate.approved        | estimate              |     1
 ca78fc9b | public_estimate.approved        | estimate              |     1
 e26822e7 | public_estimate.approved        | estimate              |     1
 05731597 | service_agreement.created       | service_agreement     |     1
 0ace9546 | service_agreement.created       | service_agreement     |     1
 14e7ab05 | service_agreement.created       | service_agreement     |     1
 28bf36a4 | service_agreement.created       | service_agreement     |     3
 65d33566 | service_agreement.created       | service_agreement     |     1
 67d44a6e | service_agreement.created       | service_agreement     |     1
 68e0b167 | service_agreement.created       | service_agreement     |     1
 81ea2563 | service_agreement.created       | service_agreement     |     1
 b5b494ba | service_agreement.created       | service_agreement     |     1
 bdbd85b6 | service_agreement.created       | service_agreement     |     1
 bdbdebb3 | service_agreement.created       | service_agreement     |     1
 fa23a847 | service_agreement.created       | service_agreement     |     1
 0ace9546 | service_agreement.renewed       | service_agreement     |     1
 65d33566 | service_agreement.renewed       | service_agreement     |     1
 81ea2563 | service_agreement.renewed       | service_agreement     |     1
 0ace9546 | service_agreement.run.generated | service_agreement     |     1
 14e7ab05 | service_agreement.run.generated | service_agreement     |     1
 67d44a6e | service_agreement.run.generated | service_agreement     |     1
 68e0b167 | service_agreement.run.generated | service_agreement     |     1
 b5b494ba | service_agreement.run.generated | service_agreement     |     1
 bdbd85b6 | service_agreement.run.generated | service_agreement     |     1
 bdbdebb3 | service_agreement.run.generated | service_agreement     |     1
 fa23a847 | service_agreement.run.generated | service_agreement     |     1
 36ba73d9 | weekly_feedback_email.sent      | weekly_feedback_email |     1
 36e02d5a | weekly_feedback_email.sent      | weekly_feedback_email |     1
 80fc56ae | weekly_feedback_email.sent      | weekly_feedback_email |     1
(84 rows)
```

Every audit event this lane claims is present per tenant: `invoice.dunning_proposed`
(1/2/3 rows matching each tenant's own cadence), `invoice.late_fee_applied`
(exactly one per fee — never two, including the tenant whose fee was capped),
`invoice.milestone_minted` (2 per tenant — the two `on_completion` milestones),
`estimate.converted`, `service_agreement.renewed` and `service_agreement.run.generated`.

### Dunning ledger, cadence config and late-fee lines (amounts in cents)

```
=== invoice_dunning_events (cadence + late-fee ledger) ===
  tenant  | invoice  |   kind   | step_key | amount_cents | channel
----------+----------+----------+----------+--------------+---------
 51c8590d | c91174e2 | late_fee | initial  |         2000 |
 566f8de6 | 72ce7b6d | reminder | 14:sms   |              | sms
 566f8de6 | 72ce7b6d | reminder | 3:sms    |              | sms
 ad09b4fc | a3cf4af5 | reminder | 5:email  |              | email
 adca1e37 | 89542b19 | reminder | 14:sms   |              | sms
 adca1e37 | 89542b19 | reminder | 3:sms    |              | sms
 adca1e37 | 89542b19 | reminder | 7:sms    |              | sms
 c055582a | 81bdf200 | reminder | 3:sms    |              | sms
 d497fd8a | eacf19b7 | reminder | 3:sms    |              | sms
 d497fd8a | eacf19b7 | reminder | 7:sms    |              | sms
 efd5a336 | 83c0714d | reminder | 3:sms    |              | sms
(11 rows)

=== invoice_dunning_configs (per-tenant cadence + cap) ===
  tenant  | enabled |                          reminder_steps                          | late_fee_type | late_fee_value_cents | late_fee_grace_days | late_fee_max_cents
----------+---------+------------------------------------------------------------------+---------------+----------------------+---------------------+--------------------
 51c8590d | t       | []                                                               | flat          |                 5000 |                   0 |               2000
 566f8de6 | t       | [{"channel":"sms","offsetDays":3},{"channel":"sms","offsetDays":14}]  | none      |                    0 |                   0 |
 9ed1cacf | t       | [{"channel":"sms","offsetDays":3}]                               | none          |                    0 |                   0 |
 ad09b4fc | t       | [{"channel":"email","offsetDays":5}]                             | none          |                    0 |                   0 |
 adca1e37 | t       | [{"channel":"sms","offsetDays":3},{"channel":"sms","offsetDays":7},{"channel":"sms","offsetDays":14}] | none | 0 |        0 |
 c055582a | t       | [{"channel":"sms","offsetDays":3}]                               | none          |                    0 |                   0 |
 d497fd8a | t       | [{"channel":"sms","offsetDays":3},{"channel":"sms","offsetDays":7},{"channel":"sms","offsetDays":14}] | none | 0 |        0 |
 efd5a336 | t       | [{"channel":"sms","offsetDays":3}]                               | none          |                    0 |                   0 |
(8 rows)

=== late-fee line items on persisted invoices ===
  tenant  | invoice_number  | description | total_cents | amount_due_cents
----------+-----------------+-------------+-------------+------------------
 51c8590d | INV-LF-c91174e2 | Late fee    |        2000 |           102000   ← capped (policy was 5000)
 7c26c84d | INV-LF-bb2693de | Late fee    |        4000 |            84000   ← tenant B
 8e8172bb | INV-LF-df1e9a80 | Late fee    |        2500 |            17500
 c5acfaf1 | INV-LF-badc4731 | Late fee    |        2500 |            17500
(4 rows)
```

Tenant `51c8590d` is the cap case: a flat **5000** policy with a **2000** cap
left exactly one 2000 fee line and `amount_due_cents = 102000` on a 100000
invoice. Tenants `adca1e37` / `d497fd8a` / `566f8de6` / `ad09b4fc` each carry
only the steps their own cadence defines — the per-tenant configuration claim,
in rows.

### Milestone invoices

```
=== milestone invoices (schedule split persisted) ===
  tenant  | schedule | milestone_index | invoice_number | status | total_cents | amount_due_cents
----------+----------+-----------------+----------------+--------+-------------+------------------
 1a7fdde1 | eda86523 |               0 | INV0001        | draft  |        3333 |             3333
 1a7fdde1 | eda86523 |               1 | INV0002        | draft  |        3333 |             3333
 1a7fdde1 | eda86523 |               2 | INV0003        | draft  |        3334 |             3334
 28336660 | 75b8ba7c |               0 | INV0001        | draft  |        3333 |             3333
 5230182f | 54397697 |               0 | INV0001        | draft  |        3333 |             3333
 5230182f | 54397697 |               1 | INV0002        | draft  |        3333 |             3333
 5230182f | 54397697 |               2 | INV0003        | draft  |        3334 |             3334
 a824e9c5 | a301331a |               0 | INV0001        | draft  |        3333 |             3333
 a824e9c5 | a301331a |               1 | INV0002        | draft  |        3333 |             3333
 a824e9c5 | a301331a |               2 | INV0003        | draft  |        3334 |             3334
 ea953a84 | 596dfa46 |               0 | INV0001        | draft  |        3333 |             3333
 ea953a84 | 596dfa46 |               1 | INV0002        | draft  |        3333 |             3333
 ea953a84 | 596dfa46 |               2 | INV0003        | draft  |        3334 |             3334
(13 rows)

=== per-schedule sum vs schedule total ===
  tenant  | schedule | total_amount_cents | milestones_sum | minted
----------+----------+--------------------+----------------+--------
 1a7fdde1 | eda86523 |              10000 |          10000 |      3
 28336660 | 75b8ba7c |              10000 |           3333 |      1   ← milestoneBillingEnabled = false
 5230182f | 54397697 |              10000 |          10000 |      3
 a824e9c5 | a301331a |              10000 |          10000 |      3
 ea953a84 | 596dfa46 |              10000 |          10000 |      3
(5 rows)
```

`milestones_sum === total_amount_cents` for every opted-in tenant, with the
remainder cent (3334) on the last milestone. Tenant `28336660` is the owner-control
case: only the `on_accept` deposit was minted, the balance was never billed.

### Tier-billed invoices

```
=== tier-billed invoices and their line items ===
  tenant  | invoice_number | total_cents | amount_due_cents |      description      | line_cents
----------+----------------+-------------+------------------+-----------------------+------------
 056eac30 | INV0001        |       15000 |            15000 | Diagnostic            |       5000
 056eac30 | INV0001        |       15000 |            15000 | Good — builder heater |      10000
 30d239a7 | INV0001        |       32500 |            32500 | Diagnostic            |       5000
 30d239a7 | INV0001        |       32500 |            32500 | Better — mid heater   |      25000
 30d239a7 | INV0001        |       32500 |            32500 | Haul away old unit    |       2500
 ca78fc9b | INV0001        |       15000 |            15000 | Diagnostic            |       5000
 ca78fc9b | INV0001        |       15000 |            15000 | Good — builder heater |      10000
 e26822e7 | INV0001        |       45000 |            45000 | Diagnostic            |       5000
 e26822e7 | INV0001        |       45000 |            45000 | Best — premium heater |      40000
(9 rows)
```

Three different choices (Better + add-on, Good, Best) on four estimates with
identical option sheets. No invoice carries a tier the customer did not pick,
and none totals 82500 (the whole sheet).

### Memberships

```
=== service_agreements (memberships: term, renewal, price) ===
  tenant  | agreement | price_cents | auto_renew | renewal_term_months |  ends_on   | renewal_count | member_discount_bps |  next_run
----------+-----------+-------------+------------+---------------------+------------+---------------+---------------------+------------
 05731597 | 069eeafe  |        9900 | f          |                     |            |             0 |                   0 | 2026-10-02
 0ace9546 | ae0fad1b  |       19900 | t          |                  12 | 2027-09-11 |             1 |                   0 | 2026-10-12
 14e7ab05 | fa150100  |       19900 | f          |                     |            |             0 |                   0 | 2026-10-12
 28bf36a4 | 1b2001be  |       19900 | f          |                     | 2026-09-10 |             0 |                4000 | 2025-08-08   ← lapsed, ignored
 28bf36a4 | 89b1d4fe  |       19900 | f          |                     | 2027-09-12 |             0 |                 500 | 2025-08-08
 28bf36a4 | 42d44177  |       19900 | f          |                     | 2027-09-12 |             0 |                1500 | 2025-08-08   ← best effective
 65d33566 | 3319b681  |       19900 | t          |                  12 | 2027-07-04 |             3 |                   0 | 2026-10-12   ← 3 terms caught up
 67d44a6e | 6e6172eb  |        4900 | f          |                     |            |             0 |                   0 | 2026-10-12
 68e0b167 | 1c5bbacd  |       19900 | f          |                     |            |             0 |                   0 | 2026-10-12
 81ea2563 | 9b40774a  |       19900 | t          |                  12 | 2027-09-11 |             1 |                   0 | 2026-10-12
 b5b494ba | 9feab5d6  |       19900 | f          |                     |            |             0 |                   0 | 2026-10-12
 bdbd85b6 | bb6e510f  |       19900 | f          |                     |            |             0 |                   0 | 2026-10-12
 bdbdebb3 | e82e258b  |       19900 | f          |                     |            |             0 |                   0 | 2026-10-12
 fa23a847 | 3d8b0bad  |        9900 | f          |                     |            |             0 |                   0 | 2026-10-12
(14 rows)

=== service_agreement_runs (the billed cycles) ===
  tenant  | agreement | scheduled_for |  status   | invoice
----------+-----------+---------------+-----------+----------
 0ace9546 | ae0fad1b  | 2026-09-12    | generated | 66f0715e
 14e7ab05 | fa150100  | 2026-09-12    | generated | ac0c6bbe
 67d44a6e | 6e6172eb  | 2026-09-12    | generated | b42b7e8b
 68e0b167 | 1c5bbacd  | 2026-09-12    | generated | e8391355
 b5b494ba | 9feab5d6  | 2026-09-12    | generated | 2c9c23bc
 bdbd85b6 | bb6e510f  | 2026-09-12    | generated | f517cc89
 bdbdebb3 | e82e258b  | 2026-09-12    | generated | 52f2d64b
 fa23a847 | 3d8b0bad  | 2026-09-12    | generated | 2e2ba200
(8 rows)

=== the dues invoices the sweep wrote (BOTH paths) ===
  tenant  |            invoice_number             | status | total | paid  |  due  | has_due_date
----------+---------------------------------------+--------+-------+-------+-------+--------------
 26bc45f3 | AGREEMENT-1789239749318               | draft  | 19900 |     0 | 19900 | f
 43f6bd6d | AGREEMENT-1789239749671               | draft  | 19900 |     0 | 19900 | f
 530b498f | AGREEMENT-1789239749177               | draft  | 19900 |     0 | 19900 | f
 54c2f791 | AGREEMENT-1789239749772               | draft  | 19900 |     0 | 19900 | f
 83515550 | AGREEMENT-1789239749872               | draft  | 19900 |     0 | 19900 | f
 d2773538 | AGREEMENT-1789239749344               | draft  |  4900 |     0 |  4900 | f
 d8c34481 | AGREEMENT-6ec063d1-…                  | draft  |  9900 |     0 |  9900 | f
 e782c1d9 | AGREEMENT-1789239749725               | draft  | 19900 |     0 | 19900 | f
 fe3d5403 | AGREEMENT-1789239749819               | draft  | 19900 |     0 | 19900 | f
 79ac0a1b | AGREEMENT-1789239749544               | open   | 19900 |     0 | 19900 | t   ← auto-collect, DECLINED
 fba47f2f | AGREEMENT-1789239749412               | paid   | 19900 | 19900 |     0 | t   ← auto-collect, collected
(11 rows)
```

That last table **is** the corrected 8.12 finding, in rows, and it shows both
paths at once. The nine `draft` rows with no due date are the DEFAULT path —
that gap is real. The two rows at the bottom are the auto-collect branch: one
`paid` in full, one left `open` **with a due date** after a 402 decline, which
is exactly the invoice the collections cadence can then chase. An earlier
revision of this report claimed every dues invoice looks like the top nine;
that was wrong, and this dump is what disproves it. The synthetic
`AGREEMENT-` numbering is the one property common to all eleven. (The single
`AGREEMENT-<uuid>` row is the fan-out entry's own port, which uses a uuid
instead of `Date.now()` so a same-millisecond fan-out across tenants cannot
flake the suite; production uses `Date.now()`.)

---

## Verification

```
$ cd packages/api && npx tsc --project tsconfig.build.json --noEmit
(clean — exit 0)

$ npx tsc --project tsconfig.json --noEmit 2>&1 | grep -E "dunning-cadence|late-fee-idempotency|milestone-billing|tier-billed-exactly|membership-renewal-sweep|sweep-tenant-fanout"
(no output — none of this lane's files errors)
```

`tsconfig.json` (which includes test files) has 526 pre-existing errors across
the repo, none of them in files this lane touched. `tsconfig.build.json` — the
one the Railway deploy uses, per CLAUDE.md — is clean.

```
$ git status --porcelain
(empty)
```

---

## Not done / judgment calls

- **No rung is claimed.** Only Fable states a rung.
- **The 8.12 decision is not taken.** What memberships minimally are — whether
  "bills itself" requires issuing the dues invoice, giving it a due date, and
  routing it into the collections cadence — is a story-not-met decision. This
  lane wrote the finding with `file:line` and executable gap-pinning tests, and
  leaves the decision for the orchestrator's decision list. The review round
  narrowed it usefully: the configured auto-collect path already issues with a
  due date, so the open question is whether that is *the* intended path (and the
  default should flip) or whether the default path must stand on its own.
- **Dues auto-collection is now proven up to the Stripe HTTP boundary — my
  first call here was wrong.** I originally wrote that this could not be tested
  at all without a live Stripe credential, "because any collector I could inject
  would be a mock". That conflated two different seams. Injecting a fake
  `DuesCollector` would indeed be *mocked is not proven* — but `stripeFetch`
  (`StripeDuesCollectorDeps.stripeFetch`) replaces only the HTTPS call to
  api.stripe.com, exactly as the deposit-checkout path already does, leaving the
  real collector, the real invoice ops, real `issueInvoice` / `recordPayment`
  and real repositories in the path. That is now done, and it is what caught the
  overstated finding above. What genuinely still needs a Stripe test-mode key is
  narrower: that Stripe's own API accepts the PaymentIntent parameters we send
  (`chargeOffSession`'s request shape) and that decline codes come back in the
  shape we parse. Suggested `blocked-on-josh.md` (#1000) wording, corrected:
  *"§8.12 dues auto-collection — the orchestration is proven at real Postgres
  with `stripeFetch` injected; a Stripe test-mode key in CI would additionally
  pin the PaymentIntent request shape and decline-code parsing against the real
  API."* I did not edit that file — it belongs to #1000's owner.
- **Member pricing is proven at the resolver, not at the application site.**
  `getCustomerMemberDiscountBps` is proven against real rows here. The place the
  discount is actually applied to a document is `src/routes/invoices.ts:175` and
  `src/routes/estimates.ts` — a route-level test, which is a different lane's
  surface. Stated so no one reads this row as "member pricing applied to a
  document, proven".
- **8.10's voice-collections leg (leg 4)** was not re-graded; G1's T1 stands and
  nothing here touches it.
- **8.1 / 8.3 rung-5 reachability** is a browser lane (`qa-matrix`, per the
  #1004 correction on this ticket). Not attempted here.
- **The recurring-agreements worker's missing `failed` counter** (see row 8.12)
  is worker code, not a test, and outside this lane's TEST-ONLY limit. Recorded,
  not fixed.

## Review follow-ups (PR #1053)

`xhawk-ai[bot]` raised two Medium testing findings. Both verified against real
Postgres and both fixed on this branch.

**1. `rawAgreement` was not tenant-scoped** (`membership-renewal-sweep.test.ts`).
The helper ran a bare `SET LOCAL app.current_tenant_id` outside a transaction
and had no `tenant_id` predicate. Verified directly:

```
PG NOTICE/WARNING: SET LOCAL can only be used in transaction blocks
after bare SET LOCAL, GUC = ""
inside BEGIN + set_config(local), GUC = "22222222-2222-2222-2222-222222222222"
```

Postgres discards the setting, and because the integration harness connects as
a superuser (which bypasses RLS outright), the helper read by global id — a
cross-tenant assertion written against it would have passed whichever tenant
was asked for. No assertion in the file was *wrong* (every read is by a unique
agreement id belonging to the tenant asked for), but the helper was not the
evidence it appeared to be.

Fixed: `BEGIN` + `set_config('app.current_tenant_id', $1, true)` + an explicit
`tenant_id = $2` predicate + `COMMIT` (`ROLLBACK` on error). Pinned by a new
assertion in the T1 test — `rawAgreement(tenantB, agreementA)` must be
`undefined` — which was run RED against the old helper first:

```
 × T1 — two tenants are renewed and billed on their own memberships in one pass, with no cross-tenant reach 109ms
   → expected { ends_on: '2027-09-11', …(3) } to be undefined
 Tests  1 failed | 8 passed (9)
---
 Tests  12 passed (12)
```

The same bare-`SET LOCAL` pattern in `dunning-cadence.test.ts`'s raw duplicate
INSERT got the same treatment. That test's evidence is unaffected either way —
the `23505` comes from the unique index, and a superuser bypasses RLS — but the
line implied a tenant scoping that was not happening.

**2. The two writing fan-out tests swept every tenant in the shared container**
(`sweep-tenant-fanout.test.ts`). Both now assert `listAllTenantIds(pool)`
contains their seeded tenants — keeping the D-032 "production selector" claim —
and then drive the sweep with only those ids. The seam tests above them still
run the real enumerator across the whole database, so no reach claim is lost;
what goes away is a writing sweep raising dunning rows and billing cycles on
other integration files' tenants. I did not touch the pre-existing
`estimate-expiry` untouched test, which has the same shape — not this lane's,
and worth its own call.

Note on the bot's stated failure mode ("if this fan-out test runs before a
membership test asserts its first sweep generated exactly one run"): that
specific ordering cannot bite, because vitest runs integration files
sequentially and atomically (`maxWorkers: 1`), so a stranger tenant either does
not exist yet or has already finished asserting. The *structural* hazard it
points at is real, though — the tests wrote to rows they do not own, and their
correctness rested on that scheduling accident. Fixed on that basis.

## Money defects found and NOT fixed

All three are in the membership path and all are outside this lane's TEST-ONLY
limit. Each has an executable test in
`test/integration/membership-renewal-sweep.test.ts`.

**Scope correction (PR #1053 review).** Findings 1 and 2 were first written as
universal. They are not: they hold on the **default** path
(`autoCollectDues: false`, which is what `createAgreement` produces unless the
owner opts in) and for an opted-in member with **no saved card**. A
fully-configured auto-collect membership issues the dues invoice with a 30-day
due date before charging, and a decline leaves it open and dunnable — proven in
the auto-collect block of that file. Finding 3 holds on both paths.

1. **Membership dues are not collectable without a human on the default path.**
   The dues invoice is written `draft` (`src/invoices/invoice.ts:336` via
   `src/agreements/agreement-service.ts:402`) and, absent auto-collect with a
   saved card, is never issued or sent.
2. **Those dues invoices can never go overdue.** No `dueDate` is set
   (`src/app.ts:5689-5710`), so the overdue sweep's prefilter
   (`src/workers/overdue-invoice-worker.ts:163-172`) can never select them — the
   cadence proven in row 8.9 is unreachable for default-path membership revenue.
   The severity question this raises is how many real memberships sit on the
   default path, which is an owner question, not a lane one.
3. **Membership dues invoices are outside the tenant's invoice sequence**
   (`src/app.ts:5693`, `AGREEMENT-${Date.now()}`), leaving a hole in the tenant's
   books and a latent `idx_invoices_number` collision for two agreements billed
   in the same millisecond. This one holds on **both** paths — the auto-collect
   branch issues the same synthetic number.
