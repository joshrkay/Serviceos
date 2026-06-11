import { z } from 'zod';
import type { Invoice, MoneySummary } from '@rivet/contracts';
import { lineItemInputSchema, taxRateBpsSchema } from '@rivet/contracts';
import { CommandError, defineCommand, type CommandCtx } from '../../core/commands';
import { withTenantTransaction, type Db } from '../../core/db';
import { computeTotals, formatCents } from './billing-engine';

async function loadInvoice(ctx: { client: CommandCtx['client']; tenantId: string }, invoiceId: string): Promise<Invoice | null> {
  const { rows } = await ctx.client.query(
    `SELECT i.id, i.customer_id, c.name AS customer_name, i.job_id, i.status,
            i.subtotal_cents, i.tax_cents, i.total_cents, i.tax_rate_bps,
            i.due_date, i.sent_at, i.paid_at, i.created_at
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     WHERE i.tenant_id = $1 AND i.id = $2`,
    [ctx.tenantId, invoiceId],
  );
  const row = rows[0];
  if (!row) return null;
  const items = await ctx.client.query(
    `SELECT id, description, quantity_hundredths, unit_price_cents, amount_cents, position
     FROM invoice_line_items WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY position`,
    [ctx.tenantId, invoiceId],
  );
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    jobId: row.job_id,
    status: row.status,
    subtotalCents: Number(row.subtotal_cents),
    taxCents: Number(row.tax_cents),
    totalCents: Number(row.total_cents),
    taxRateBps: row.tax_rate_bps,
    lineItems: items.rows.map((item) => ({
      id: item.id,
      description: item.description,
      quantityHundredths: item.quantity_hundredths,
      unitPriceCents: Number(item.unit_price_cents),
      amountCents: Number(item.amount_cents),
      position: item.position,
    })),
    dueDate: row.due_date ? row.due_date.toISOString().slice(0, 10) : null,
    sentAt: row.sent_at ? row.sent_at.toISOString() : null,
    paidAt: row.paid_at ? row.paid_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export const createInvoiceCommand = defineCommand({
  name: 'money.create_invoice',
  input: z.object({
    customerId: z.string().uuid(),
    jobId: z.string().uuid().optional(),
    lineItems: z.array(lineItemInputSchema).min(1).max(50),
    taxRateBps: taxRateBpsSchema.optional(),
    dueDate: z.string().optional(),
  }),
  async run(ctx, input): Promise<Invoice> {
    const customer = await ctx.client.query(
      `SELECT id FROM customers WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, input.customerId],
    );
    if (!customer.rows[0]) throw new CommandError('not_found', 'customer not found');

    const tenant = await ctx.client.query<{ default_tax_rate_bps: number }>(
      `SELECT default_tax_rate_bps FROM tenants WHERE id = $1`,
      [ctx.tenantId],
    );
    const taxRateBps = input.taxRateBps ?? tenant.rows[0]!.default_tax_rate_bps;
    const totals = computeTotals(input.lineItems, taxRateBps);

    const { rows } = await ctx.client.query<{ id: string }>(
      `INSERT INTO invoices (tenant_id, customer_id, job_id, subtotal_cents, tax_cents,
                             total_cents, tax_rate_bps, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        ctx.tenantId,
        input.customerId,
        input.jobId ?? null,
        totals.subtotalCents,
        totals.taxCents,
        totals.totalCents,
        taxRateBps,
        input.dueDate ?? null,
      ],
    );
    const invoiceId = rows[0]!.id;
    for (const [position, item] of totals.lineItems.entries()) {
      await ctx.client.query(
        `INSERT INTO invoice_line_items (tenant_id, invoice_id, description,
                                         quantity_hundredths, unit_price_cents, amount_cents, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ctx.tenantId, invoiceId, item.description, item.quantityHundredths, item.unitPriceCents, item.amountCents, position],
      );
    }
    ctx.emit({
      eventType: 'invoice.created',
      entityType: 'invoice',
      entityId: invoiceId,
      payload: { totalCents: totals.totalCents, customerId: input.customerId },
    });
    return (await loadInvoice(ctx, invoiceId))!;
  },
});

export const sendInvoiceCommand = defineCommand({
  name: 'money.send_invoice',
  input: z.object({ invoiceId: z.string().uuid() }),
  async run(ctx, input): Promise<Invoice> {
    const updated = await ctx.client.query<{ id: string }>(
      `UPDATE invoices SET status = 'sent', sent_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
       RETURNING id`,
      [ctx.tenantId, input.invoiceId],
    );
    if (!updated.rows[0]) {
      const exists = await ctx.client.query(
        `SELECT status FROM invoices WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, input.invoiceId],
      );
      if (!exists.rows[0]) throw new CommandError('not_found', 'invoice not found');
      throw new CommandError('conflict', `invoice is ${exists.rows[0].status}, only draft invoices can be sent`);
    }
    const invoice = (await loadInvoice(ctx, input.invoiceId))!;
    ctx.emit({
      eventType: 'invoice.sent',
      entityType: 'invoice',
      entityId: invoice.id,
      payload: { totalCents: invoice.totalCents },
    });
    ctx.enqueue({
      topic: 'comms.invoice-sms',
      payload: { invoiceId: invoice.id },
      dedupeKey: `invoice-sms:${invoice.id}`,
    });
    return invoice;
  },
});

