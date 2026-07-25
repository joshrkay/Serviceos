# RIVET_MONEY_SPEC — Invoicing, Payments & Reconciliation

**Companion to `.rivet/RIVET_GOAL_PRODUCTION_v2.md` and `spec/RIVET_FOUNDATION_SPEC.md`.**
Those define the voice gate and the configuration gate. This one defines the **money
gate**: whether every cent the system records matches the cents that actually moved.

**Grounded in extraction, not intent.** Every gate, vector, and code pin below traces to
`RIVET_MONEY_EXTRACTION_FINDINGS.md` — a read-only sweep of the money surface run before
this spec existed. Where the extraction found no evidence, this spec asserts nothing. That
sequencing is deliberate: the comms gate was rewritten four times because its gates were
written from spec intent and kept colliding with the code.

**Why money needs its own gate.** Payment defects fail silently. A float leak, a rounding
drift, or a double-applied webhook passes every functional test and surfaces days later as
a reconciliation discrepancy — not a red test. The foundation gate can assert that a slot
is bookable; nothing in the voice or foundation gate asserts that the money is right.

**Scope:** registry ops in the invoice, estimate, and payment domains, plus
estimate→invoice conversion, refunds, tax, the Stripe webhook surface, and the S3 customer
payment surface where the loop actually closes.

**State:** `.rivet/money_state.json`

---

## 1. Goal Statement

> Every monetary amount the system stores recomputes exactly from its inputs, in integer
> cents, at every layer; and every capture Stripe performs has a matching local record.
> Discrepancy is **detected by a sweep**, not discovered in a reconciliation months later.

Money correctness is not "the tests pass." It is an arithmetic identity that holds on
every row, re-derived every iteration.

---

## 2. The Reconciliation Ladder

Money state is invoice + payment rows plus denormalized balance columns. **There is no
ledger and no double-entry construct** — the extraction answered that question rather than
assuming it. But the absence of a ledger does not reduce this to row-level correctness.
Five layers are assertable, four of them today:

```
L1  line.total_cents          == round(quantity × unit_price_cents)
L2  invoice.subtotal_cents    == Σ(line.total_cents)
    invoice.tax_cents         == round((taxable_subtotal − discount) × tax_rate_bps / 10000)
    invoice.total_cents       == subtotal − discount + tax + processing_fee
L3  invoice.amount_paid_cents == Σ(active payments.amount_cents)      ← convention-dependent
    invoice.amount_due_cents  == max(0, total_cents − amount_paid_cents)
L4  invoice.amount_paid_cents <= invoice.total_cents
L5  payload->'object'->>'amount_total'
      == Σ(payments.amount_cents WHERE provider_reference = :ref)     ← cross-system
```

**Each layer catches a class the layer below cannot.**

- **L4 is not redundant with L3.** Concurrent full-balance credits inflate
  `amount_paid_cents` *and* write matching payment rows, so the sum still agrees and L3
  passes on an overpaid invoice. Only L4 sees it.
- **L5 is not redundant with L3/L4.** Both are internal identities; neither can see money
  Stripe holds that the database never recorded. L5 is the only layer that compares
  against the outside world, and it is assertable today because `webhook_events.payload`
  is `JSONB NOT NULL` — every captured amount is already durably stored and simply never
  compared.

**L3 is convention-dependent and currently undefined** — see §6 and D-M1.

### L5 implementation constraints

Two details, both load-bearing. A sweep that gets either wrong reports clean while
detecting nothing, which is worse than no sweep at all:

1. **The payload is nested.** The Stripe route persists `event.data`, not the event, so the
   stored shape is `{ object: { amount_total, payment_intent, … } }`. Read
   `payload->'object'->>'amount_total'`. `payload->>'amount_total'` is NULL on every row.
