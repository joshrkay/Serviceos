import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PhoneRateLimiter } from '../../src/shared/rate-limit/phone-rate-limit';

describe('Postgres integration — PhoneRateLimiter (P0-036)', () => {
  let pool: Pool;
  let limiter: PhoneRateLimiter;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    limiter = new PhoneRateLimiter(pool);
    tenant = await createTestTenant(pool);
  });

  it('consume → consume → deny (limit=2)', async () => {
    const key = `+1555${Date.now()}`;
    expect(await limiter.tryConsume(tenant.tenantId, 'consume_deny', key, 2, 60_000)).toBe(true);
    expect(await limiter.tryConsume(tenant.tenantId, 'consume_deny', key, 2, 60_000)).toBe(true);
    expect(await limiter.tryConsume(tenant.tenantId, 'consume_deny', key, 2, 60_000)).toBe(false);
  });

  it('window expiry — count resets for the same key after windowMs', async () => {
    const key = `+1555${Date.now()}`;
    // Cutoff uses host Date.now(); window_start uses Postgres NOW(). Under
    // Colima/testcontainers those clocks can diverge by tens–hundreds of ms,
    // so sub-second windows flake both ways (deny never sticks, or never
    // expires). A 1s window + 1.5s wait is still cheap for integration and
    // absorbs realistic skew.
    const windowMs = 1_000;
    expect(await limiter.tryConsume(tenant.tenantId, 'expiry', key, 1, windowMs)).toBe(true);
    expect(await limiter.tryConsume(tenant.tenantId, 'expiry', key, 1, windowMs)).toBe(false);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await limiter.tryConsume(tenant.tenantId, 'expiry', key, 1, windowMs)).toBe(true);
  });

  it('distinct scopes count independently for the same key', async () => {
    const key = `+1555${Date.now()}`;
    expect(await limiter.tryConsume(tenant.tenantId, 'sms_recovery', key, 1, 60_000)).toBe(true);
    // Same key, same limit, different scope — must not be throttled by the above.
    expect(await limiter.tryConsume(tenant.tenantId, 'verify_code', key, 1, 60_000)).toBe(true);
    // Re-consuming within the same scope is denied.
    expect(await limiter.tryConsume(tenant.tenantId, 'sms_recovery', key, 1, 60_000)).toBe(false);
  });

  it('distinct tenants count independently (RLS-isolated)', async () => {
    const other = await createTestTenant(pool);
    const key = `+1555${Date.now()}`;
    expect(await limiter.tryConsume(tenant.tenantId, 'tenant_iso', key, 1, 60_000)).toBe(true);
    // Same scope+key under a different tenant is a separate counter.
    expect(await limiter.tryConsume(other.tenantId, 'tenant_iso', key, 1, 60_000)).toBe(true);
    expect(await limiter.tryConsume(tenant.tenantId, 'tenant_iso', key, 1, 60_000)).toBe(false);
  });

  it('concurrent calls — 10 parallel with limit=3 allow exactly 3', async () => {
    const key = `+1555${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        limiter.tryConsume(tenant.tenantId, 'concurrency', key, 3, 60_000),
      ),
    );
    expect(results.filter((allowed) => allowed)).toHaveLength(3);
  });

  it('limit <= 0 always denies', async () => {
    const key = `+1555${Date.now()}`;
    expect(await limiter.tryConsume(tenant.tenantId, 'zero', key, 0, 60_000)).toBe(false);
  });
});
