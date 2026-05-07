# Invoice Agent — Implementation Roadmap

Phase 9 in the gap-story sequence. Targets `claude/audit-serviceos-codebase-d3XrH` and follows the wave dispatch pattern from `docs/superpowers/contracts/p0-dispatch-addendum.md`.

**Migration reservations:** 055-058 (the customer-followup agent reserved 050-054).

## Dependencies

| Depends on | Why |
|---|---|
| Existing `packages/api/src/invoices/*` | All invoice domain skills already exist |
| Existing `packages/api/src/payments/*` | Stripe payment links + reconciler |
| Existing `packages/api/src/proposals/{handlers,contracts}/issue-invoice` | Proposal handler reused |
| Phase 8 customer-followup agent | Out-bound email/SMS for issued/overdue/failed invoices |
| Shared billing engine | Tax + total computation |

## Wave plan

```
Wave 9A — foundations (parallel, 4 stories)
  P9-001  invoice agent state machine module
  P9-002  invoice idempotency + tenant invoice-number sequence
  P9-003  Stripe webhook → agent event bridge (paid / failed / disputed / refunded)
  P9-004  bad-debt ledger schema + write-off skill

Wave 9B — orchestration (parallel after 9A merges, 3 stories)
  P9-005  auto-approve policy + tenant settings
  P9-006  void invoice flow (Stripe link expiry + DB update)
  P9-007  reconcile-late-payments sweep cron

Wave 9C — UX + render (parallel after 9B, 2 stories)
  P9-008  invoice HTML render (v1) + hosted view route
  P9-009  invoice agent dashboard panel (states timeline)

Wave 9D — gates (sequential after 9C, 1 story)
  P9-010  agent ON flag + tenant rollout controls
```

Total stories: **10**. Estimated wall-clock: **~2 days** with parallelism (most skills wrap existing code).

## Story specs

---

### P9-001 — Invoice agent state machine module

**Status:** new
**Allowed files:**
- `packages/api/src/agents/invoice/state-machine.ts` (new)
- `packages/api/src/agents/invoice/types.ts` (new)
- `packages/api/src/agents/invoice/index.ts` (new — barrel)
- `packages/api/src/agents/invoice/state-machine.test.ts` (new)

**Forbidden files:** anything outside `packages/api/src/agents/invoice/`.