2. **The join key is not always trustworthy.** `provider_reference` falls back to the
   literal `'stripe_checkout'` when `payment_intent` is absent, and that literal collides
   tenant-wide. Such rows are **unverifiable, not passing** — the sweep must report them as
   an explicit coverage hole. Full L5 coverage therefore depends on fixing the literal
   fallback first.

---

## 3. Money Type Discipline

The stated core pattern is *"all money: integer cents, never floating point."* The
extraction verified it empirically rather than trusting it, and found it **holds on the
server and at the Stripe boundary, and is violated in the write path**.

| Layer | Verdict |
|---|---|
| DB columns | integer cents throughout (`INTEGER`/`BIGINT`; no `float`, `real`, `double precision`, `money`, `decimal`) |
| Domain / mapper | integer cents; `pg` bigint-as-string correctly wrapped |
| Stripe boundary | `String(<integer cents>)` behind `Number.isInteger` guards at all six outbound sites |
| API response | integer cents on the wire; division by 100 only inside formatters |
| **Web write path** | **float dollars** — client computes `Math.round(qty × rate × 100)`, server persists verbatim |

**The invariant to sweep is the write path, not the schema.** A schema-only check passes
today and always will. The defect is that no REST path recomputes a line total from
`quantity × unit_price_cents`; the server validates `totalCents` as an *integer shape* and
then sums the client's numbers.

**Scope the float rule to monetary amounts.** A non-monetary multiplier (`quantity`, an
unscaled `NUMERIC`) feeding a money computation is **not** a violation when its product is
immediately rounded to whole cents — that is the normal fractional-line-item case.
Escalate only when the rounding is absent, deferred, or applied inconsistently across call
sites. The unscoped version of this rule fires on every ordinary invoice.

---

## 4. Idempotency Has Two Halves

The `(source, idempotency_key)` unique index is real and arbitrates **first delivery**
correctly. It does nothing for **retries**.

| | Mechanism | Verdict |
|---|---|---|
| First delivery | DB unique index + `ON CONFLICT DO NOTHING` + lost-race guard | sound |
| Retry execution | status read only — no CAS, no claim, no `FOR UPDATE` | **unclaimed** |

Two concurrent retries of the same `failed` or stale event both receive `duplicate: false`
and **both run the handler**. The index prevents duplicate *receipt rows*, not duplicate
*execution*. Every per-handler idempotency guard is therefore load-bearing on its own, and
the ones that are check-then-act rather than compare-and-swap fail here.

**This means the money gate needs two distinct idempotency assertions** — a redelivery
gate (a second *delivery* is a no-op) and a retry-concurrency gate (a second *retry* is).
Only the first holds today.

---

## 5. Where Money Is Lost

Two paths let Stripe capture money the database has no row for. Both are in scope for L5
and both are currently live.

**Post-void capture.** The void path writes `status` and `updated_at` and nothing else;
the payment link id is never cleared by any code path. A customer paying a post-void link
has the money captured, `recordPayment` throws on the status, the webhook catch matches the
message, logs *"already settled, ignoring"*, and ACKs 200.

**Stale-link capture — no void and no race required.** A link minted for the full balance
is never re-priced or deactivated when the balance drops by any other route (manual
payment, deposit credit, Terminal charge). Stripe captures the *original* amount; the
handler caps the credit to the current balance and **discards the difference**, or records
nothing at all if the invoice is already paid. Every branch then marks the event processed.

Capping the invoice credit is correct — over-crediting would be worse. The defect is that
**there is no over-payment or credit-balance concept anywhere**, so the excess has nowhere
to go. That is a product decision (D-M3), not a bug fix.

---

## 6. The Convention Problem

`amount_paid_cents` has **two live definitions**:

| Path | Convention |
|---|---|
| Stated invariant + reversal reconciler | refund-**inclusive** (refunds do not subtract) |
| `reconcileInvoiceFromPayments` | refund-**net** (refunds subtract) |

The increase-only guard does not prevent the divergence, because the crash that triggers
repair is exactly the one that leaves the balance stale-low.

