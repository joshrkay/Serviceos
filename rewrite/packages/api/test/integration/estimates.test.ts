import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '../../src/core/db';
import { createCustomerCommand } from '../../src/modules/crm/customers';
import {
  createEstimateCommand,
  decideEstimateCommand,
  listEstimates,
  sendEstimateCommand,
} from '../../src/modules/money/estimates';
import { createTestDb, createTestTenant, type TestDb } from './helpers';

describe('estimates', () => {
  let env: TestDb;
  let tenantId: string;
  let scope: { tenantId: string; actor: { type: 'user'; id: string } };
  let customerId: string;

  beforeAll(async () => {
    env = await createTestDb();
    const t = await createTestTenant(env.db);
    tenantId = t.tenantId;
    scope = { tenantId, actor: { type: 'user', id: t.ownerUserId } };
    const customer = await env.bus.execute(createCustomerCommand, scope, {
      name: 'Quote Seeker',
      phone: '+15552000',
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    await env.destroy();
  });

  it('computes estimate totals through the billing engine', async () => {
    const estimate = await env.bus.execute(createEstimateCommand, scope, {
      customerId,
      lineItems: [
        { description: 'New furnace', quantityHundredths: 100, unitPriceCents: 320_000 },
        { description: 'Install labor', quantityHundredths: 400, unitPriceCents: 11_000 },
      ],
      taxRateBps: 600,
    });
    expect(estimate.subtotalCents).toBe(320_000 + 44_000);
    expect(estimate.taxCents).toBe(Math.round(364_000 * 0.06));
    expect(estimate.totalCents).toBe(estimate.subtotalCents + estimate.taxCents);
    expect(estimate.status).toBe('draft');
  });

  it('draft -> sent -> approved lifecycle with guarded transitions', async () => {
    const estimate = await env.bus.execute(createEstimateCommand, scope, {
      customerId,
      lineItems: [{ description: 'Duct cleaning', quantityHundredths: 100, unitPriceCents: 35_000 }],
      taxRateBps: 0,
    });

    // Cannot decide a draft.
    await expect(
      env.bus.execute(decideEstimateCommand, scope, { estimateId: estimate.id, decision: 'approved' }),
    ).rejects.toThrow(/only sent/);

    const sent = await env.bus.execute(sendEstimateCommand, scope, { estimateId: estimate.id });
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).not.toBeNull();

    // Cannot send twice.
    await expect(
      env.bus.execute(sendEstimateCommand, scope, { estimateId: estimate.id }),
    ).rejects.toThrow(/only drafts/);

    const approved = await env.bus.execute(decideEstimateCommand, scope, {
      estimateId: estimate.id,
      decision: 'approved',
    });
    expect(approved.status).toBe('approved');
    expect(approved.decidedAt).not.toBeNull();

    // Decision is terminal.
    await expect(
      env.bus.execute(decideEstimateCommand, scope, { estimateId: estimate.id, decision: 'declined' }),
    ).rejects.toThrow(/only sent/);

    const events = await withTenantTransaction(env.db, tenantId, (client) =>
      client.query(
        `SELECT event_type FROM events WHERE tenant_id = $1 AND entity_type = 'estimate' ORDER BY id`,
        [tenantId],
      ),
    );
    const types = events.rows.map((row) => row.event_type);
    expect(types).toContain('estimate.created');
    expect(types).toContain('estimate.sent');
    expect(types).toContain('estimate.approved');

    const outbox = await withTenantTransaction(env.db, tenantId, (client) =>
      client.query(`SELECT topic FROM outbox WHERE tenant_id = $1`, [tenantId]),
    );
    expect(outbox.rows.map((row) => row.topic)).toContain('comms.estimate-sms');
  });

  it('declined estimates are recorded', async () => {
    const estimate = await env.bus.execute(createEstimateCommand, scope, {
      customerId,
      lineItems: [{ description: 'Optional upgrade', quantityHundredths: 100, unitPriceCents: 99_000 }],
      taxRateBps: 0,
    });
    await env.bus.execute(sendEstimateCommand, scope, { estimateId: estimate.id });
    const declined = await env.bus.execute(decideEstimateCommand, scope, {
      estimateId: estimate.id,
      decision: 'declined',
    });
    expect(declined.status).toBe('declined');
    const all = await listEstimates(env.db, tenantId);
    expect(all.find((e) => e.id === estimate.id)?.status).toBe('declined');
  });
});