export const recordPaymentCommand = defineCommand({
  name: 'money.record_payment',
  input: z.object({
    invoiceId: z.string().uuid(),
    amountCents: z.number().int().min(1),
    method: z.enum(['card', 'cash', 'check', 'other']),
    externalRef: z.string().max(200).optional(),
  }),
  async run(ctx, input): Promise<Invoice> {
    const invoice = await loadInvoice(ctx, input.invoiceId);
    if (!invoice) throw new CommandError('not_found', 'invoice not found');
    if (invoice.status === 'void') throw new CommandError('conflict', 'cannot pay a void invoice');

    // Idempotency: an external payment reference is recorded at most once.
    const inserted = await ctx.client.query<{ id: string }>(
      `INSERT INTO payments (tenant_id, invoice_id, amount_cents, method, external_ref)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, external_ref) WHERE external_ref IS NOT NULL DO NOTHING
       RETURNING id`,
      [ctx.tenantId, input.invoiceId, input.amountCents, input.method, input.externalRef ?? null],
    );
    if (!inserted.rows[0]) return invoice; // duplicate webhook delivery

    ctx.emit({
      eventType: 'payment.recorded',
      entityType: 'payment',
      entityId: inserted.rows[0].id,
      payload: { invoiceId: input.invoiceId, amountCents: input.amountCents, method: input.method },
    });

    const paid = await ctx.client.query<{ paid: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0) AS paid FROM payments
       WHERE tenant_id = $1 AND invoice_id = $2`,
      [ctx.tenantId, input.invoiceId],
    );
    if (Number(paid.rows[0]!.paid) >= invoice.totalCents && invoice.status !== 'paid') {
      await ctx.client.query(
        `UPDATE invoices SET status = 'paid', paid_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, input.invoiceId],
      );
      ctx.emit({
        eventType: 'invoice.paid',
        entityType: 'invoice',
        entityId: input.invoiceId,
        payload: { totalCents: invoice.totalCents },
      });
      ctx.enqueue({
        topic: 'comms.notify-owner',
        payload: {
          text: `Rivet: ${invoice.customerName} paid ${formatCents(invoice.totalCents)} (invoice ${invoice.id.slice(0, 8)}).`,
        },
        dedupeKey: `invoice-paid-notify:${input.invoiceId}`,
      });
    }
    return (await loadInvoice(ctx, input.invoiceId))!;
  },
});

/** Daily sweep: sent invoices past their due date become overdue. */
export const markOverdueInvoicesCommand = defineCommand({
  name: 'money.mark_overdue_invoices',
  input: z.object({}),
  async run(ctx): Promise<{ marked: number }> {
    const { rows } = await ctx.client.query<{ id: string }>(
      `UPDATE invoices SET status = 'overdue', updated_at = now()
       WHERE tenant_id = $1 AND status = 'sent' AND due_date IS NOT NULL AND due_date < CURRENT_DATE
       RETURNING id`,
      [ctx.tenantId],
    );
    for (const row of rows) {
      ctx.emit({ eventType: 'invoice.overdue', entityType: 'invoice', entityId: row.id });
    }
    return { marked: rows.length };
  },
});

export async function getInvoice(db: Db, tenantId: string, invoiceId: string): Promise<Invoice | null> {
  return withTenantTransaction(db, tenantId, (client) => loadInvoice({ client, tenantId }, invoiceId));
}

export async function listInvoices(db: Db, tenantId: string): Promise<Invoice[]> {
  return withTenantTransaction(db, tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM invoices WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [tenantId],
    );
    const invoices: Invoice[] = [];
    for (const row of rows) {
      const invoice = await loadInvoice({ client, tenantId }, row.id);
      if (invoice) invoices.push(invoice);
    }
    return invoices;
  });
}

export async function getMoneySummary(db: Db, tenantId: string): Promise<MoneySummary> {
  return withTenantTransaction(db, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT
         COALESCE(SUM(total_cents) FILTER (WHERE status IN ('sent', 'overdue')), 0) AS outstanding,
         COALESCE(SUM(total_cents) FILTER (WHERE status = 'paid' AND paid_at > now() - interval '30 days'), 0) AS paid30,
         COALESCE(SUM(total_cents) FILTER (WHERE status = 'overdue'), 0) AS overdue,
         COUNT(*) FILTER (WHERE status = 'draft') AS draft_count,
         COUNT(*) FILTER (WHERE status IN ('sent', 'overdue')) AS sent_count,
         COUNT(*) FILTER (WHERE status = 'paid') AS paid_count
       FROM invoices WHERE tenant_id = $1`,
      [tenantId],
    );
    const row = rows[0]!;
    return {
      outstandingCents: Number(row.outstanding),
      paidLast30DaysCents: Number(row.paid30),
      overdueCents: Number(row.overdue),
      draftCount: Number(row.draft_count),
      sentCount: Number(row.sent_count),
      paidCount: Number(row.paid_count),
    };
  });
}
