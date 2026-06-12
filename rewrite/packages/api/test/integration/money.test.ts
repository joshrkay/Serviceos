import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTransaction } from '../../src/core/db';
import { createCustomerCommand } from '../../src/modules/crm/customers';
import {
  createInvoiceCommand,
  getMoneySummary,
  markOverdueInvoicesCommand,
  recordPaymentCommand,
  sendInvoiceCommand,
} from '../../src/modules/money/invoices';
import { createJobCommand, scheduleAppointmentCommand } from '../../src/modules/money/jobs';
import { createTestDb, createTestTenant, type TestDb } from './helpers';

describe('money loop', () => {
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
      name: 'Pat Doe',
      phone: '+15551000',
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    await env.destroy();
  });

  it('creates and schedules a job, moving status to scheduled', async () => {
    const job = await env.bus.execute(createJobCommand, scope, {
      customerId,
      title: 'AC repair',
    });
    expect(job.status).toBe('unscheduled');
    const startsAt = new Date(Date.now() + 86_400_000).toISOString();
    const appointment = await env.bus.execute(scheduleAppointmentCommand, scope, {
      jobId: job.id,
      startsAt,
      durationMinutes: 90,
    });
    expect(new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()).toBe(
      90 * 60_000,
    );
    const status = await withTenantTransaction(env.db, tenantId, (client) =>
      client.query('SELECT status FROM jobs WHERE id = $1', [job.id]),
    );
    expect(status.rows[0].status).toBe('scheduled');
  });

  it('computes invoice totals through the billing engine', async () => {
    const invoice = await env.bus.execute(createInvoiceCommand, scope, {
      customerId,
      lineItems: [
        { description: 'Compressor', quantityHundredths: 100, unitPriceCents: 45_000 },
        { description: 'Labor', quantityHundredths: 250, unitPriceCents: 10_000 },
      ],
      taxRateBps: 825,
    });
    expect(invoice.subtotalCents).toBe(45_000 + 25_000);
    expect(invoice.taxCents).toBe(Math.round(70_000 * 0.0825));
    expect(invoice.totalCents).toBe(invoice.subtotalCents + invoice.taxCents);
    expect(invoice.status).toBe('draft');
  });

  it('send -> partial payment -> full payment marks invoice paid and is idempotent', async () => {
    const invoice = await env.bus.execute(createInvoiceCommand, scope, {
      customerId,
      lineItems: [{ description: 'Service', quantityHundredths: 100, unitPriceCents: 20_000 }],
      taxRateBps: 0,
    });
    const sent = await env.bus.execute(sendInvoiceCommand, scope, { invoiceId: invoice.id });
    expect(sent.status).toBe('sent');

    // Sending twice is rejected (status machine).
    await expect(
      env.bus.execute(sendInvoiceCommand, scope, { invoiceId: invoice.id }),
    ).rejects.toThrow(/only draft/);

    const partial = await env.bus.execute(recordPaymentCommand, scope, {
      invoiceId: invoice.id,
      amountCents: 5_000,
      method: 'cash',
    });
    expect(partial.status).toBe('sent');

    const paid = await env.bus.execute(recordPaymentCommand, scope, {
      invoiceId: invoice.id,
      amountCents: 15_000,
      method: 'card',
      externalRef: 'pi_test_1',
    });
    expect(paid.status).toBe('paid');

    // Duplicate webhook delivery with the same external ref is a no-op.
    const duplicate = await env.bus.execute(recordPaymentCommand, scope, {
      invoiceId: invoice.id,
      amountCents: 15_000,
      method: 'card',
      externalRef: 'pi_test_1',
    });
    expect(duplicate.status).toBe('paid');
    const payments = await withTenantTransaction(env.db, tenantId, (client) =>
      client.query('SELECT COUNT(*) FROM payments WHERE invoice_id = $1', [invoice.id]),
    );
    expect(Number(payments.rows[0].count)).toBe(2);
  });

  it('emits events and enqueues outbox side effects atomically with mutations', async () => {
    const rows = await withTenantTransaction(env.db, tenantId, (client) =>
      client.query(
        `SELECT event_type FROM events WHERE tenant_id = $1 ORDER BY id`,
        [tenantId],
      ),
    );
    const types = rows.rows.map((row) => row.event_type);
    for (const expected of [
      'customer.created',
      'job.created',
      'appointment.scheduled',
      'invoice.created',
      'invoice.sent',
      'payment.recorded',
      'invoice.paid',
    ]) {
      expect(types).toContain(expected);
    }
    const outbox = await withTenantTransaction(env.db, tenantId, (client) =>
      client.query(`SELECT topic FROM outbox WHERE tenant_id = $1`, [tenantId]),
    );
    const topics = outbox.rows.map((row) => row.topic);
    expect(topics).toContain('comms.invoice-sms');
    expect(topics).toContain('comms.notify-owner');
  });

  it('marks sent invoices past due date as overdue', async () => {
    const invoice = await env.bus.execute(createInvoiceCommand, scope, {
      customerId,
      lineItems: [{ description: 'Old work', quantityHundredths: 100, unitPriceCents: 9_900 }],
      taxRateBps: 0,
      dueDate: '2020-01-01',
    });
    await env.bus.execute(sendInvoiceCommand, scope, { invoiceId: invoice.id });
    const result = await env.bus.execute(markOverdueInvoicesCommand, {
      tenantId,
      actor: { type: 'system', id: 'test' },
    }, {});
    expect(result.marked).toBeGreaterThanOrEqual(1);
    const summary = await getMoneySummary(env.db, tenantId);
    expect(summary.overdueCents).toBeGreaterThanOrEqual(9_900);
  });
});
