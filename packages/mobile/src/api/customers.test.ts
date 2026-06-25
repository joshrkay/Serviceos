import { describe, expect, it, vi } from 'vitest';
import { createCustomer, updateCustomer } from './customers';

describe('createCustomer', () => {
  it('POSTs /api/customers with the input body', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'c1', firstName: 'Jane', lastName: 'Doe' }), { status: 201 }),
    );

    const result = await createCustomer(client, {
      firstName: 'Jane',
      lastName: 'Doe',
      primaryPhone: '555-0100',
    });

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/customers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      primaryPhone: '555-0100',
    });
    expect(result.id).toBe('c1');
  });

  it('throws on a non-ok response', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));

    await expect(
      createCustomer(client, { firstName: 'Jane', lastName: 'Doe' }),
    ).rejects.toThrow(/createCustomer: 400/);
  });
});

describe('updateCustomer', () => {
  it('PUTs /api/customers/:id with the input body', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'c1', firstName: 'Jane', lastName: 'Smith' }), { status: 200 }),
    );

    const result = await updateCustomer(client, 'c1', { lastName: 'Smith' });

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/customers/c1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ lastName: 'Smith' });
    expect(result.lastName).toBe('Smith');
  });

  it('throws on a non-ok response', async () => {
    const client = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    await expect(updateCustomer(client, 'missing', { firstName: 'Jane' })).rejects.toThrow(
      /updateCustomer: 404/,
    );
  });
});
