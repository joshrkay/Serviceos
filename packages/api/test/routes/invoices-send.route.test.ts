/**
 * Journey QA 2026-07-02 (bug 2) — POST /api/invoices/:id/send with the send
 * sheet's untouched (empty-string) recipient fields must fall back to the
 * customer's contact on file, not 400. The estimates send route already
 * carried the ''→undefined transform; this pins the invoices route's mirror
 * of it.
 */
import { describe, it, expect, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { createInvoiceRouter } from '../../src/routes/invoices';
import { InMemoryInvoiceRepository, createInvoiceWithNextNumber } from '../../src/invoices/invoice';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import type { SendService } from '../../src/notifications/send-service';

const TENANT_ID = 'tenant-send-1';
const USER_ID = 'user-send-1';

function seedSettings(tenantId: string): TenantSettings {
  return {
    id: `settings-${tenantId}`,
    tenantId,
    businessName: 'Test Business',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function buildApp() {
  const invoiceRepo = new InMemoryInvoiceRepository();
  const settingsRepo = new InMemorySettingsRepository();
  const auditRepo = new InMemoryAuditRepository();
  await settingsRepo.create(seedSettings(TENANT_ID));

  // Capture what the route forwards to SendService — the fallback to the
  // customer's number on file happens inside SendService, so the route's
  // contract is: never forward '' (it must arrive as undefined).
  const sendInvoice = vi.fn().mockResolvedValue({
    dispatchId: 'dispatch-1',
    status: 'queued',
  });
  const sendService = { sendInvoice } as unknown as SendService;

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER_ID,
      sessionId: 'session-send-1',
      tenantId: TENANT_ID,
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/invoices',
    createInvoiceRouter(
      invoiceRepo,
      settingsRepo,
      auditRepo,
      permissiveTenantOwnership(),
      undefined,
      sendService,
    ),
  );

  const invoice = await createInvoiceWithNextNumber(
    {
      tenantId: TENANT_ID,
      jobId: 'job-1',
      lineItems: [
        {
          id: 'li-1',
          description: 'Water heater install',
          quantity: 1,
          unitPriceCents: 185000,
          totalCents: 185000,
          sortOrder: 0,
          taxable: true,
        },
      ],
      createdBy: USER_ID,
    },
    invoiceRepo,
    settingsRepo,
  );

  return { app, invoice, sendInvoice };
}

describe('POST /api/invoices/:id/send — empty recipient falls back to customer default', () => {
  it("transforms the sheet's recipientPhone:'' to undefined (202, not 400)", async () => {
    const { app, invoice, sendInvoice } = await buildApp();

    const res = await request(app).post(`/api/invoices/${invoice.id}/send`).send({
      channel: 'sms',
      recipientPhone: '',
      recipientEmail: '',
      customMessage: '',
    });

    expect(res.status).toBe(202);
    expect(sendInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        invoiceId: invoice.id,
        channel: 'sms',
      }),
    );
    const forwarded = sendInvoice.mock.calls[0][0];
    expect(forwarded.recipientPhone).toBeUndefined();
    expect(forwarded.recipientEmail).toBeUndefined();
    expect(forwarded.customMessage).toBeUndefined();
  });

  it('still forwards an explicitly typed recipient', async () => {
    const { app, invoice, sendInvoice } = await buildApp();

    const res = await request(app).post(`/api/invoices/${invoice.id}/send`).send({
      channel: 'sms',
      recipientPhone: '+15125550188',
    });

    expect(res.status).toBe(202);
    expect(sendInvoice.mock.calls[0][0].recipientPhone).toBe('+15125550188');
  });
});
