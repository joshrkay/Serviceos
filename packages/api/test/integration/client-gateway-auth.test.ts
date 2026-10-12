/**
 * Postgres integration — client WebSocket gateway (/api/ws) membership gate.
 *
 * The WS gateway now runs the SAME DB-authoritative membership decision as
 * the HTTP chain (decideMembership → createAuthorizationLoader). This pins
 * that a REAL suspended / soft-deleted `users` row is refused at connect and
 * flips an open connection's re-check to 'revoked', and that the DB role (not
 * the token's claim) is what the connection carries. Token verification is
 * stubbed; everything from the membership lookup down is real.
 */
import http from 'http';
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createAuthorizationLoader } from '../../src/auth/authorization-loader';
import { setAuthorizationLoader } from '../../src/middleware/auth';
import { createClientGatewayAuth } from '../../src/ws/client-gateway-auth';
import type { ClerkTokenPayload } from '../../src/auth/clerk';

describe('Postgres integration — client gateway membership gate', () => {
  let pool: Pool;
  let tenantId: string;
  let clerkId: string;

  const req = { url: '/api/ws?token=t', headers: {} } as unknown as http.IncomingMessage;

  const gatewayAuth = () =>
    createClientGatewayAuth({
      env: { NODE_ENV: 'production', CLERK_PUBLISHABLE_KEY: 'pk' },
      verifyRs256: async (): Promise<ClerkTokenPayload> => ({
        sub: clerkId,
        sid: 'sess',
        tenant_id: tenantId,
        role: 'owner',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

  beforeAll(async () => {
    pool = await getSharedTestDb();
    const t = await createTestTenant(pool);
    tenantId = t.tenantId;
    clerkId = `user_${crypto.randomUUID()}`;
    await pool.query(`UPDATE users SET clerk_user_id = $1 WHERE tenant_id = $2 AND id = $3`, [
      clerkId,
      tenantId,
      t.userId,
    ]);
    setAuthorizationLoader(createAuthorizationLoader(pool));
  });

  afterEach(async () => {
    await pool.query(
      `UPDATE users SET status = 'active', deleted_at = NULL, role = 'owner'
        WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantId, clerkId],
    );
  });

  afterAll(async () => {
    setAuthorizationLoader(null);
    await closeSharedTestDb();
  });

  it('accepts an active member and carries the DB role, not the token claim', async () => {
    await pool.query(
      `UPDATE users SET role = 'technician' WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantId, clerkId],
    );
    const result = await gatewayAuth().authenticate(req);
    expect(result?.tenantId).toBe(tenantId);
    expect(result?.role).toBe('technician');
  });

  it('refuses a real suspended membership row at connect', async () => {
    await pool.query(
      `UPDATE users SET status = 'suspended' WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantId, clerkId],
    );
    expect(await gatewayAuth().authenticate(req)).toBeNull();
  });

  it('refuses a real soft-deleted membership row at connect', async () => {
    await pool.query(
      `UPDATE users SET deleted_at = NOW() WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantId, clerkId],
    );
    expect(await gatewayAuth().authenticate(req)).toBeNull();
  });

  it('re-check flips to revoked once the row is suspended mid-session', async () => {
    const auth = gatewayAuth();
    const conn = await auth.authenticate(req);
    expect(conn).not.toBeNull();
    expect(await auth.revalidate(conn!)).toBe('ok');
    await pool.query(
      `UPDATE users SET status = 'suspended' WHERE tenant_id = $1 AND clerk_user_id = $2`,
      [tenantId, clerkId],
    );
    expect(await auth.revalidate(conn!)).toBe('revoked');
  });
});