**Neither convention is wrong in isolation** — net is arguably the economically correct
number; inclusive is what the rest of the system assumes. The defect is the disagreement.

**L3 cannot be swept until one convention is ratified** (D-M1). Sweeping it now would
assert a rule the codebase does not uniformly hold, and every L3 result would be noise —
the same reasoning that puts the constraint check ahead of the gate check in the
foundation loop.

---

## 7. Validation Vectors

Extends V1–V11 (`RIVET_OPERATION_CONTRACTS.md` §4), V15–V18 (foundation), V19–V23 (comms).

| ID | Vector | Discipline |
|---|---|---|
| **V24** | **Interleaving** | Genuinely parallel money operations on distinct connections with overlapping transactions. Every one of the concurrency defects found was invisible to single-path tracing. **Sequential tests do not satisfy V24** — an awaited loop never opens the window. Minimum set: two full-balance payments on one invoice; a credit racing a deposit-credit read-modify-write; two retries of one webhook event; a payment racing a void. |
| **V25** | **Error-branch coverage** | Every `catch` and recovery branch on a money path must be exercised with the error it handles. This vector exists because the largest defect found sits in a `catch` block — the success path is correct and the recovery path silently drops money. A branch that only runs under failure is where money goes missing precisely because nobody looks there. |
| **V26** | **External-state divergence** | The local record vs. what the payment provider holds: a link whose amount no longer matches the balance, a capture with no local row, a refund issued outside the product. Assert against the stored webhook payload (L5), not against a mocked provider. |
| **V27** | **Convention consistency** | Every code path computing a balance must implement the same refund convention. Falsify by construction: seed the crash-repair interleave and assert both reconcilers converge on the same value. |

V24 and V25 are the two blind spots the extraction's own review exposed. They are
first-class vectors rather than notes because every late defect found fell into one of
them, and neither is reachable by reading paths in isolation.

---

## 8. Gates

| | Condition | Type |
|---|---|---|
| **M1** | L1+L2 arithmetic — every line total and document total recomputes to the stored value, to the cent, across all invoices and estimates | **binary** |
| **M2** | L3 balance — `amount_paid_cents == Σ(active payments)` under the ratified convention | **binary**, blocked on D-M1 |
| **M3** | L4 — no invoice where `amount_paid_cents > total_cents`, under V24 contention | **binary** |
| **M4** | L5 — every processed capture fully recorded; `'stripe_checkout'` rows reported as coverage holes, never as passes | **binary** |
| **M5** | Money type — no monetary amount crosses a float on any write path; no unrounded monetary result persisted | **binary** |
| **M6** | State machine — no forbidden transition; void invalidates outstanding payment links; estimate→invoice idempotent on every path | quality |
| **M7** | Idempotency — redelivery *and* retry-concurrency both no-op (V24) | quality |
| **M8** | Refund — cumulative over-refund guard holds under V24; no double-apply by either id-tracking or timing | quality |
| **M9** | Tax & discount — rounding point stable; discount proportioning on mixed-taxability invoices matches the ratified rule (D-M4) | quality |
| **M10** | Money-table RLS clean; every money-path query pinned by a Docker-gated integration test, not a mocked Pool | quality |

M1–M5 are binary invariants: any regression halts the loop immediately, same posture as
P3/P4 (production) and F1–F3 (foundation).

**M1 and M3–M5 fail today.** That is expected and is the point — the gate is grounded in
a real inventory, so the first run has real work rather than a green sweep that proves
nothing.

---

## 9. The Loop

