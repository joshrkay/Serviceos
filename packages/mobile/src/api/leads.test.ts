import { describe, expect, it, vi } from 'vitest';
import { convertLead, markLeadLost } from './leads';

describe('convertLead', () => {
  it('POSTs /api/leads/:id/convert with an empty body when no address override', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          lead: { id: 'l1', stage: 'won', convertedCustomerId: 'c9' },
          customer: { id: 'c9', displayName: 'Acme' },
          location: { id: 'loc1' },
        }),
        { status: 201 },
      ),
    );

    const result = await convertLead(client, 'l1');

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/leads/l1/convert');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
    expect(result.customer.id).toBe('c9');
  });

  it('sends the address override when provided', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ lead: { id: 'l1' }, customer: { id: 'c9' }, location: { id: 'loc1' } }),
        { status: 201 },
      ),
    );

    await convertLead(client, 'l1', {
      street1: '1 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
    });

    const [, init] = client.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      street1: '1 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
    });
  });

  it('surfaces the server message on conflict (already converted)', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'VALIDATION_ERROR', message: 'Lead has already been converted' }),
        { status: 400 },
      ),
    );

    await expect(convertLead(client, 'l1')).rejects.toMatchObject({
      message: 'Lead has already been converted',
    });
  });
});

describe('markLeadLost', () => {
  it('POSTs /api/leads/:id/lose with the reason', async () => {
    const client = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'l1', stage: 'lost' }), { status: 200 }));

    await markLeadLost(client, 'l1', 'went with a competitor');

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/leads/l1/lose');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'went with a competitor' });
  });

  it('surfaces the server message on failure', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'VALIDATION_ERROR', message: 'reason is required' }), {
        status: 400,
      }),
    );

    await expect(markLeadLost(client, 'l1', '')).rejects.toMatchObject({
      message: 'reason is required',
    });
  });
});
