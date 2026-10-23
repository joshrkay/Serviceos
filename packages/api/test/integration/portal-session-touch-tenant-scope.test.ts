/**
 * Postgres integration — `PgPortalSessionRepository.touchLastAccessed` writes
 * under the session's tenant context (raw-pg audit 2026-10-23,
 * `missing_tenant_filter`).
 *
 * It used to run through `withClient`: `UPDATE portal_sessions SET
 * last_accessed_at = $1 WHERE id = $2` as the privileged connection principal,
 * with no GUC, no runtime role and no tenant predicate, on a FORCE RLS table.
 * Its only caller (`resolvePortalSession`) already holds the tenant id from the
 * token lookup, so the write now takes it and runs inside `withTenant`.
 *
 * Only a real RLS-subject role in real Postgres shows that a session id from
 * another tenant is untouched; a mocked Pool cannot.
 */
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { PgPortalSessionRepository } from '../../src/portal/pg-portal-session';

let pool: Pool;
let repo: PgPortalSessionRepository;
const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;
const createdTenantIds: string[] = [];

async function tenantWithSession(): Promise<{ tenantId: string; sessionId: string }> {
  const { tenantId, userId } = await createTestTenant(pool);
  createdTenantIds.push(tenantId);
  const sessionId = crypto.randomUUID();
  await repo.create({
    id: sessionId,
    tenantId,
    customerId: crypto.randomUUID(),
    tokenHash: crypto.randomBytes(32).toString('hex'),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdBy: userId,
    createdAt: new Date(),
  });
  return { tenantId, sessionId };
}

async function lastAccessedAt(sessionId: string): Promise<Date | null> {
  // Read back as the superuser pool (bypasses RLS): the assertion is about
  // what the repository wrote, not about what a scoped read would show.
  const { rows } = await pool.query<{ last_accessed_at: Date | null }>(
    'SELECT last_accessed_at FROM portal_sessions WHERE id = $1',
    [sessionId],
  );
  return rows[0]?.last_accessed_at ?? null;
}

beforeAll(async () => {
  pool = await getSharedTestDb();
  repo = new PgPortalSessionRepository(pool);
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  for (const tenantId of createdTenantIds) {
    await pool.query('DELETE FROM portal_sessions WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('PgPortalSessionRepository.touchLastAccessed is tenant-scoped (real Postgres)', () => {
  it('stamps its own session under the RLS runtime role', async () => {
    process.env.RLS_RUNTIME_ROLE = 'true';
    const a = await tenantWithSession();
    const at = new Date('2026-10-23T09:00:00.000Z');

    await repo.touchLastAccessed(a.tenantId, a.sessionId, at);

    expect((await lastAccessedAt(a.sessionId))?.toISOString()).toBe(at.toISOString());
  });

  it("leaves another tenant's session untouched, with the runtime role on and off", async () => {
    const a = await tenantWithSession();
    const b = await tenantWithSession();

    for (const flag of ['true', undefined] as const) {
      if (flag) process.env.RLS_RUNTIME_ROLE = flag;
      else delete process.env.RLS_RUNTIME_ROLE;
      // Tenant B's context with tenant A's session id: before the fix this ran
      // as the principal and stamped A's row.
      await repo.touchLastAccessed(b.tenantId, a.sessionId, new Date());
      expect(await lastAccessedAt(a.sessionId)).toBeNull();
    }
  });
});
