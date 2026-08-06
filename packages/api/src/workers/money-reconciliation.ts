/**
 * Money-invariant reconciliation sweep (L2–L5) — READ-ONLY detector.
 *
 * Grounded in RIVET_MONEY_EXTRACTION_FINDINGS.md ("What /goal money can and
 * cannot assert"): invoice balances are maintained as stateful counters with
 * no scheduled job verifying them. This worker recomputes the codebase's own
 * stated invariants from the tables on a timer and REPORTS drift — it never
 * repairs, never mutates money rows, never touches proposals. Its only writes
 * are audit events (the standard "all mutations emit audit events" channel,
 * used here to make detected drift durable and queryable).
 *
 * Gates, per tenant per tick:
 *   L1 (informational) — line.total_cents == round(quantity × unit_price_cents).
 *       Legacy pre-normalization rows exist (P0-2), so this is a COUNT in the
 *       summary, never a per-row alert.
 *   L2 — invoice.subtotal_cents == Σ(line.total_cents), and
 *       invoice.total_cents == max(0, subtotal − discount + tax +
 *       processing_fee) — mirrors calculateDocumentTotals in
 *       shared/billing-engine.ts including its floor-at-zero clamp.
 *   L3 — invoice.amount_paid_cents == Σ(payments.amount_cents WHERE status IN
 *       ('completed','processing') AND reversed_at IS NULL). Refund-INCLUSIVE
 *       (P0-7 settled): refunded_amount_cents is deliberately NOT subtracted,
 *       matching reconcileInvoiceAfterReversal / reconcileInvoiceFromPayments.
 *   L4 — invoice.amount_paid_cents <= invoice.total_cents. Not redundant with
 *       L3: concurrent double-credits (P0-6) write matching payment rows, so
 *       L3 passes while the invoice is overpaid.
 *   L5 — for processed checkout.session.completed webhook_events,
 *       payload->'object'->>'amount_total' == Σ(payments.amount_cents WHERE
 *       provider_reference = payload->'object'->>'payment_intent'). The
 *       payload is NESTED under 'object' (the route persists event.data — see
 *       P0-9); rows whose derived reference is missing or the legacy
 *       'stripe_checkout' literal (P0-5) are UNVERIFIABLE, never pass/fail.
 *
 * Tenant safety: follows the overdue-invoice sweep pattern — app.ts hands in a
 * listTenantIds() over the raw pool, and every per-tenant read runs through
 * PgBaseRepository.withTenant (SET LOCAL app.current_tenant_id) with explicit
 * tenant_id predicates as defense-in-depth, exactly like the Pg repositories.
 *
 * The sweep cadence is owned by app.ts (setInterval + runAsLeader advisory
 * lock, MONEY_RECONCILIATION_INTERVAL_MS). Tests exercise the pure gate
 * arithmetic directly and the sweep with a fake reader; the SQL is pinned by
 * test/integration/money-reconciliation.test.ts.
 */
import { Pool } from 'pg';
import { Counter } from 'prom-client';
import { PgBaseRepository } from '../db/pg-base';
import { metricsRegistry } from '../monitoring/metrics';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { Logger } from '../logging/logger';

/** Synthetic actor for sweep-emitted audit events (no Clerk session). */
const RECONCILIATION_ACTOR_ID = 'money-reconciliation-worker';

/**
 * Audit event type for a detected invariant violation. Audit event types are
 * free-form strings (audit/audit.ts `eventType: string`) — no shared enum to
 * extend — so this follows the same convention as 'invoice.overdue' /
 * 'invoice.dunning_proposed' emitted by the overdue-invoice worker.
 */
export const MONEY_RECONCILIATION_AUDIT_EVENT_TYPE = 'money.reconciliation_violation';

/**
 * P0-5 legacy join key: pre-fix checkout rows fell back to this literal, which
 * collides tenant-wide — any L5 row carrying it is unverifiable, never a pass.
 */
export const UNVERIFIABLE_PROVIDER_REFERENCE = 'stripe_checkout';

/** Cap on violating ids surfaced in the summary log (and audit fan-out per tenant). */
export const VIOLATION_ID_LOG_CAP = 20;

// ---------- metrics ----------

export const moneyReconciliationCheckedTotal = new Counter({
  name: 'money_reconciliation_checked_total',
  help: 'Money-invariant sweep: rows evaluated to a pass/fail verdict, by gate',
  labelNames: ['gate'],
  registers: [metricsRegistry],
});

