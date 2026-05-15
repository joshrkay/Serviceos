import { describe, it, expect } from 'vitest';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createReportsRouter } from '../../src/routes/reports';
import { InMemoryRevenueBySourceRepository } from '../../src/reports/revenue-by-source';
import { InMemoryMoneyDashboardRepository } from '../../src/reports/money-dashboard';
import { InMemoryExpenseRepository, createExpense } from '../../src/expenses/expense';
import { InMemoryInvoiceRepository, Invoice } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository, Payment } from '../../src/invoices/payment';

function buildApp() {
  const revenueBySourceRepo = new InMemoryRevenueBySourceRepository();
  const moneyDashboardRepo = new InMemoryMoneyDashboardRepository();
  const expenseRepo = new InMemoryExpenseRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const paymentRepo = new InMemoryPaymentRepository();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'user-r1',
      sessionId: 'session-r1',
      tenantId: 'tenant-r1',
      role: 'owner',
    };
    next();
  });
  app.use(
    '/api/reports',
    createReportsRouter({
      revenueBySourceRepo,
      moneyDashboardRepo,
      expenseRepo,
      invoiceRepo,
      paymentRepo,
    }),
  );
  return { app, moneyDashboardRepo, expenseRepo, invoiceRepo, paymentRepo };
}

describe('GET /api/reports/money-dashboard', () => {
  it('returns the summary under data for a valid month', async () => {
    const { app, moneyDashboardRepo } = buildApp();
    moneyDashboardRepo.setSummary({
      month: '2026-05',
      revenueCents: 500000,
      priorMonthRevenueCents: 400000,
      revenueTrendCents: 100000,
      expensesCents: 80000,
      outstandingCents: 120000,
      overdueCents: 30000,
    });
    const res = await request(app).get('/api/reports/money-dashboard?month=2026-05');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ month: '2026-05', revenueCents: 500000 });
  });

  it('rejects a malformed month with 400', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/reports/money-dashboard?month=May-2026');
    expect(res.status).toBe(400);
  });

  it('defaults to the current month when month is omitted', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/reports/money-dashboard');
    expect(res.status).toBe(200);
    expect(res.body.data.month).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('GET /api/reports/tax-export', () => {
  it('streams CSV with income + expense rows for the window', async () => {
    const { app, expenseRepo } = buildApp();
    await createExpense(
      {
        tenantId: 'tenant-r1',
        description: 'Copper fittings',
        amountCents: 24000,
        category: 'materials',
        spentAt: new Date('2026-05-10'),
        createdBy: 'user-r1',
      },
      expenseRepo,
    );
    const res = await request(app).get(
      '/api/reports/tax-export?from=2026-05-01&to=2026-06-01',
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.text.split('\n')[0]).toBe('Date,Type,Category,Description,Job ID,Amount');
    expect(res.text).toContain('expense,materials,Copper fittings');
  });

  it('rejects a missing from/to with 400', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/reports/tax-export?from=2026-05-01');
    expect(res.status).toBe(400);
  });

  it('buckets income by payment.receivedAt (cash basis), not invoice.issuedAt', async () => {
    const { app, invoiceRepo, paymentRepo } = buildApp();
    // Invoice was ISSUED in December 2025 …
    const inv: Invoice = {
      id: 'inv-cash-1',
      tenantId: 'tenant-r1',
      jobId: 'job-cash-1',
      invoiceNumber: 'INV-CASH-1',
      status: 'paid',
      lineItems: [],
      totals: {
        subtotalCents: 50000,
        taxCents: 0,
        totalCents: 50000,
        discountCents: 0,
        taxRateBps: 0,
        taxableSubtotalCents: 50000,
      },
      amountPaidCents: 50000,
      amountDueCents: 0,
      issuedAt: new Date('2025-12-20'),
      createdBy: 'user-r1',
      createdAt: new Date('2025-12-20'),
      updatedAt: new Date('2026-01-15'),
    };
    await invoiceRepo.create(inv);
    // … but PAID in January 2026.
    const payment: Payment = {
      id: 'pay-cash-1',
      tenantId: 'tenant-r1',
      invoiceId: inv.id,
      amountCents: 50000,
      method: 'cash',
      status: 'completed',
      receivedAt: new Date('2026-01-15'),
      processedBy: 'user-r1',
      createdAt: new Date('2026-01-15'),
      updatedAt: new Date('2026-01-15'),
    };
    await paymentRepo.create(payment);

    // Export 2025 — should be EMPTY (cash arrived in 2026).
    const res2025 = await request(app).get(
      '/api/reports/tax-export?from=2025-01-01&to=2026-01-01',
    );
    expect(res2025.status).toBe(200);
    expect(res2025.text).not.toContain('INV-CASH-1');

    // Export Jan 2026 — should INCLUDE the income row, dated 2026-01-15.
    const res2026 = await request(app).get(
      '/api/reports/tax-export?from=2026-01-01&to=2026-02-01',
    );
    expect(res2026.status).toBe(200);
    expect(res2026.text).toContain('2026-01-15,income,invoice,INV-CASH-1,job-cash-1,500.00');
  });
});
