import { z } from 'zod';
import type { Customer } from '@rivet/contracts';
import { CommandError, defineCommand, type CommandCtx } from '../../core/commands';
import { withTenantTransaction, type Db } from '../../core/db';

interface CustomerRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  notes: string | null;
  created_at: Date;
}

function toCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

export const createCustomerCommand = defineCommand({
  name: 'crm.create_customer',
  input: z.object({
    name: z.string().min(1).max(200),
    phone: z.string().min(7).max(20),
    email: z.string().email().optional(),
    address: z.string().max(500).optional(),
    notes: z.string().max(2000).optional(),
  }),
  async run(ctx, input): Promise<Customer> {
    const existing = await ctx.client.query<CustomerRow>(
      `SELECT id, name, phone, email, address, notes, created_at
       FROM customers WHERE tenant_id = $1 AND phone = $2`,
      [ctx.tenantId, input.phone],
    );
    if (existing.rows[0]) {
      throw new CommandError('conflict', `customer with phone ${input.phone} already exists`);
    }
    const { rows } = await ctx.client.query<CustomerRow>(
      `INSERT INTO customers (tenant_id, name, phone, email, address, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, phone, email, address, notes, created_at`,
      [ctx.tenantId, input.name, input.phone, input.email ?? null, input.address ?? null, input.notes ?? null],
    );
    const customer = toCustomer(rows[0]!);
    ctx.emit({
      eventType: 'customer.created',
      entityType: 'customer',
      entityId: customer.id,
      payload: { name: customer.name },
    });
    return customer;
  },
});

export async function listCustomers(db: Db, tenantId: string, search?: string): Promise<Customer[]> {
  return withTenantTransaction(db, tenantId, async (client) => {
    const { rows } = await client.query<CustomerRow>(
      `SELECT id, name, phone, email, address, notes, created_at
       FROM customers
       WHERE tenant_id = $1 AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR phone LIKE '%' || $2 || '%')
       ORDER BY name
       LIMIT 200`,
      [tenantId, search ?? null],
    );
    return rows.map(toCustomer);
  });
}

/**
 * Resolution helper for proposal execution: matches by id, exact phone, or
 * case-insensitive name; creates the customer when no match exists.
 */
export async function resolveOrCreateCustomer(
  ctx: CommandCtx,
  ref: { customerId?: string; name: string; phone?: string },
): Promise<{ id: string; created: boolean }> {
  if (ref.customerId) {
    const byId = await ctx.client.query<{ id: string }>(
      `SELECT id FROM customers WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, ref.customerId],
    );
    if (byId.rows[0]) return { id: byId.rows[0].id, created: false };
  }
  if (ref.phone) {
    const byPhone = await ctx.client.query<{ id: string }>(
      `SELECT id FROM customers WHERE tenant_id = $1 AND phone = $2`,
      [ctx.tenantId, ref.phone],
    );
    if (byPhone.rows[0]) return { id: byPhone.rows[0].id, created: false };
  }
  const byName = await ctx.client.query<{ id: string }>(
    `SELECT id FROM customers WHERE tenant_id = $1 AND lower(name) = lower($2) ORDER BY created_at LIMIT 1`,
    [ctx.tenantId, ref.name],
  );
  if (byName.rows[0]) return { id: byName.rows[0].id, created: false };
  if (!ref.phone) {
    throw new CommandError('invalid', `customer "${ref.name}" not found and no phone provided to create them`);
  }
  const created = await ctx.invoke(createCustomerCommand, { name: ref.name, phone: ref.phone });
  return { id: created.id, created: true };
}