export const moneyReconciliationViolationsTotal = new Counter({
  name: 'money_reconciliation_violations_total',
  help: 'Money-invariant sweep: detected invariant violations, by gate',
  labelNames: ['gate'],
  registers: [metricsRegistry],
});

export const moneyReconciliationUnverifiableTotal = new Counter({
  name: 'money_reconciliation_unverifiable_total',
  help: "Money-invariant sweep: rows that could not be verified (missing/'stripe_checkout' join key), by gate",
  labelNames: ['gate'],
  registers: [metricsRegistry],
});

// ---------- pure gate arithmetic ----------

export type InvoiceGate = 'l2_subtotal' | 'l2_total' | 'l3' | 'l4';
export type GateName = 'l1' | InvoiceGate | 'l5';

/** One invoice's stored counters + the sums recomputed from its child tables. */
export interface InvoiceReconciliationRow {
  invoiceId: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  /** COALESCE'd to 0 — the column is nullable (migration adds it later). */
  processingFeeCents: number;
  totalCents: number;
  amountPaidCents: number;
  /** Σ(invoice_line_items.total_cents) for this invoice. */
  lineTotalSumCents: number;
  /** Σ(payments.amount_cents) — completed/processing, not reversed, refund-INCLUSIVE. */
  activePaymentSumCents: number;
}

export interface InvoiceGateViolation {
  gate: InvoiceGate;
  expected: number;
  actual: number;
}

/**
 * Evaluate L2–L4 for one invoice. Pure — the SQL supplies the sums.
 */
export function evaluateInvoiceGates(row: InvoiceReconciliationRow): InvoiceGateViolation[] {
  const violations: InvoiceGateViolation[] = [];

  // L2a — subtotal must equal the line-item ledger.
  if (row.subtotalCents !== row.lineTotalSumCents) {
    violations.push({ gate: 'l2_subtotal', expected: row.lineTotalSumCents, actual: row.subtotalCents });
  }

  // L2b — total identity, mirroring calculateDocumentTotals including its
  // Math.max(0, …) clamp (an over-discounted document stores total 0).
  const expectedTotal = Math.max(
    0,
    row.subtotalCents - row.discountCents + row.taxCents + row.processingFeeCents,
  );
  if (row.totalCents !== expectedTotal) {
    violations.push({ gate: 'l2_total', expected: expectedTotal, actual: row.totalCents });
  }

  // L3 — the stateful counter must equal the active-payment ledger
  // (refund-INCLUSIVE: the sum deliberately does not subtract refunds).
  if (row.amountPaidCents !== row.activePaymentSumCents) {
    violations.push({ gate: 'l3', expected: row.activePaymentSumCents, actual: row.amountPaidCents });
  }

  // L4 — overpayment bound. Not implied by L3: matching double-credit payment
  // rows (P0-6) keep L3 green while the invoice is overpaid.
  if (row.amountPaidCents > row.totalCents) {
    violations.push({ gate: 'l4', expected: row.totalCents, actual: row.amountPaidCents });
  }

  return violations;
}

/** One processed checkout.session.completed event + the payment sum joined on its reference. */
export interface CheckoutEventRow {
  /** webhook_events.id (internal UUID). */
  eventId: string;
  /** payload->'object'->>'amount_total'; null when absent/malformed. */
  amountTotalCents: number | null;
  /** Derived payment_intent reference; null when the payload carries none. */
  paymentIntentRef: string | null;
  /** Σ(payments.amount_cents WHERE reference_number = ref) within the tenant. */
  matchedPaymentSumCents: number;
}

export type CheckoutClassification = 'pass' | 'violation' | 'unverifiable';

/**
 * Classify one L5 row. Pure — the SQL supplies the join sum.
 *
 * Unverifiable (never pass, never fail — P0-9 caveat #2):
 *   - no derivable payment_intent reference (legacy fallback rows keyed by
 *     session/event id, or a malformed payload), or
 *   - the legacy 'stripe_checkout' literal (P0-5), which collides tenant-wide
 *     so the payment join is ambiguous, or
 *   - a missing/malformed amount_total (nothing to compare against).
 */
export function classifyCheckoutEvent(row: CheckoutEventRow): CheckoutClassification {
  if (row.paymentIntentRef === null || row.paymentIntentRef === UNVERIFIABLE_PROVIDER_REFERENCE) {
    return 'unverifiable';
  }
  if (row.amountTotalCents === null) return 'unverifiable';
  return row.amountTotalCents === row.matchedPaymentSumCents ? 'pass' : 'violation';
}

