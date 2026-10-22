/**
 * Google Business OAuth states carry their own provider (migration 308) and
 * PgOAuthStateRepository.consume() only returns a row minted by the expected
 * flow. Calendar connect is open to any member while Google Business connect
 * is owner-only, and both share one Google OAuth client — so a calendar
 * nonce must not complete the Google Business callback. Pins the real
 * CHECK constraint and the `provider = $2` filter against Postgres.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PgOAuthStateRepository } from '../../src/integrations/calendar-integration';
import { getSharedTestDb } from './shared';

describe('oauth_states flow binding (Postgres)', () => {
  let pool: Pool;
  let tenantId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    const { rows } = await pool.query(
      `INSERT INTO tenants (owner_id, owner_email, name)
       VALUES ($1, $2, 'OAuth flow binding') RETURNING id`,
      [`owner_${randomUUID()}`, `${randomUUID()}@example.com`],
    );
    tenantId = rows[0].id as string;
  });

  it('accepts provider google_business under the CHECK constraint', async () => {
    const repo = new PgOAuthStateRepository(pool);
    const { id } = await repo.create({ tenantId, userId: 'owner-1', provider: 'google_business' });
    const consumed = await repo.consume(id, 'google_business');
    expect(consumed).toMatchObject({ tenantId, userId: 'owner-1', provider: 'google_business' });
  });

  it('refuses a calendar-minted state at the Google Business consume, leaving it usable by calendar', async () => {
    const repo = new PgOAuthStateRepository(pool);
    const { id } = await repo.create({ tenantId, userId: 'tech-1', provider: 'google' });

    expect(await repo.consume(id, 'google_business')).toBeNull();
    expect(await repo.consume(id, 'google')).toMatchObject({ tenantId, userId: 'tech-1' });
    expect(await repo.consume(id, 'google')).toBeNull(); // replay
  });
});
