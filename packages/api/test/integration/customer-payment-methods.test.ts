/**
 * Postgres integration — saved customer payment methods (#6 phase 4).
 *
 * Pins the real migration-176 columns, the unique (tenant_id,
 * stripe_payment_method_id) constraint, the atomic setDefault, and tenant
 * isolation. The in-memory repo can't prove the SQL matches the schema.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerPaymentMethodRepository } from '../../src/payments/pg-customer-payment-method';
import type { CustomerPaymentMethod } from '../../src/payments/customer-payment-method';

async function createCustomer(pool: Pool, tenantId: string, createdBy: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, $3, $4)`,
    [id, tenantId, 'Acme Co', createdBy],
  );
  return id;
}

function makePm(
  tenantId: string,
  customerId: string,
  overrides: Partial<CustomerPaymentMethod> = {},
): CustomerPaymentMethod {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    tenantId,
    customerId,
    stripeCustomerId: 'cus_x',
    stripePaymentMethodId: `pm_${crypto.randomUUID()}`,
    brand: 'visa',
    last4: '4242',
    expMonth: 12,
    expYear: 2031,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Postgres integration — customer payment methods', () => {
  let pool: Pool;
  let repo: PgCustomerPaymentMethodRepository;
  let tenant: { tenantId: string; userId: string };
  let other: { tenantId: string; userId: string };
  let customerId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgCustomerPaymentMethodRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
    customerId = await createCustomer(pool, tenant.tenantId, tenant.userId);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('round-trips a saved card (ids + display metadata, no raw card data)', async () => {
    const created = await repo.create(makePm(tenant.tenantId, customerId, { isDefault: true }));
    const def = await repo.findDefaultForCustomer(tenant.tenantId, customerId);
    expect(def?.stripePaymentMethodId).toBe(created.stripePaymentMethodId);
    expect(def?.brand).toBe('visa');
    expect(def?.last4).toBe('4242');
    expect(def?.expMonth).toBe(12);
    expect(def?.expYear).toBe(2031);
  });

  it('does not leak across tenants', async () => {
    const created = await repo.create(makePm(tenant.tenantId, customerId));
    expect(
      await repo.findByStripePaymentMethodId(other.tenantId, created.stripePaymentMethodId),
    ).toBeNull();
  });

  it('reuses the Stripe customer id for a customer', async () => {
    const t = await createTestTenant(pool);
    const c = await createCustomer(pool, t.tenantId, t.userId);
    await repo.create(makePm(t.tenantId, c, { stripeCustomerId: 'cus_shared' }));
    expect(await repo.findStripeCustomerId(t.tenantId, c)).toBe('cus_shared');
  });

  it('setDefault flips exactly one card default, atomically', async () => {
    const t = await createTestTenant(pool);
    const c = await createCustomer(pool, t.tenantId, t.userId);
    await repo.create(makePm(t.tenantId, c, { isDefault: true }));
    const b = await repo.create(makePm(t.tenantId, c, { isDefault: false }));
    await repo.setDefault(t.tenantId, b.id);
    const list = await repo.findByCustomer(t.tenantId, c);
    expect(list.filter((p) => p.isDefault).map((p) => p.id)).toEqual([b.id]);
  });

  it('is idempotent on (tenant_id, stripe_payment_method_id) — a duplicate save no-ops to the existing row', async () => {
    const first = await repo.create(
      makePm(tenant.tenantId, customerId, { stripePaymentMethodId: 'pm_dup' }),
    );
    // A racing/duplicate save with a different row id must NOT throw and must
    // NOT create a second row — it returns the existing (winning) row.
    const second = await repo.create(
      makePm(tenant.tenantId, customerId, { stripePaymentMethodId: 'pm_dup' }),
    );
    expect(second.id).toBe(first.id);
    const all = await repo.findByCustomer(tenant.tenantId, customerId);
    expect(all.filter((p) => p.stripePaymentMethodId === 'pm_dup')).toHaveLength(1);
  });
});
