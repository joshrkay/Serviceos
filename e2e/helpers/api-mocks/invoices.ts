/**
 * Invoices domain mocks — schema-validated fixtures + stateful handlers for
 * the /invoices list + detail flow. Fixtures parse under
 * @ai-service-os/shared's `invoiceResponseSchema`; the record-payment mutation
 * validates the intercepted body against a mirror of the server's
 * `recordPaymentSchema` (packages/api/src/shared/contracts.ts).
 *
 * The list auto-refetches every 30s (INVOICE_LIST_REFRESH_MS) — handlers are
 * idempotent and no test asserts GET counts, so the poller can't flake a run.
 */

import { z } from 'zod';
import type { Page, Route } from '@playwright/test';
import {
  invoiceResponseSchema,
  type InvoiceResponse,
} from '@ai-service-os/shared';
import { OFFLINE_TENANT_ID } from './shell';
import type { ApiTrackerEntry } from '../offline-app';

export const INVOICE_OPEN_ID = 'eeeeeee5-5555-4555-8555-555555555555';
export const INVOICE_OVERDUE_ID = 'fffffff6-6666-4666-8666-666666666666';
const JOB_ID = '99999997-7777-4777-8777-777777777777';
const CUSTOMER_ID = '88888888-8888-4888-8888-888888888888';

/** Mirror of packages/api/src/shared/contracts.ts recordPaymentSchema. */
const recordPaymentSchema = z.object({
  invoiceId: z.string().min(1),
  amountCents: z.number().int().positive(),
  method: z.enum(['cash', 'check', 'credit_card', 'bank_transfer', 'other']),
  providerReference: z.string().optional(),
  note: z.string().optional(),
});

export interface InvoicesMockState {
  invoices: InvoiceResponse[];
}

function totals(subtotalCents: number) {
  return {
    subtotalCents,
    discountCents: 0,
    taxRateBps: 0,
    taxableSubtotalCents: subtotalCents,
    taxCents: 0,
    totalCents: subtotalCents,
  };
}

export function buildInvoice(overrides: Partial<InvoiceResponse> = {}): InvoiceResponse {
  const total = 48000;
  return invoiceResponseSchema.parse({
    id: INVOICE_OPEN_ID,
    tenantId: OFFLINE_TENANT_ID,
    jobId: JOB_ID,
    invoiceNumber: 'INV-3001',
    status: 'open',
    lineItems: [
      {
        id: 'ili-1',
        description: 'Diagnostic + repair labor',
        quantity: 1,
        unitPriceCents: total,
        totalCents: total,
        sortOrder: 0,
        taxable: true,
      },
    ],
    totals: totals(total),
    amountPaidCents: 0,
    amountDueCents: total,
    // Future due date → "Unpaid" (payable, not yet overdue).
    dueDate: '2099-01-01',
    createdBy: 'user_e2e_stub',
    createdAt: '2026-07-01T14:00:00.000Z',
    updatedAt: '2026-07-01T14:00:00.000Z',
    customer: { id: CUSTOMER_ID, displayName: 'Ava Reyes' },
    ...overrides,
  });
}

export function createInvoicesMockState(): InvoicesMockState {
  return {
    invoices: [
      buildInvoice(),
      // Past due date + open → the client derives "Overdue"
      // (deriveInvoiceUiStatus / isInvoiceOverdue).
      buildInvoice({
        id: INVOICE_OVERDUE_ID,
        invoiceNumber: 'INV-3002',
        dueDate: '2020-01-01',
        customer: { id: CUSTOMER_ID, displayName: 'Owen Blake' },
      }),
    ],
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const DETAIL_RE = /^\/api\/invoices\/([^/]+)$/;

export async function installInvoicesMocks(
  page: Page,
  state: InvoicesMockState,
  tracker: ApiTrackerEntry[],
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/invoices',
    async (route) => {
      const req = route.request();
      if (req.method() !== 'GET') return route.fallback();
      const url = new URL(req.url());
      const query = Object.fromEntries(url.searchParams.entries());
      tracker.push({ method: 'GET', path: '/api/invoices', query });
      const status = url.searchParams.get('status');
      const rows = state.invoices.filter((i) => !status || i.status === status);
      await json(route, { data: rows, total: rows.length });
    },
  );

  await page.route(
    (url) => DETAIL_RE.test(url.pathname),
    async (route) => {
      const req = route.request();
      if (req.method() !== 'GET') return route.fallback();
      const id = new URL(req.url()).pathname.match(DETAIL_RE)![1];
      const inv = state.invoices.find((i) => i.id === id);
      if (!inv) return json(route, { error: 'not found' }, 404);
      await json(route, inv);
    },
  );

  // Record payment — the flow's key mutation. Validate the body against the
  // server's recordPaymentSchema shape, then move the invoice to paid.
  await page.route(
    (url) => url.pathname === '/api/payments',
    async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      const body = recordPaymentSchema.parse(req.postDataJSON());
      tracker.push({ method: 'POST', path: '/api/payments', body });
      const inv = state.invoices.find((i) => i.id === body.invoiceId);
      if (inv) {
        inv.amountPaidCents = inv.totals.totalCents;
        inv.amountDueCents = 0;
        inv.status = 'paid';
      }
      await json(route, { id: 'pay-1', invoiceId: body.invoiceId, amountCents: body.amountCents });
    },
  );

  await page.route(
    (url) => url.pathname === '/api/notes',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await json(route, []);
    },
  );
}
