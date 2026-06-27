import { describe, expect, it, vi } from 'vitest';
import { createInvoice, sendInvoice } from './invoices';

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
    expect(body.lineItems).toEqual([
      {
        description: 'Service call',
        quantity: 1,
        unitPriceCents: 9900,
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

describe('sendInvoice', () => {
  it('POSTs /api/invoices/:id/send', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(sendInvoice(client, 'inv-1')).resolves.toBeUndefined();

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/invoices/inv-1/send');
    expect(init.method).toBe('POST');
  });

  it('throws on a non-ok response', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(sendInvoice(client, 'missing')).rejects.toThrow(/sendInvoice: 404/);
  });
});
