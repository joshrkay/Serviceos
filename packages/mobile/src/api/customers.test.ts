import { describe, expect, it, vi } from 'vitest';
import { addCustomerNote, createCustomer, createServiceLocation, updateCustomer } from './customers';

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

describe('createServiceLocation', () => {
  it('POSTs /api/locations with the customer-scoped address body', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'loc1', street1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701' }),
        { status: 201 },
      ),
    );

    const result = await createServiceLocation(client, {
      customerId: 'c1',
      street1: '1 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      label: 'Rental unit',
    });

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/locations');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      customerId: 'c1',
      street1: '1 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      label: 'Rental unit',
    });
    expect(result.id).toBe('loc1');
  });

  it('surfaces the server message on a validation failure', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'VALIDATION_ERROR', message: 'city is required' }), {
        status: 400,
      }),
    );

    await expect(
      createServiceLocation(client, { customerId: 'c1', street1: '1 Main St', city: '', state: 'TX', postalCode: '78701' }),
    ).rejects.toMatchObject({ message: 'city is required' });
  });
});

describe('addCustomerNote', () => {
  it('POSTs /api/notes with entityType customer and the content', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'n1', entityType: 'customer', entityId: 'c1', content: 'Called back', isPinned: false }),
        { status: 201 },
      ),
    );

    const result = await addCustomerNote(client, { customerId: 'c1', content: 'Called back' });

    const [path, init] = client.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/notes');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      entityType: 'customer',
      entityId: 'c1',
      content: 'Called back',
    });
    expect(result.id).toBe('n1');
  });

  it('includes isPinned when set', async () => {
    const client = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'n2', entityType: 'customer', entityId: 'c1', content: 'Watch this one', isPinned: true }), {
        status: 201,
      }),
    );

    await addCustomerNote(client, { customerId: 'c1', content: 'Watch this one', isPinned: true });

    const [, init] = client.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      entityType: 'customer',
      entityId: 'c1',
      content: 'Watch this one',
      isPinned: true,
    });
  });
});