// ---------- read-only Postgres reader ----------

export interface LineItemStats {
  lineItemCount: number;
  l1MismatchCount: number;
}

/**
 * Read surface of the sweep — SELECT-only by construction. The sweep loop
 * depends on this interface (fakeable in unit tests); the Pg implementation
 * below is the only DB access the worker has, so the worker cannot mutate
 * tenant data.
 */
export interface MoneyReconciliationReader {
  fetchInvoiceRollups(tenantId: string): Promise<InvoiceReconciliationRow[]>;
  fetchLineItemStats(tenantId: string): Promise<LineItemStats>;
  fetchCheckoutEventRows(tenantId: string): Promise<CheckoutEventRow[]>;
}

export class PgMoneyReconciliationReader
  extends PgBaseRepository
  implements MoneyReconciliationReader
{
  constructor(pool: Pool) {
    super(pool);
  }

  async fetchInvoiceRollups(tenantId: string): Promise<InvoiceReconciliationRow[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT
           i.id                                AS invoice_id,
           i.subtotal_cents,
           i.discount_cents,
           i.tax_cents,
           COALESCE(i.processing_fee_cents, 0) AS processing_fee_cents,
           i.total_cents,
           i.amount_paid_cents,
           COALESCE(li.sum_cents, 0)::bigint   AS line_total_sum_cents,
           COALESCE(p.sum_cents, 0)::bigint    AS active_payment_sum_cents
         FROM invoices i
         LEFT JOIN (
           SELECT invoice_id, SUM(total_cents) AS sum_cents
           FROM invoice_line_items
           WHERE tenant_id = $1::uuid
           GROUP BY invoice_id
         ) li ON li.invoice_id = i.id
         LEFT JOIN (
           SELECT invoice_id, SUM(amount_cents) AS sum_cents
           FROM payments
           WHERE tenant_id = $1::uuid
             AND status IN ('completed', 'processing')
             AND reversed_at IS NULL
           GROUP BY invoice_id
         ) p ON p.invoice_id = i.id
         WHERE i.tenant_id = $1::uuid
         ORDER BY i.created_at`,
        [tenantId],
      );
      return rows.map((r) => ({
        invoiceId: r.invoice_id as string,
        subtotalCents: Number(r.subtotal_cents),
        discountCents: Number(r.discount_cents),
        taxCents: Number(r.tax_cents),
        processingFeeCents: Number(r.processing_fee_cents),
        totalCents: Number(r.total_cents),
        amountPaidCents: Number(r.amount_paid_cents),
        lineTotalSumCents: Number(r.line_total_sum_cents),
        activePaymentSumCents: Number(r.active_payment_sum_cents),
      }));
    });
  }

  async fetchLineItemStats(tenantId: string): Promise<LineItemStats> {
    return this.withTenant(tenantId, async (client) => {
      // Postgres ROUND(numeric) rounds half away from zero; quantity and
      // unit_price_cents are non-negative, so it agrees with the engine's
      // Math.round (half up) on every representable row.
      const { rows } = await client.query(
        `SELECT
           COUNT(*)::int AS line_item_count,
           COUNT(*) FILTER (
             WHERE total_cents <> ROUND(quantity * unit_price_cents)
           )::int AS l1_mismatch_count
         FROM invoice_line_items
         WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      return {
        lineItemCount: Number(rows[0]?.line_item_count ?? 0),
        l1MismatchCount: Number(rows[0]?.l1_mismatch_count ?? 0),
      };
    });
  }

  async fetchCheckoutEventRows(tenantId: string): Promise<CheckoutEventRow[]> {
    return this.withTenant(tenantId, async (client) => {
      // The route persists event.data, so everything lives under 'object'
      // (P0-9 caveat #1 — payload->>'amount_total' is NULL on every row).
      // Filters mirror the handler's crediting preconditions: only fully-paid
      // ('payment_status' = 'paid'), invoice-targeted (not deposit), processed
      // events can have produced a payment row, so only those are comparable.
      // webhook_events is a global table (no tenant column); tenant scoping
      // comes from the persisted metadata, and the payment sum join is
      // tenant-scoped explicitly.
      const { rows } = await client.query(
        `WITH ev AS (
           SELECT
             we.id,
             CASE
               WHEN jsonb_typeof(we.payload->'object'->'amount_total') = 'number'
                 THEN (we.payload->'object'->>'amount_total')::bigint
               ELSE NULL
             END AS amount_total_cents,
             CASE
               WHEN jsonb_typeof(we.payload->'object'->'payment_intent') = 'string'
                 THEN we.payload->'object'->>'payment_intent'
               WHEN jsonb_typeof(we.payload->'object'->'payment_intent') = 'object'
                 THEN we.payload->'object'->'payment_intent'->>'id'
               ELSE NULL
             END AS payment_intent_ref
           FROM webhook_events we
           WHERE we.source = 'stripe'
             AND we.event_type = 'checkout.session.completed'
             AND we.status = 'processed'
             AND we.payload->'object'->'metadata'->>'tenant_id' = $1::text
             AND we.payload->'object'->'metadata'->>'invoice_id' IS NOT NULL
             AND we.payload->'object'->'metadata'->>'deposit_for_job_id' IS NULL
             AND we.payload->'object'->>'payment_status' = 'paid'
         )
         SELECT
           ev.id,
           ev.amount_total_cents,
           ev.payment_intent_ref,
           COALESCE(pm.sum_cents, 0)::bigint AS matched_payment_sum_cents
         FROM ev
         LEFT JOIN (
           SELECT reference_number, SUM(amount_cents) AS sum_cents
           FROM payments
           WHERE tenant_id = $1::uuid AND reference_number IS NOT NULL
           GROUP BY reference_number
         ) pm ON pm.reference_number = ev.payment_intent_ref`,
        [tenantId],
      );
      return rows.map((r) => ({
        eventId: r.id as string,
        amountTotalCents: r.amount_total_cents === null ? null : Number(r.amount_total_cents),
        paymentIntentRef: (r.payment_intent_ref as string | null) ?? null,
        matchedPaymentSumCents: Number(r.matched_payment_sum_cents),
      }));
    });
  }
}

