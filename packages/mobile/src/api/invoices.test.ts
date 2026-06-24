import { describe, expect, it, vi } from 'vitest';
import { createInvoice, sendInvoice } from './invoices';

const lineItems = [
  { description: 'Service call', quantity: 1, unitPriceCents: 9900, catalogItemId: 'cat-2' },
];

describe('createInvoice', () => {
  it('POSTs /api/invoices with mapped line items and optional jobId', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'inv-1' }), { status: 201 }),
    );

    const result = await createInvoice(client, { customerId: 'c1', jobId: 'j1', lineItems });

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/invoices');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      customerId: 'c1',
      jobId: 'j1',
      lineItems: [
        {
          description: 'Service call',
          quantity: 1,
          unitPriceCents: 9900,
          catalogItemId: 'cat-2',
        },
      ],
    });
    expect(result.id).toBe('inv-1');
  });

  it('throws on a non-ok response', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    await expect(createInvoice(client, { customerId: 'c1', lineItems })).rejects.toThrow(
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