**Spec:**
- Implement the typed state machine from `flow.md` as a pure function `transition(state, event, context) → { nextState, sideEffects }`.
- `sideEffects` is a typed array of skill calls to perform (no I/O inside the transition function — testable in isolation).
- Property test: every (state, event) pair from the transition table.
- All `IllegalTransition` errors include `{ from, event, tenantId, invoiceId }` for audit.

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/invoice/state-machine.test.ts --coverage
```
Coverage gate: 100% branch on the transition table.

---

### P9-002 — Invoice idempotency + tenant invoice-number sequence

**Status:** new
**Allowed files:**
- `packages/api/src/db/schema.ts` (add migration 055)
- `packages/api/src/agents/invoice/create-draft.ts` (new)
- `packages/api/src/agents/invoice/invoice-number.ts` (new)
- `packages/api/src/agents/invoice/create-draft.test.ts` (new)

**Migration 055:**
```sql
CREATE TABLE invoice_idempotency (
  tenant_id UUID NOT NULL,
  source TEXT NOT NULL,          -- 'job_completed' | 'estimate_accepted' | 'manual' | 'ai_proposal'
  source_ref TEXT NOT NULL,
  invoice_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, source, source_ref)
);
ALTER TABLE invoice_idempotency ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_iso ON invoice_idempotency USING (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE TABLE tenant_invoice_counter (
  tenant_id UUID PRIMARY KEY,
  next_seq BIGINT NOT NULL DEFAULT 1
);
ALTER TABLE tenant_invoice_counter ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_iso ON tenant_invoice_counter USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

**Spec:**
- `createInvoiceDraft({source, sourceRef, ...})` — `INSERT ... ON CONFLICT (tenant_id, source, source_ref) DO NOTHING RETURNING *`. If conflict, return existing.
- `allocateInvoiceNumber(tenantId)` — `UPDATE tenant_invoice_counter SET next_seq = next_seq + 1 WHERE tenant_id = $1 RETURNING next_seq - 1`. Wraps in a transaction with the issue.
- Format: `INV-{yyyy}-{seq:06d}` (configurable per tenant in v2).

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/invoice/create-draft.test.ts src/agents/invoice/invoice-number.test.ts
```

---

### P9-003 — Stripe webhook → agent event bridge

**Status:** new (extends existing `payments/stripe-webhook-handler.ts`)
**Allowed files:**
- `packages/api/src/payments/stripe-webhook-handler.ts` (modify — extend event handling)
- `packages/api/src/agents/invoice/handle-payment-failed.ts` (new)
- `packages/api/src/agents/invoice/handle-dispute.ts` (new)
- `packages/api/src/agents/invoice/apply-payment.ts` (new — wraps reconciler)
- `packages/api/src/payments/stripe-webhook-handler.test.ts` (modify)

**Spec:**
- Existing handler already processes `payment_intent.succeeded` for reconciliation. Extend to:
  - `payment_intent.payment_failed` → call `handlePaymentFailed`
  - `charge.dispute.created` → call `handleDispute`
  - `charge.refunded` → call reconciler in negative-payment mode
- All paths gated by `webhook_idempotency` dedupe (already present, verify).
- All paths emit a typed agent event `payment.received | payment.failed | payment.disputed | payment.refunded` to the invoice agent state machine.

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/payments/stripe-webhook-handler.test.ts src/agents/invoice/
```

---

### P9-004 — Bad-debt ledger schema + write-off skill

**Status:** new
**Allowed files:**
- `packages/api/src/db/schema.ts` (migration 056)
- `packages/api/src/agents/invoice/write-off-invoice.ts` (new)
- `packages/api/src/agents/invoice/write-off-invoice.test.ts` (new)

**Migration 056:**
```sql
CREATE TABLE bad_debt_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  amount_cents BIGINT NOT NULL,
  reason TEXT NOT NULL,
  written_off_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  written_off_by UUID NOT NULL
);
ALTER TABLE bad_debt_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_iso ON bad_debt_ledger USING (tenant_id = current_setting('app.tenant_id')::uuid);
CREATE INDEX bad_debt_ledger_tenant_invoice_idx ON bad_debt_ledger(tenant_id, invoice_id);
```

**Spec:**
- Owner-only RBAC check (`requireRole('owner')`).
- Marks invoice `written_off`. Inserts ledger row. Pauses follow-ups for that invoice.

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/invoice/write-off-invoice.test.ts
```

---

### P9-005 — Auto-approve policy + tenant settings

**Status:** new
**Allowed files:**
- `packages/api/src/db/schema.ts` (migration 057 — adds columns to `tenant_settings`)
- `packages/api/src/agents/invoice/auto-approve.ts` (new)
- `packages/api/src/agents/invoice/auto-approve.test.ts` (new)
- `packages/web/src/pages/SettingsBilling.tsx` (modify — add toggle + cap input)

**Migration 057:**
```sql
ALTER TABLE tenant_settings
  ADD COLUMN invoice_auto_approve_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN invoice_auto_approve_max_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN invoice_auto_approve_min_confidence NUMERIC(3,2) NOT NULL DEFAULT 0.90;
```

**Spec:** see `skills.md → check_auto_approve` policy. Default OFF. UI exposes the toggle + cap.

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/invoice/auto-approve.test.ts
```

---

### P9-006 — Void invoice flow

**Status:** new
**Allowed files:**
- `packages/api/src/agents/invoice/void-invoice.ts` (new)
- `packages/api/src/payments/stripe-payment-link.ts` (modify — add `expirePaymentLink`)
- `packages/api/src/routes/invoices.ts` (modify — add `POST /:id/void`)
- `packages/api/src/agents/invoice/void-invoice.test.ts` (new)

**Spec:**
- Reject if `state ∈ {paid, voided, written_off, refunded}`.
- Call Stripe to expire payment link.
- Audit + emit `invoice.voided`.
- `customer-followup` agent must skip pending reminders for voided invoices (the `pre_send_validate` skill re-checks invoice state — so this is automatic if 8D shipped).

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/invoice/void-invoice.test.ts
```

---

### P9-007 — Reconcile-late-payments sweep cron

**Status:** new
**Allowed files:**
- `packages/api/src/agents/invoice/reconcile-sweep.ts` (new)
- `packages/api/src/workers/scheduler.ts` (modify — register cron)
- `packages/api/src/agents/invoice/reconcile-sweep.test.ts` (new)

**Spec:**
- Run every 15 minutes (`*/15 * * * *`). Per-tenant lookback 24h.
- Query Stripe `payment_intents` w/ `metadata.tenant_id` set, `status=succeeded`, `created>=now-24h`.
- For each, ensure local `record_payment` exists; if not, call `apply_payment` synthetically.
- Emit `invoice.late_reconciled` audit on every catch.
- Stuck-payments dashboard panel surfaces `metadata.invoice_id` not found in our DB (data-integrity alert).

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/invoice/reconcile-sweep.test.ts
```

---

### P9-008 — Invoice HTML render + hosted view

**Status:** new
**Allowed files:**
- `packages/api/src/agents/invoice/render-invoice.ts` (new)
- `packages/api/src/routes/invoice-view.ts` (new — public token-gated route)
- `packages/api/src/db/schema.ts` (migration 058 — adds `invoice.view_token`)
- `packages/web/src/pages/InvoiceView.tsx` (new — minimal hosted view, no auth)

**Migration 058:**
```sql
ALTER TABLE invoices
  ADD COLUMN view_token TEXT UNIQUE,
  ADD COLUMN html_snapshot TEXT;
```

**Spec:**
- v1 = HTML only. Generate at issue time, store snapshot, hand back URL `/i/:viewToken`.
- View token is 32-char URL-safe random. Token-gated, no auth required (link is the cap-token).
- Email/SMS sent by followup agent links to this URL.
- v2 work: PDF rendering (out of scope for now).

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/invoice/render-invoice.test.ts src/routes/invoice-view.test.ts
```

---

### P9-009 — Invoice agent dashboard panel

**Status:** new
**Allowed files:**
- `packages/web/src/pages/InvoiceDetail.tsx` (modify — add states timeline)
- `packages/web/src/components/InvoiceTimeline.tsx` (new)
- `packages/api/src/routes/invoices.ts` (modify — add `GET /:id/audit`)
- `packages/web/src/pages/InvoiceDetail.test.tsx` (modify)

**Spec:**
- Timeline component renders state transitions from `invoice_audit` rows.
- Each row shows: timestamp, actor, from→to state, reason.
- Top of detail page shows current state badge with color coding.

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && cd ../web && npm run typecheck && npm run test -- src/pages/InvoiceDetail.test.tsx
```

---

### P9-010 — Agent ON flag + tenant rollout

**Status:** new (gate)
**Allowed files:**
- `packages/api/src/agents/invoice/index.ts` (modify — add `isAgentEnabled(tenantId)` guard)
- `packages/api/src/db/schema.ts` (no migration — uses existing feature_flags table)
- `packages/web/src/pages/SettingsBilling.tsx` (modify — add agent ON/OFF toggle for owners)
- `packages/api/src/agents/invoice/index.test.ts` (new)

**Spec:**
- Feature-flag-gated: default OFF for all tenants.
- When OFF: legacy code path (existing manual invoice flow in `routes/invoices.ts`) handles everything.
- When ON: `routes/invoices.ts` delegates to agent `transition()` for all state changes.
- Migration is reversible — flipping OFF returns control to legacy path.

**Verification gate:**
```bash
cd packages/api && npx tsc --project tsconfig.build.json --noEmit && npx vitest run src/agents/invoice/index.test.ts
```

## Cross-cutting checks (CI gate before agent ON)

- [ ] All P9 stories merged
- [ ] Test plan happy paths H-1 through H-7 green in integration suite
- [ ] State-machine completeness 100% branch coverage
- [ ] Stripe test-mode webhook smoke test passing
- [ ] Bad-debt ledger migration applied to staging
- [ ] Auto-approve default OFF verified across staging tenants
- [ ] Reconcile sweep registered + running in staging worker logs

## Out of scope (deferred to later phases)

- **PDF rendering** (Phase 10 — Puppeteer or pdfkit)
- **Multi-currency** (Phase 10)
- **Refund flow** (Phase 10 — adds `refunding`/`refunded` states)
- **Late fees auto-rule** (Phase 11 — followup-agent extension)
- **Multi-jurisdiction tax** (Phase 11 — Stripe Tax integration)
- **Recurring invoices / subscriptions** (Phase 12)
