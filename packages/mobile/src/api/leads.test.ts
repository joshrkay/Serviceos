import { describe, expect, it, vi } from 'vitest';
import { convertLead, loseLead } from './leads';

describe('convertLead', () => {
  it('POSTs /api/leads/:id/convert with an empty body and returns the new customer id', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ customer: { id: 'cust-1' }, location: { id: 'loc-1' } }), { status: 201 }),
    );

    const result = await convertLead(client, 'lead-1');

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/leads/lead-1/convert');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
    expect(result.customerId).toBe('cust-1');
  });

  it('forwards the address when provided', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ customer: { id: 'cust-2' } }), { status: 201 }),
    );

    await convertLead(client, 'lead-1', { street1: '12 Oak', city: 'Austin', state: 'TX', postalCode: '78701' });

    const [, init] = client.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      street1: '12 Oak',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
    });
  });

  it('surfaces the SERVICE_LOCATION_REQUIRED message', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'VALIDATION_ERROR', message: 'A service location is required to convert this lead' }),
        { status: 400 },
      ),
    );

    await expect(convertLead(client, 'lead-1')).rejects.toThrow(/service location is required/i);
  });
});

describe('loseLead', () => {
  it('POSTs /api/leads/:id/lose with the reason', async () => {
    const client = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await loseLead(client, 'lead-1', 'went with a competitor');

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/leads/lead-1/lose');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'went with a competitor' });
  });

  it('surfaces the server message on failure', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'VALIDATION_ERROR', message: 'Reason is required' }), { status: 400 }),
    );

    await expect(loseLead(client, 'lead-1', '')).rejects.toThrow(/Reason is required/);
  });
});