```
0  CONVENTION CHECK  [Haiku]   D-M1 ratified? else M2 is unrunnable — skip M2,
                               continue, and report it as BLOCKED (never as pass)
1  GATE CHECK        [Haiku]   M1–M10; all clean → CONVERGED
2  VERIFY            [Opus V24/V25 · Sonnet rest]   failing gates only
3  INVARIANT SWEEP   [Opus]    M1, M3, M4, M5 re-run every iteration regardless
                               of status — arithmetic and capture identities
                               regress silently from unrelated changes
4  REMEDIATE         [Sonnet]
5  VALIDATE          [Haiku]   re-run affected gates + V24 contention always
6  CONVERGE          M1/M3/M4/M5 regression → HALT NOW
                     passing count flat 2 iterations → HALT
                     iteration ≥ 6 → HALT
```

**Step 0 precedes the gate check deliberately.** Without a ratified convention, an L3
sweep asserts a rule the code does not uniformly hold, and its results are noise. Report
M2 as BLOCKED and keep going — do not let a blocked gate stall the four that are runnable.

**Step 3 is not redundant with step 1.** M1 and M5 are properties of every row and every
write path; a fix anywhere in invoicing can break them without touching anything that
looks related. Re-sweep every pass.

**Tier demotion is the thing to watch**, same as the production gate. An agent that cannot
make M3 pass will propose reclassifying it to quality. Log every proposed reclassification
with its direction; only a human may demote a binary gate.

---

## 10. Command Surface

| Command | Effect |
|---|---|
| `/goal money` | Full convergence loop |
| `/goal money arithmetic` | L1+L2 sweep (M1) |
| `/goal money balance` | L3+L4 sweep (M2/M3) |
| `/goal money capture` | L5 cross-system reconciliation (M4) |
| `/goal money type` | Write-path float sweep (M5) |
| `/goal money concurrency` | V24 interleaving run (M3/M7/M8) |
| `/goal money branches` | V25 error-branch coverage (M4/M6) |
| `/goal money ratify` | **Human only** — freeze D-M1..D-M4 |
| `/goal money status` | Read state, report, no action |

`ratify` is human-only for the same reason as the production gate: the convention choice
in D-M1 changes what "correct" means, and an agent that cannot make M2 pass would
otherwise pick whichever convention makes the sweep green.

---

## 11. Decisions Blocking Convergence

| ID | Decision | Blocks |
|---|---|---|
| **D-M1** | Refund convention — `amount_paid` refund-**inclusive** (current stated invariant) or refund-**net** (what one reconciler implements). Both defensible; the defect is that both exist. | **M2** |
| **D-M2** | Void history — add a `voided_at` column or a void audit event. Neither exists, and `updated_at` is overwritten by later writes, so no post-void assertion is currently evaluable. | post-void scoping in **M6** |
| **D-M3** | Over-payment semantics — should a credit balance exist? Today an excess capture has nowhere to go and is discarded. Remediating M4 requires knowing where the money should land. | remediation of **M4** |
| **D-M4** | Discount proportioning — on a mixed-taxability invoice, should a discount reduce the taxable base in full (current) or proportionally? Current behavior under-taxes. | **M9** |

D-M1 and D-M3 are product decisions, not defects to fix. The loop reports them and halts
on them rather than choosing.

---

## Appendix A — Code Pinning

From the extraction survey against the working tree (2026-07-25); re-pin when files move.
Full evidence in `RIVET_MONEY_EXTRACTION_FINDINGS.md`. Live gate status:
`.rivet/money_state.json`.

