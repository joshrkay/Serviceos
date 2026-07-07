/**
 * Postgres integration — conversation_links (P0-037, migration 233).
 *
 * PgConversationLinkRepository's unit-level behavior is trivial; what a
 * mocked pool cannot prove (and what shipped broken before — see
 * docs/solutions/database-issues/mocked-pool-hides-real-schema-mismatch.md):
 *
 *   1. The table/columns the SQL references actually exist as migrated.
 *   2. ON CONFLICT idempotency on the four-column unique key.
 *   3. RLS + FORCE — the unprivileged app role only sees its own tenant's
 *      links.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  asTenant,
  closeSharedTestDb,
  createTestTenant,
  ensureRlsAppRole,
  getSharedTestDb,
} from './shared';
import { PgConversationLinkRepository } from '../../src/conversations/pg-conversation-link';
import { linkConversation } from '../../src/conversations/linkage';

describe('conversation_links — integration', () => {
  let pool: Pool;
  let repo: PgConversationLinkRepository;
  let tenantA: { tenantId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgConversationLinkRepository(pool);
    await ensureRlsAppRole(pool);
  });

  beforeEach(async () => {
    tenantA = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('creates a link and round-trips it via findByConversation and findByEntity', async () => {
    const conversationId = uuidv4();
    const voiceSessionId = uuidv4();

    const created = await linkConversation(
      {
        tenantId: tenantA.tenantId,
        conversationId,
        entityType: 'voice_session',
        entityId: voiceSessionId,
      },
      repo,
    );
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeInstanceOf(Date);

    const byConversation = await repo.findByConversation(tenantA.tenantId, conversationId);
    expect(byConversation).toHaveLength(1);
    expect(byConversation[0]).toMatchObject({
      tenantId: tenantA.tenantId,
      conversationId,
      entityType: 'voice_session',
      entityId: voiceSessionId,
    });

    const byEntity = await repo.findByEntity(
      tenantA.tenantId,
      'voice_session',
      voiceSessionId,
    );
    expect(byEntity).toHaveLength(1);
    expect(byEntity[0].conversationId).toBe(conversationId);
  });

  it('duplicate create with an identical four-tuple is a no-op returning the canonical row', async () => {
    const conversationId = uuidv4();
    const sid = `SM_${uuidv4()}`;

    const first = await linkConversation(
      { tenantId: tenantA.tenantId, conversationId, entityType: 'sms_conversation', entityId: sid },
      repo,
    );
    const second = await linkConversation(
      { tenantId: tenantA.tenantId, conversationId, entityType: 'sms_conversation', entityId: sid },
      repo,
    );

    // The retry returns the FIRST row (canonical), not a duplicate.
    expect(second.id).toBe(first.id);
    const links = await repo.findByConversation(tenantA.tenantId, conversationId);
    expect(links).toHaveLength(1);
  });

  it('delete removes the link and returns false for unknown ids', async () => {
    const conversationId = uuidv4();
    const link = await linkConversation(
      { tenantId: tenantA.tenantId, conversationId, entityType: 'customer', entityId: uuidv4() },
      repo,
    );

    expect(await repo.delete(tenantA.tenantId, link.id)).toBe(true);
    expect(await repo.findByConversation(tenantA.tenantId, conversationId)).toHaveLength(0);
    expect(await repo.delete(tenantA.tenantId, link.id)).toBe(false);
  });

  it('RLS: the unprivileged app role cannot read another tenant’s links', async () => {
    const tenantB = await createTestTenant(pool);
    const conversationId = uuidv4();
    await linkConversation(
      {
        tenantId: tenantA.tenantId,
        conversationId,
        entityType: 'voice_session',
        entityId: uuidv4(),
      },
      repo,
    );

    // Under tenant B's GUC with the NOBYPASSRLS role, tenant A's link must be
    // invisible even without any WHERE tenant_id clause — the policy is the gate.
    const visibleToB = await asTenant(pool, tenantB.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM conversation_links WHERE conversation_id = $1`,
        [conversationId],
      );
      return rows;
    });
    expect(visibleToB).toHaveLength(0);

    const visibleToA = await asTenant(pool, tenantA.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM conversation_links WHERE conversation_id = $1`,
        [conversationId],
      );
      return rows;
    });
    expect(visibleToA).toHaveLength(1);
  });
});
