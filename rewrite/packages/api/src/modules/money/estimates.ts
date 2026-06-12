import { z } from 'zod';
import type { Estimate } from '@rivet/contracts';
import { lineItemInputSchema, taxRateBpsSchema } from '@rivet/contracts';
import { CommandError, defineCommand, type CommandCtx } from '../../core/commands';
import { withTenantTransaction, type Db } from '../../core/db';
import { computeTotals, formatCents } from './billing-engine';

async function loadEstimate(
  ctx: { client: CommandCtx['client']; tenantId: string },
  estimateId: string,
): Promise<Estimate | null> {
  const { rows } = await ctx.client.query(
    `SELECT e.id, e.customer_id, c.name AS customer_name, e.job_id, e.status,
            e.subtotal_cents, e.tax_cents, e.total_cents, e.tax_rate_bps,
            e.sent_at, e.decided_at, e.created_at
     FROM estimates e JOIN customers c ON c.id = e.customer_id
     WHERE e.tenant_id = $1 AND e.id = $2`,
    [ctx.tenantId, estimateId],
  );
  const row = rows[0];
  if (!row) return null;
  const items = await ctx.client.query(
    `SELECT id, description, quantity_hundredths, unit_price_cents, amount_cents, position
     FROM estimate_line_items WHERE tenant_id = $1 AND estimate_id = $2 ORDER BY position`,
    [ctx.tenantId, estimateId],
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
    sentAt: row.sent_at ? row.sent_at.toISOString() : null,
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export const createEstimateCommand = defineCommand({
  name: 'money.create_estimate',
  input: z.object({
    customerId: z.string().uuid(),
    jobId: z.string().uuid().optional(),
    lineItems: z.array(lineItemInputSchema).min(1).max(50),
    taxRateBps: taxRateBpsSchema.optional(),
  }),
  async run(ctx, input): Promise<Estimate> {
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
      `INSERT INTO estimates (tenant_id, customer_id, job_id, subtotal_cents, tax_cents,
                              total_cents, tax_rate_bps)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        ctx.tenantId,
        input.customerId,
        input.jobId ?? null,
        totals.subtotalCents,
        totals.taxCents,
        totals.totalCents,
        taxRateBps,
      ],
    );
    const estimateId = rows[0]!.id;
    for (const [position, item] of totals.lineItems.entries()) {
      await ctx.client.query(
        `INSERT INTO estimate_line_items (tenant_id, estimate_id, description,
                                          quantity_hundredths, unit_price_cents, amount_cents, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ctx.tenantId, estimateId, item.description, item.quantityHundredths, item.unitPriceCents, item.amountCents, position],
      );
    }
    ctx.emit({
      eventType: 'estimate.created',
      entityType: 'estimate',
      entityId: estimateId,
      payload: { totalCents: totals.totalCents, customerId: input.customerId },
    });
    return (await loadEstimate(ctx, estimateId))!;
  },
});

export const sendEstimateCommand = defineCommand({
  name: 'money.send_estimate',
  input: z.object({ estimateId: z.string().uuid() }),
  async run(ctx, input): Promise<Estimate> {
    const updated = await ctx.client.query<{ id: string }>(
      `UPDATE estimates SET status = 'sent', sent_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'draft'
       RETURNING id`,
      [ctx.tenantId, input.estimateId],
    );
    if (!updated.rows[0]) {
      const exists = await ctx.client.query(
        `SELECT status FROM estimates WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, input.estimateId],
      );
      if (!exists.rows[0]) throw new CommandError('not_found', 'estimate not found');
      throw new CommandError('conflict', `estimate is ${exists.rows[0].status}, only drafts can be sent`);
    }
    const estimate = (await loadEstimate(ctx, input.estimateId))!;
    ctx.emit({
      eventType: 'estimate.sent',
      entityType: 'estimate',
      entityId: estimate.id,
      payload: { totalCents: estimate.totalCents },
    });
    ctx.enqueue({
      topic: 'comms.estimate-sms',
      payload: { estimateId: estimate.id },
      dedupeKey: `estimate-sms:${estimate.id}`,
    });
    return estimate;
  },
});

export const decideEstimateCommand = defineCommand({
  name: 'money.decide_estimate',
  input: z.object({
    estimateId: z.string().uuid(),
    decision: z.enum(['approved', 'declined']),
  }),
  async run(ctx, input): Promise<Estimate> {
    const updated = await ctx.client.query<{ id: string }>(
      `UPDATE estimates SET status = $3, decided_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'sent'
       RETURNING id`,
      [ctx.tenantId, input.estimateId, input.decision],
    );
    if (!updated.rows[0]) {
      const exists = await ctx.client.query(
        `SELECT status FROM estimates WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, input.estimateId],
      );
      if (!exists.rows[0]) throw new CommandError('not_found', 'estimate not found');
      throw new CommandError('conflict', `estimate is ${exists.rows[0].status}, only sent estimates can be decided`);
    }
    const estimate = (await loadEstimate(ctx, input.estimateId))!;
    ctx.emit({
      eventType: `estimate.${input.decision}`,
      entityType: 'estimate',
      entityId: estimate.id,
      payload: { totalCents: estimate.totalCents },
    });
    if (input.decision === 'approved') {
      ctx.enqueue({
        topic: 'comms.notify-owner',
        payload: {
          text: `Rivet: ${estimate.customerName} approved the estimate for ${formatCents(estimate.totalCents)}.`,
        },
        dedupeKey: `estimate-approved-notify:${estimate.id}`,
      });
    }
    return estimate;
  },
});

export async function listEstimates(db: Db, tenantId: string): Promise<Estimate[]> {
  return withTenantTransaction(db, tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM estimates WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [tenantId],
    );
    const estimates: Estimate[] = [];
    for (const row of rows) {
      const estimate = await loadEstimate({ client, tenantId }, row.id);
      if (estimate) estimates.push(estimate);
    }
    return estimates;
  });
}
