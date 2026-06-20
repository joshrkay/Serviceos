/**
 * Postgres integration — customer thread get-or-create is race-safe.
 *
 * Pins migration 198's partial unique index (one active thread per
 * tenant+entity) plus getOrCreateCustomerConversation's 23505 recovery: many
 * concurrent opens for the same customer (a Message tap racing the outbound-call
 * logger) must collapse to a SINGLE active thread, never duplicates. The unit
 * test cannot prove this — it needs the real unique index to reject the losers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgConversationRepository } from '../../src/conversations/pg-conversation';
import { getOrCreateCustomerConversation } from '../../src/conversations/conversation-service';

describe('Postgres integration — customer thread get-or-create race', () => {
  let pool: Pool;
  let repo: PgConversationRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgConversationRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('collapses concurrent opens for the same customer to one active thread', async () => {
    const customerId = `cust-${crypto.randomUUID()}`;
    const input = { tenantId: tenant.tenantId, customerId, createdBy: tenant.userId, actorRole: 'owner' };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => getOrCreateCustomerConversation(repo, input)),
    );

    // Exactly one creator; everyone resolves to the same thread id.
    const ids = new Set(results.map((r) => r.conversation.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);

    // And the DB holds exactly one active thread for that entity.
    const threads = await repo.findByEntity(tenant.tenantId, 'customer', customerId);
    const active = threads.filter((t) => t.status !== 'archived');
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe([...ids][0]);
  });

  it('reuses the existing thread on a subsequent open (created=false)', async () => {
    const customerId = `cust-${crypto.randomUUID()}`;
    const input = { tenantId: tenant.tenantId, customerId, createdBy: tenant.userId };

    const first = await getOrCreateCustomerConversation(repo, input);
    expect(first.created).toBe(true);

    const second = await getOrCreateCustomerConversation(repo, input);
    expect(second.created).toBe(false);
    expect(second.conversation.id).toBe(first.conversation.id);
  });
});
