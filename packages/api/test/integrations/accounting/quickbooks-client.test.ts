import { describe, it, expect, vi } from 'vitest';
import { QuickBooksClient } from '../../../src/integrations/accounting/quickbooks-client';
import { ValidationError } from '../../../src/shared/errors';

type QboLine = { Amount: number; SalesItemLineDetail: { UnitPrice: number } };

function okFetch(responseBody: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function clientWith(fetchFn: typeof fetch): QuickBooksClient {
  return new QuickBooksClient('realm-1', 'token-1', fetchFn, 'production');
}

describe('QuickBooksClient.createSalesReceipt money split', () => {
  it('splits an uneven total in integer cents that sum exactly to the total', async () => {
    const fetchFn = okFetch({ SalesReceipt: { Id: 'sr-1' } });
    const client = clientWith(fetchFn as unknown as typeof fetch);

    await client.createSalesReceipt(
      {
        customerRefId: 'c-1',
        docNumber: 'INV-1',
        totalCents: 10000, // $100.00 across 3 lines: 33.34 + 33.33 + 33.33
        lineDescriptions: ['a', 'b', 'c'],
        txnDate: '2026-07-06',
      },
      'idem-1',
    );

    const payload = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    const lines = payload.Line as QboLine[];
    expect(lines.map((l) => l.Amount)).toEqual([33.34, 33.33, 33.33]);
    expect(lines.map((l) => l.SalesItemLineDetail.UnitPrice)).toEqual([33.34, 33.33, 33.33]);
    // The QBO validation rule this guards: Σ line amounts === TotalAmt.
    const sumCents = lines.reduce((s, l) => s + Math.round(l.Amount * 100), 0);
    expect(sumCents).toBe(10000);
    expect(payload.TotalAmt).toBe(100);
  });

  it('conserves the total across many awkward splits', async () => {
    for (const [totalCents, lineCount] of [
      [10001, 3],
      [1, 2],
      [99999, 7],
      [500, 6],
    ] as const) {
      const fetchFn = okFetch({ SalesReceipt: { Id: 'sr-x' } });
      const client = clientWith(fetchFn as unknown as typeof fetch);
      await client.createSalesReceipt(
        {
          customerRefId: 'c-1',
          docNumber: 'INV-x',
          totalCents,
          lineDescriptions: Array.from({ length: lineCount }, (_, i) => `line-${i}`),
          txnDate: '2026-07-06',
        },
        'idem-x',
      );
      const payload = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
      const sumCents = (payload.Line as QboLine[]).reduce(
        (s, l) => s + Math.round(l.Amount * 100),
        0,
      );
      expect(sumCents).toBe(totalCents);
      for (const line of payload.Line as QboLine[]) {
        // Every line is a whole number of cents — never a fractional-cent float.
        expect(Math.round(line.Amount * 100) / 100).toBe(line.Amount);
      }
    }
  });

  it('defaults to a single "Services" line carrying the full total', async () => {
    const fetchFn = okFetch({ SalesReceipt: { Id: 'sr-2' } });
    const client = clientWith(fetchFn as unknown as typeof fetch);
    await client.createSalesReceipt(
      {
        customerRefId: 'c-1',
        docNumber: 'INV-2',
        totalCents: 12345,
        lineDescriptions: [],
        txnDate: '2026-07-06',
      },
      'idem-2',
    );
    const payload = JSON.parse((fetchFn.mock.calls[0][1] as RequestInit).body as string);
    expect(payload.Line).toHaveLength(1);
    expect(payload.Line[0].Amount).toBe(123.45);
  });
});

describe('QuickBooksClient.request error handling', () => {
  it('maps a non-JSON error body to a ValidationError instead of a SyntaxError', async () => {
    const fetchFn = vi.fn(async () =>
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const client = clientWith(fetchFn as unknown as typeof fetch);
    await expect(
      client.createCustomer({ displayName: 'X' }, 'idem-3'),
    ).rejects.toThrow(ValidationError);
    await expect(
      client.createCustomer({ displayName: 'X' }, 'idem-3'),
    ).rejects.toThrow('QuickBooks API 502');
  });
});
