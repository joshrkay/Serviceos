import { describe, expect, it, vi } from 'vitest';
import { getInteraction, listInteractions } from './interactions';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('listInteractions', () => {
  it('GETs /api/interactions and returns the parsed body', async () => {
    const client = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: 'int-1',
            channel: 'voice_inbound',
            outcome: 'completed',
            callSid: 'CA123',
            startedAt: '2026-06-20T10:00:00Z',
            endedAt: '2026-06-20T10:05:00Z',
            durationSeconds: 300,
            customer: { id: 'cust-1', displayName: 'Acme Plumbing', address: null },
            excerpt: 'Need AC repair',
            transcriptTurnCount: 4,
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      }),
    );

    const result = await listInteractions(client);

    expect(client).toHaveBeenCalledWith('/api/interactions');
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.customer?.displayName).toBe('Acme Plumbing');
    expect(result.total).toBe(1);
  });

  it('appends limit, offset, and customerId query params', async () => {
    const client = vi.fn().mockResolvedValue(jsonResponse({ data: [], total: 0, limit: 10, offset: 5 }));

    await listInteractions(client, { limit: 10, offset: 5, customerId: 'cust-1' });

    expect(client).toHaveBeenCalledWith(
      '/api/interactions?limit=10&offset=5&customerId=cust-1',
    );
  });

  it('throws on a non-ok response', async () => {
    const client = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 500, statusText: 'Server Error' }));

    await expect(listInteractions(client)).rejects.toThrow(/listInteractions: 500/);
  });
});

describe('getInteraction', () => {
  it('GETs /api/interactions/:id and returns the parsed detail', async () => {
    const client = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'int-1',
        channel: 'inapp_voice',
        outcome: 'completed',
        callSid: null,
        startedAt: '2026-06-20T10:00:00Z',
        endedAt: '2026-06-20T10:02:00Z',
        durationSeconds: 120,
        customer: { id: 'cust-1', displayName: 'Jane Doe', address: '123 Main St' },
        excerpt: 'Schedule service',
        transcriptTurnCount: 2,
        transcript: ['caller: Hi', 'agent: How can I help?'],
        endedReason: 'completed',
        costCents: 15,
      }),
    );

    const detail = await getInteraction(client, 'int-1');

    expect(client).toHaveBeenCalledWith('/api/interactions/int-1');
    expect(detail.transcript).toEqual(['caller: Hi', 'agent: How can I help?']);
    expect(detail.customer?.displayName).toBe('Jane Doe');
    expect(detail.costCents).toBe(15);
  });

  it('encodes the interaction id in the path', async () => {
    const client = vi.fn().mockResolvedValue(jsonResponse({ id: 'a/b', transcript: [] }));

    await getInteraction(client, 'a/b');

    expect(client).toHaveBeenCalledWith('/api/interactions/a%2Fb');
  });

  it('throws on a non-ok response', async () => {
    const client = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404, statusText: 'Not Found' }));

    await expect(getInteraction(client, 'missing')).rejects.toThrow(/getInteraction: 404/);
  });
});
