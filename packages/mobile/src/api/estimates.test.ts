import { describe, expect, it, vi } from 'vitest';
import { createEstimate, sendEstimate } from './estimates';

const lineItems = [
  { description: 'Labor', quantity: 2, unitPriceCents: 5000, catalogItemId: 'cat-1' },
];

describe('createEstimate', () => {
  it('POSTs /api/estimates with jobId and cents-based line items, no customerId', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'est-1' }), { status: 201 }),
    );

    const result = await createEstimate(client, { jobId: 'job-1', lineItems });

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/estimates');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.jobId).toBe('job-1');
    expect(body).not.toHaveProperty('customerId');
    expect(body.lineItems).toEqual([
      {
        description: 'Labor',
        quantity: 2,
        unitPriceCents: 5000,
        catalogItemId: 'cat-1',
      },
    ]);
    expect(result.id).toBe('est-1');
  });

  it('forwards optional discount/tax/message fields when provided', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'est-2' }), { status: 201 }),
    );

    await createEstimate(client, {
      jobId: 'job-2',
      lineItems,
      discountCents: 500,
      taxRateBps: 825,
      customerMessage: 'Thanks!',
    });

    const [, init] = client.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.discountCents).toBe(500);
    expect(body.taxRateBps).toBe(825);
    expect(body.customerMessage).toBe('Thanks!');
  });

  it('throws on a non-ok response', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    await expect(createEstimate(client, { jobId: 'job-1', lineItems })).rejects.toThrow(
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
