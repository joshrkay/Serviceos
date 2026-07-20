import { describe, expect, it, vi } from 'vitest';
import {
  createInvoice,
  createInvoicePaymentLink,
  issueInvoice,
  recordInvoicePayment,
  sendInvoice,
} from './invoices';

const lineItems = [
  { description: 'Service call', quantity: 1, unitPriceCents: 9900, catalogItemId: 'cat-2' },
];

describe('createInvoice', () => {
  it('POSTs /api/invoices with jobId and cents-based line items, no customerId', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'inv-1' }), { status: 201 }),
    );

    const result = await createInvoice(client, { jobId: 'j1', lineItems });

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/invoices');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.jobId).toBe('j1');
    expect(body).not.toHaveProperty('customerId');
    // Full server lineItemSchema shape — id/totalCents/sortOrder/taxable are
    // required by contracts.ts; omitting them 400s (the original bug).
    expect(body.lineItems).toEqual([
      {
        id: 'li-1',
        description: 'Service call',
        quantity: 1,
        unitPriceCents: 9900,
        totalCents: 9900,
        sortOrder: 0,
        taxable: false,
        catalogItemId: 'cat-2',
      },
    ]);
    expect(result.id).toBe('inv-1');
  });

  it('forwards optional discount/tax/fee/message fields when provided', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'inv-2' }), { status: 201 }),
    );

    await createInvoice(client, {
      jobId: 'j2',
      lineItems,
      discountCents: 250,
      taxRateBps: 700,
      processingFeeBps: 290,
      customerMessage: 'Net 15',
    });

    const [, init] = client.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.discountCents).toBe(250);
    expect(body.taxRateBps).toBe(700);
    expect(body.processingFeeBps).toBe(290);
    expect(body.customerMessage).toBe('Net 15');
  });

  it('throws on a non-ok response', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    await expect(createInvoice(client, { jobId: 'j1', lineItems })).rejects.toThrow(
      /createInvoice: 500/,
    );
  });
});

describe('issueInvoice', () => {
  // The server route (packages/api/src/routes/invoices.ts POST /:id/issue)
  // validates paymentTermDays MANUALLY (integer 0–365, default 30) — there is
  // no Zod schema to pin against, so these assert the wire body directly.
  it('POSTs /api/invoices/:id/issue with an empty body when no term is given', async () => {
    const client = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'inv-1' }), { status: 200 }));

    await expect(issueInvoice(client, 'inv-1')).resolves.toBeUndefined();

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/invoices/inv-1/issue');
    expect(init.method).toBe('POST');
    // Omitting the term lets the server own the default (30) rather than the
    // client hard-coding it.
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('forwards an explicit paymentTermDays', async () => {
    const client = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'inv-1' }), { status: 200 }));

    await issueInvoice(client, 'inv-1', 15);

    const [, init] = client.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ paymentTermDays: 15 });
  });

  it('rejects with the decoded server error on a non-ok response', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'VALIDATION_ERROR', message: 'paymentTermDays must be an integer between 0 and 365' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(issueInvoice(client, 'inv-1', 999)).rejects.toMatchObject({
      message: 'paymentTermDays must be an integer between 0 and 365',
    });
  });
});

describe('sendInvoice', () => {
  it('POSTs /api/invoices/:id/send', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(sendInvoice(client, 'inv-1')).resolves.toBeUndefined();

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/invoices/inv-1/send');
    expect(init.method).toBe('POST');
  });

  it('surfaces the server message on a non-ok response', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'CONFLICT', message: 'No contact on file' }), { status: 409 }),
    );

    await expect(sendInvoice(client, 'missing')).rejects.toThrow(/No contact on file/);
  });
});

describe('issueInvoice', () => {
  it('POSTs /api/invoices/:id/issue with an empty body when no term is given', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(issueInvoice(client, 'inv-1')).resolves.toBeUndefined();

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/invoices/inv-1/issue');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('forwards paymentTermDays when provided', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await issueInvoice(client, 'inv-1', 15);

    const [, init] = client.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ paymentTermDays: 15 });
  });

  it('surfaces the server message on a non-ok response', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'VALIDATION_ERROR', message: 'Invalid transition from open to open' }), {
        status: 400,
      }),
    );

    await expect(issueInvoice(client, 'inv-1')).rejects.toThrow(/Invalid transition/);
  });
});

describe('createInvoicePaymentLink', () => {
  it('POSTs /api/invoices/:id/payment-link and returns the url', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://pay.test/abc', expiresAt: null }), { status: 200 }),
    );

    const result = await createInvoicePaymentLink(client, 'inv-1');

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/invoices/inv-1/payment-link');
    expect(init.method).toBe('POST');
    expect(result).toEqual({ url: 'https://pay.test/abc', expiresAt: null });
  });

  it('surfaces the conflict message when the invoice is not payable', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'CONFLICT', message: 'Invoice must be open to create a link' }), {
        status: 409,
      }),
    );

    await expect(createInvoicePaymentLink(client, 'inv-1')).rejects.toThrow(/must be open/);
  });
});

describe('recordInvoicePayment', () => {
  it('POSTs /api/invoices/:id/payment with integer-cents amount + method', async () => {
    const client = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 201 }));

    await recordInvoicePayment(client, 'inv-1', { amountCents: 124000, method: 'check', note: 'ck #42' });

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/invoices/inv-1/payment');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.amountCents).toBe(124000);
    expect(body.method).toBe('check');
    expect(body.note).toBe('ck #42');
  });

  it('surfaces the over-balance server message', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'VALIDATION_ERROR', message: 'Payment exceeds amount due' }),
        { status: 400 },
      ),
    );

    await expect(
      recordInvoicePayment(client, 'inv-1', { amountCents: 999999, method: 'cash' }),
    ).rejects.toThrow(/exceeds amount due/);
  });
});