| Concern | Where |
|---|---|
| Money columns (M5) | `packages/api/src/db/schema.ts` — invoices `:627-634`, line items `:660-662`, payments `:679`, `:2647` |
| Billing engine (M1/M9) | `packages/api/src/shared/billing-engine.ts` — `calculateLineItemTotal` `:78-80`, `applyBps` `:89-91`, `calculateDocumentTotals` `:93-124` |
| Write-path float leak (M5) | `packages/api/src/shared/contracts.ts:114` (shape-only validation); web `LineItemEditor.tsx:79-80`, `EstimatesPage.tsx:88-89`, `InvoicesPage.tsx:77-78`, `NewEstimateFlow.tsx:1300-1306` |
| Safe AI/voice path (M5 contrast) | `packages/api/src/invoices/invoice-editor.ts:74-86` — `buildLineItem` → `calculateLineItemTotal` |
| Balance columns + writers (M2/M3) | `pg-invoice.ts` — `incrementAmountPaidAtomic` `:309-337`, `decrementAmountPaidAtomic` `:339-374`, generic absolute setters `:214-221` |
| Read-modify-write balance writer (V24) | `packages/api/src/invoices/deposit-credit.ts:122-132` |
| Conflicting reconcilers (M2/V27) | refund-net `packages/api/src/invoices/payment.ts:38-40`; refund-inclusive `payments/payment-service.ts:234-237`, `:239-273` |
| Payment guards (M3) | `packages/api/src/invoices/payment.ts:470-480` — check-then-act against a stale read |
| Webhook idempotency (M7) | `packages/api/src/webhooks/webhook-handler.ts` — `classifyExisting` `:142-151`, `handleWebhookEvent` `:153-211`; index `schema.ts:275` |
| Stored capture payload (M4/L5) | `packages/api/src/db/schema.ts:269` (`payload JSONB NOT NULL`); persisted from `event.data` at `webhooks/routes.ts:921-926` |
| Capture-loss branches (M4/V25) | `packages/api/src/webhooks/routes.ts:1184-1221` — cap-and-discard `:1188-1207`, record-nothing `:1189-1190`, status branch `:1212-1214` |
| Provider-reference collision (M4 coverage) | `packages/api/src/webhooks/routes.ts:1143-1150` — `'stripe_checkout'` literal fallback |
| Void path (M6/D-M2) | `packages/api/src/invoices/invoice.ts:406-431`; transitions `:163-176`; status route `routes/invoices.ts:556-567` (no audit emission) |
| Payment-link lifecycle (M6) | `payments/stripe-payment-link.ts:81` (`deactivateLink`, three callers, none the void path); mint sites `invoices/public-invoice-service.ts:215`, `estimates/public-estimate-service.ts:863` |
| Refund path (M8) | `payments/payment-service.ts:77` (`recordRefund`), `:93-106` (latest-id guard); `invoices/pg-payment.ts:247-268` (cumulative DB guard) |
| Money-table RLS (M10) | verified clean — `test/db/schema.test.ts:119,134`, `test/integration/rls-force-catalog.test.ts:39-97` |
| Ungrounded mocked-Pool tests (M10) | `test/estimates/pg-approval.test.ts`, `test/reputation/pg-service-credit.test.ts` — no integration counterpart |
| Test convention | new money integration tests → `packages/api/test/integration/<feature>.test.ts`, `getSharedTestDb`/`createTestTenant` pattern |

---

## Appendix B — Honest Constraints

**M4 cannot reach full coverage before the provider-reference collision is fixed.** The
join key is ambiguous on any row using the `'stripe_checkout'` literal. The sweep must
report those as a coverage hole rather than silently passing them, and the hole closes only
when the fallback is replaced with a unique reference.

**L5 compares against stored webhook payloads, not against Stripe.** It catches captures
the database failed to record from events it *received*. It cannot catch a capture whose
webhook never arrived. True provider reconciliation needs a Stripe-side pull, which is out
of scope here and worth stating so the gate is not mistaken for one.

**V24 is the vector most likely to be faked.** A sequential loop of awaited operations
will pass and prove nothing — the same failure the foundation gate calls out for V16. Every
concurrency defect on this surface was invisible to single-path reading, so a V24 suite
that does not open real windows leaves the largest defect class unverified.

**M1 will fail on historical rows.** The float leak has been writing drifted line totals
for as long as the web editor has existed. The sweep will surface pre-existing bad data
alongside the code defect; those are two separate remediations, and the gate should
distinguish "the code now computes correctly" from "existing rows have been corrected."
