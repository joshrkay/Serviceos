/**
 * P10-001 — Postgres-backed PortalSession repository.
 *
 * `findByTokenHash` runs via `withClient()` (no tenant context) because
 * the token IS the auth — at lookup time the request hasn't yet chosen
 * a tenant. RLS isn't engaged for this read; isolation is enforced by
 * the unique sha256 hash and the upstream rate limiter.
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { PortalSession, PortalSessionRepository } from './portal-session';

function mapRow(row: Record<string, unknown>): PortalSession {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    customerId: row.customer_id as string,
    tokenHash: row.token_hash as string,
    expiresAt: new Date(row.expires_at as string),
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string) : undefined,
    lastAccessedAt: row.last_accessed_at
      ? new Date(row.last_accessed_at as string)
      : undefined,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
  };
}

export class PgPortalSessionRepository
  extends PgBaseRepository
  implements PortalSessionRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(session: PortalSession): Promise<PortalSession> {
    return this.withTenant(session.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO portal_sessions (
          id, tenant_id, customer_id, token_hash, expires_at,
          revoked_at, last_accessed_at, created_by, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *`,
        [
          session.id,
          session.tenantId,
          session.customerId,
          session.tokenHash,
          session.expiresAt,
          session.revokedAt ?? null,
          session.lastAccessedAt ?? null,
          session.createdBy,
          session.createdAt,
        ],
      );
      return mapRow(result.rows[0]);
    });
  }

  async findByTokenHash(tokenHash: string): Promise<PortalSession | null> {
    // System-level: token-hash lookup relies on the app.portal_token_lookup
    // escape-hatch RLS policy (migration 107). The GUC MUST be set with SET LOCAL
    // (set_config is_local=true) inside the SAME explicit transaction as the
    // SELECT: a set_config(..., true) issued OUTSIDE a BEGIN applies only to the
    // implicit transaction of that one statement and is discarded before the next
    // query — so under an RLS-enforcing role (RLS_RUNTIME_ROLE=true) the policy
    // would evaluate false and the SELECT would return ZERO rows, breaking the
    // customer portal. Mirrors integrations/twilio/phone-number-repository.ts.
    return this.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT set_config('app.portal_token_lookup', 'true', true)");
        const result = await client.query(
          'SELECT * FROM portal_sessions WHERE token_hash = $1',
          [tokenHash],
        );
        await client.query('COMMIT');
        return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
  }

  async findById(tenantId: string, id: string): Promise<PortalSession | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM portal_sessions WHERE tenant_id = $1 AND id = $2',
        [tenantId, id],
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }

  async touchLastAccessed(id: string, at: Date): Promise<void> {
    // System-level update — bypass RLS by using withClient. Safe because
    // the only mutation here is a timestamp on a row already located by
    // its hash, and the route layer already validated the token.
    await this.withClient(async (client) => {
      await client.query(
        'UPDATE portal_sessions SET last_accessed_at = $1 WHERE id = $2',
        [at, id],
      );
    });
  }

  async revoke(
    tenantId: string,
    id: string,
    at: Date,
  ): Promise<PortalSession | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `UPDATE portal_sessions
            SET revoked_at = $1
          WHERE tenant_id = $2 AND id = $3
          RETURNING *`,
        [at, tenantId, id],
      );
      return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
    });
  }
}
