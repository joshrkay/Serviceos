import { describe, expect, it, vi } from 'vitest';
import { createEstimate, getEstimate, sendEstimate, updateEstimate } from './estimates';

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
    // Full server lineItemSchema shape — id/totalCents/sortOrder/taxable are
    // required by contracts.ts; omitting them 400s (the original bug).
    expect(body.lineItems).toEqual([
      {
        id: 'li-1',
        description: 'Labor',
        quantity: 2,
        unitPriceCents: 5000,
        totalCents: 10000,
        sortOrder: 0,
        taxable: false,
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

describe('getEstimate', () => {
  it('GETs /api/estimates/:id and returns the estimate response (integer cents preserved)', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'est-1',
          jobId: 'job-1',
          version: 3,
          lineItems: [{ description: 'Labor', quantity: 2, unitPriceCents: 5000, totalCents: 10000 }],
          totals: { discountCents: 500, taxRateBps: 825 },
          customerMessage: 'Thanks!',
        }),
        { status: 200 },
      ),
    );

    const est = await getEstimate(client, 'est-1');

    const [path, init] = client.mock.calls[0] as [string, RequestInit | undefined];
    expect(path).toBe('/api/estimates/est-1');
    expect(init).toBeUndefined();
    expect(est.jobId).toBe('job-1');
    expect(est.version).toBe(3);
    // Cents come back as the exact integers persisted (no float coercion).
    expect(est.lineItems[0].unitPriceCents).toBe(5000);
    expect(est.lineItems[0].totalCents).toBe(10000);
    expect(est.totals?.discountCents).toBe(500);
  });

  it('throws on a non-ok response', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(getEstimate(client, 'missing')).rejects.toThrow(/getEstimate: 404/);
  });
});

describe('updateEstimate', () => {
  it('PATCHes /api/estimates/:id with expectedVersion and full server line items', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'est-1' }), { status: 200 }),
    );

    const result = await updateEstimate(client, 'est-1', {
      lineItems,
      discountCents: 500,
      taxRateBps: 825,
      customerMessage: 'Updated',
      expectedVersion: 4,
    });

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/estimates/est-1');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.expectedVersion).toBe(4);
    expect(body.discountCents).toBe(500);
    expect(body.taxRateBps).toBe(825);
    expect(body.customerMessage).toBe('Updated');
    // Line items are mapped to the full server contract shape.
    expect(body.lineItems).toEqual([
      {
        id: 'li-1',
        description: 'Labor',
        quantity: 2,
        unitPriceCents: 5000,
        totalCents: 10000,
        sortOrder: 0,
        taxable: false,
        catalogItemId: 'cat-1',
      },
    ]);
    expect(result.id).toBe('est-1');
  });

  it('surfaces the server edit-lock message verbatim on a 409 (deposit paid)', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'CONFLICT',
          message: 'Estimate is locked: a deposit has already been paid. Clone it to a new estimate to make changes.',
        }),
        { status: 409 },
      ),
    );

    await expect(
      updateEstimate(client, 'est-1', { lineItems, expectedVersion: 4 }),
    ).rejects.toThrow(/a deposit has already been paid/);
  });

  it('falls back to the status code when the error body is not JSON', async () => {
    const client = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));

    await expect(
      updateEstimate(client, 'est-1', { lineItems, expectedVersion: 4 }),
    ).rejects.toThrow(/updateEstimate: 500/);
  });
});