// ---------- sweep loop ----------

export interface GateCounts {
  checked: number;
  violations: number;
  unverifiable: number;
}

export interface MoneyReconciliationSummary {
  tenants: number;
  failedTenants: number;
  gates: Record<GateName, GateCounts>;
  /** Capped at VIOLATION_ID_LOG_CAP. */
  violatingInvoiceIds: string[];
  /** Capped at VIOLATION_ID_LOG_CAP. */
  violatingEventIds: string[];
}

export interface MoneyReconciliationWorkerDeps {
  /**
   * Absent in in-memory dev (no pool) — the sweep then no-ops per tenant
   * (listTenantIds returns [] there anyway, matching the overdue sweep).
   */
  reader?: MoneyReconciliationReader;
  /** Violations become durable audit events when wired; detection-only otherwise. */
  auditRepo?: AuditRepository;
  /** Returns the list of tenant IDs to sweep (raw-pool `SELECT id FROM tenants`). */
  listTenantIds: () => Promise<string[]>;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
}

function emptyCounts(): GateCounts {
  return { checked: 0, violations: 0, unverifiable: 0 };
}

/** Failure-soft audit — detection must never abort on an audit write error. */
async function safeAudit(
  deps: MoneyReconciliationWorkerDeps,
  tenantId: string,
  entityType: 'invoice' | 'webhook_event',
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!deps.auditRepo) return;
  try {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: RECONCILIATION_ACTOR_ID,
        actorRole: 'system',
        eventType: MONEY_RECONCILIATION_AUDIT_EVENT_TYPE,
        entityType,
        entityId,
        metadata,
      }),
    );
  } catch (err) {
    deps.logger.warn('Money reconciliation: audit write failed', {
      tenantId,
      entityId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function runMoneyReconciliationSweep(
  deps: MoneyReconciliationWorkerDeps,
): Promise<MoneyReconciliationSummary> {
  const now = deps.now ?? (() => new Date());
  const asOf = now().toISOString();

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Money reconciliation sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      tenants: 0,
      failedTenants: 0,
      gates: {
        l1: emptyCounts(),
        l2_subtotal: emptyCounts(),
        l2_total: emptyCounts(),
        l3: emptyCounts(),
        l4: emptyCounts(),
        l5: emptyCounts(),
      },
      violatingInvoiceIds: [],
      violatingEventIds: [],
    };
  }

  const gates: Record<GateName, GateCounts> = {
    l1: emptyCounts(),
    l2_subtotal: emptyCounts(),
    l2_total: emptyCounts(),
    l3: emptyCounts(),
    l4: emptyCounts(),
    l5: emptyCounts(),
  };
  const violatingInvoiceIds: string[] = [];
  const violatingEventIds: string[] = [];
  let failedTenants = 0;

  for (const tenantId of tenantIds) {
    if (!deps.reader) break; // in-memory dev — nothing to read
    try {
      const [rollups, lineStats, eventRows] = [
        await deps.reader.fetchInvoiceRollups(tenantId),
        await deps.reader.fetchLineItemStats(tenantId),
        await deps.reader.fetchCheckoutEventRows(tenantId),
      ];

      // Per-tenant audit fan-out cap: a systemically-broken tenant must not
      // flood audit_events on every 6h tick. The full counts still land in
      // the metrics/summary; the capped ids are enough to start digging.
      let auditBudget = VIOLATION_ID_LOG_CAP;
      let tenantInvoiceViolations = 0;
      let tenantEventViolations = 0;

      // L1 — informational only (legacy pre-normalization rows exist).
      gates.l1.checked += lineStats.lineItemCount;
      gates.l1.violations += lineStats.l1MismatchCount;

      // L2–L4 per invoice.
      for (const row of rollups) {
        gates.l2_subtotal.checked += 1;
        gates.l2_total.checked += 1;
        gates.l3.checked += 1;
        gates.l4.checked += 1;

        const violations = evaluateInvoiceGates(row);
        if (violations.length === 0) continue;
        tenantInvoiceViolations += 1;
        if (violatingInvoiceIds.length < VIOLATION_ID_LOG_CAP) {
          violatingInvoiceIds.push(row.invoiceId);
        }
        for (const violation of violations) {
          gates[violation.gate].violations += 1;
        }
        if (auditBudget > 0) {
          auditBudget -= 1;
          // One audit event per violating invoice, carrying every failed gate
          // (first gate in the flat fields, all of them in `violations`).
          await safeAudit(deps, tenantId, 'invoice', row.invoiceId, {
            gate: violations[0]!.gate,
            expected: violations[0]!.expected,
            actual: violations[0]!.actual,
            violations,
            asOf,
          });
        }
      }

      // L5 per processed checkout event.
      for (const eventRow of eventRows) {
        const classification = classifyCheckoutEvent(eventRow);
        if (classification === 'unverifiable') {
          gates.l5.unverifiable += 1;
          continue;
        }
        gates.l5.checked += 1;
        if (classification === 'pass') continue;
        gates.l5.violations += 1;
        tenantEventViolations += 1;
        if (violatingEventIds.length < VIOLATION_ID_LOG_CAP) {
          violatingEventIds.push(eventRow.eventId);
        }
        if (auditBudget > 0) {
          auditBudget -= 1;
          await safeAudit(deps, tenantId, 'webhook_event', eventRow.eventId, {
            gate: 'l5',
            expected: eventRow.amountTotalCents,
            actual: eventRow.matchedPaymentSumCents,
            providerReference: eventRow.paymentIntentRef,
            asOf,
          });
        }
      }

      if (tenantInvoiceViolations > 0 || tenantEventViolations > 0) {
        deps.logger.warn('Money reconciliation: invariant violations detected for tenant', {
          tenantId,
          invoiceViolations: tenantInvoiceViolations,
          eventViolations: tenantEventViolations,
        });
      }
    } catch (err) {
      // Mirror the overdue-invoice sweep: one tenant's failure is logged and
      // swallowed so the sweep keeps going.
      failedTenants += 1;
      deps.logger.warn('Money reconciliation sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Metric counters per gate — inc(0) still materializes the label series.
  for (const [gate, counts] of Object.entries(gates)) {
    moneyReconciliationCheckedTotal.inc({ gate }, counts.checked);
    moneyReconciliationViolationsTotal.inc({ gate }, counts.violations);
    moneyReconciliationUnverifiableTotal.inc({ gate }, counts.unverifiable);
  }

  const summary: MoneyReconciliationSummary = {
    tenants: tenantIds.length,
    failedTenants,
    gates,
    violatingInvoiceIds,
    violatingEventIds,
  };

  deps.logger.info('Money reconciliation sweep completed', {
    tenants: summary.tenants,
    failedTenants: summary.failedTenants,
    gates: summary.gates,
    violatingInvoiceIds: summary.violatingInvoiceIds,
    violatingEventIds: summary.violatingEventIds,
  });

  return summary;
}
