/**
 * Postgres integration — message templates persist to a real, tenant-scoped
 * table (migration 207). Pins the real columns and proves cross-tenant
 * isolation under FORCE RLS (Story 10.5).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgMessageTemplateRepository } from '../../src/messaging/pg-message-template';
import type { MessageTemplate } from '../../src/messaging/message-template';

function template(tenantId: string, createdBy: string): MessageTemplate {
  const now = new Date();
  return {
    id: randomUUID(),
    tenantId,
    name: 'On the way',
    category: 'appointment',
    channel: 'sms',
    body: 'Hi {{customer_name}}, your tech is on the way — ETA {{eta}}.',
    isActive: true,
    usageCount: 0,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

describe('Postgres integration — message templates', () => {
  let pool: Pool;
  let repo: PgMessageTemplateRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgMessageTemplateRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('creates and reads back a template (pins the real columns)', async () => {
    const created = await repo.create(template(tenant.tenantId, tenant.userId));

    const found = await repo.findById(tenant.tenantId, created.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('On the way');
    expect(found!.category).toBe('appointment');
    expect(found!.channel).toBe('sms');
    expect(found!.body).toContain('{{customer_name}}');
    expect(found!.isActive).toBe(true);
    expect(found!.usageCount).toBe(0);
  });

  it('filters by channel and increments usage', async () => {
    const email = template(tenant.tenantId, tenant.userId);
    email.channel = 'email';
    email.name = 'Email follow-up';
    await repo.create(email);

    const smsOnly = await repo.findByTenant(tenant.tenantId, { channel: 'sms' });
    expect(smsOnly.every((t) => t.channel === 'sms')).toBe(true);
    expect(smsOnly.some((t) => t.channel === 'email')).toBe(false);

    const target = smsOnly[0];
    await repo.incrementUsage(tenant.tenantId, target.id);
    const after = await repo.findById(tenant.tenantId, target.id);
    expect(after!.usageCount).toBe(1);
  });

  it('updates and deletes within the tenant', async () => {
    const created = await repo.create(template(tenant.tenantId, tenant.userId));
    const updated = await repo.update(tenant.tenantId, created.id, {
      isActive: false,
      body: 'Updated {{customer_name}}',
    });
    expect(updated!.isActive).toBe(false);
    expect(updated!.body).toBe('Updated {{customer_name}}');

    const deleted = await repo.delete(tenant.tenantId, created.id);
    expect(deleted).toBe(true);
    expect(await repo.findById(tenant.tenantId, created.id)).toBeNull();
  });

  it('does not leak a template across tenants', async () => {
    const other = await createTestTenant(pool);
    const created = await repo.create(template(tenant.tenantId, tenant.userId));

    expect(await repo.findById(other.tenantId, created.id)).toBeNull();
    const otherList = await repo.findByTenant(other.tenantId);
    expect(otherList.some((t) => t.id === created.id)).toBe(false);

    // Cross-tenant update/delete must be no-ops.
    const updated = await repo.update(other.tenantId, created.id, {
      name: 'hijacked',
    });
    expect(updated).toBeNull();
    expect(await repo.delete(other.tenantId, created.id)).toBe(false);
  });
});
