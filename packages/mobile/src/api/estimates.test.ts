import { describe, expect, it, vi } from 'vitest';
import { createEstimate, sendEstimate } from './estimates';

const lineItems = [
  { description: 'Labor', quantity: 2, unitPriceCents: 5000, catalogItemId: 'cat-1' },
];

describe('createEstimate', () => {
  it('POSTs /api/estimates with mapped line items', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'est-1' }), { status: 201 }),
    );

    const result = await createEstimate(client, { customerId: 'c1', lineItems, notes: 'Rush job' });

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/estimates');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      customerId: 'c1',
      lineItems: [
        {
          description: 'Labor',
          quantity: 2,
          unitPriceCents: 5000,
          catalogItemId: 'cat-1',
        },
      ],
      notes: 'Rush job',
    });
    expect(result.id).toBe('est-1');
  });

  it('throws on a non-ok response', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    await expect(createEstimate(client, { customerId: 'c1', lineItems })).rejects.toThrow(
      /createEstimate: 500/,
    );
  });
});

describe('sendEstimate', () => {
  it('POSTs /api/estimates/:id/send', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(sendEstimate(client, 'est-1')).resolves.toBeUndefined();

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/estimates/est-1/send');
    expect(init.method).toBe('POST');
  });

  it('throws on a non-ok response', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(sendEstimate(client, 'missing')).rejects.toThrow(/sendEstimate: 404/);
  });
});
