import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { Pool } from 'pg';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { devAuthBypass } from '../../src/auth/dev-auth-bypass';
import { PgTenantRepository } from '../../src/auth/pg-tenant';
import { PgUserRepository } from '../../src/users/pg-user';
import { resolveCanonicalUser } from '../../src/users/user';
import { getSharedTestDb } from './shared';

describe('Postgres dev-auth user bootstrap', () => {
  let pool: Pool;
  beforeAll(async () => { pool = await getSharedTestDb(); });
  afterEach(() => vi.unstubAllEnvs());

  it('creates a resolvable technician once and keeps it tenant-scoped', async () => {
    vi.stubEnv('NODE_ENV', 'dev');
    vi.stubEnv('DEV_AUTH_BYPASS', 'true');
    const subject = `dev_tech_${randomUUID()}`;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none' })}.${encode({ sub: subject, role: 'technician' })}.x`;
    const request = () => ({ headers: { authorization: `Bearer ${token}` } }) as AuthenticatedRequest;
    const userRepo = new PgUserRepository(pool);
    const middleware = devAuthBypass({ tenantRepo: new PgTenantRepository(pool), userRepo });
    const req = request();
    await middleware(req, {} as Response, () => undefined);
    expect(req.auth?.canonicalUserId).toBeTruthy();
    const tenantId = req.auth!.tenantId;
    const user = await resolveCanonicalUser(userRepo, tenantId, subject);
    expect(user).toMatchObject({ id: req.auth!.canonicalUserId, clerkUserId: subject,
      tenantId, role: 'technician', canFieldServe: true, status: 'active' });
    const again = request();
    await middleware(again, {} as Response, () => undefined);
    expect(again.auth?.canonicalUserId).toBe(user!.id);
    expect(await userRepo.findByTenant(tenantId)).toHaveLength(1);
    expect(await resolveCanonicalUser(userRepo, randomUUID(), subject)).toBeNull();
  });
});
