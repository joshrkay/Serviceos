import { describe, it, expect } from 'vitest';
import {
  InMemoryConnectionRegistry,
  createConnectionRegistry,
} from '../../src/ws/connection-registry';

/**
 * U3b — the REAL InMemoryConnectionRegistry had ZERO direct coverage before this
 * (client-gateway tests used a mock). These pin the cap arithmetic, per-(surface,
 * tenant) isolation, idempotent release, and the REDIS_URL-unset selector — an
 * off-by-one or leaked count would otherwise ship green.
 */
describe('InMemoryConnectionRegistry', () => {
  it('acquires up to the per-tenant cap then rejects', async () => {
    const reg = new InMemoryConnectionRegistry({ perTenantMax: 2 });
    expect(await reg.acquire('s', 't1')).not.toBeNull();
    expect(await reg.acquire('s', 't1')).not.toBeNull();
    expect(await reg.acquire('s', 't1')).toBeNull(); // at cap
    expect(await reg.count('s', 't1')).toBe(2);
  });

  it('isolates counts per (surface, tenant)', async () => {
    const reg = new InMemoryConnectionRegistry({ perTenantMax: 1 });
    await reg.acquire('surfaceA', 't1');
    expect(await reg.acquire('surfaceA', 't1')).toBeNull(); // A/t1 full
    expect(await reg.acquire('surfaceB', 't1')).not.toBeNull(); // B independent
    expect(await reg.acquire('surfaceA', 't2')).not.toBeNull(); // t2 independent
  });

  it('release frees a slot and is idempotent (no double-decrement)', async () => {
    const reg = new InMemoryConnectionRegistry({ perTenantMax: 1 });
    const lease = await reg.acquire('s', 't1');
    expect(await reg.count('s', 't1')).toBe(1);
    await lease!.release();
    expect(await reg.count('s', 't1')).toBe(0);
    await lease!.release(); // idempotent — must NOT drive the count negative
    expect(await reg.count('s', 't1')).toBe(0);
    expect(await reg.acquire('s', 't1')).not.toBeNull(); // slot is free again
  });

  it('refresh is a no-op for in-memory (never expires)', async () => {
    const reg = new InMemoryConnectionRegistry({ perTenantMax: 1 });
    const lease = await reg.acquire('s', 't1');
    await expect(lease!.refresh()).resolves.toBeUndefined();
    expect(await reg.count('s', 't1')).toBe(1);
  });
});

describe('createConnectionRegistry', () => {
  it('returns an InMemory registry (byte-identical) when REDIS_URL is unset', async () => {
    const reg = createConnectionRegistry(undefined, { perTenantMax: 1 });
    expect(reg).toBeInstanceOf(InMemoryConnectionRegistry);
    expect(await reg.acquire('s', 't1')).not.toBeNull();
    expect(await reg.acquire('s', 't1')).toBeNull();
  });

  it('returns synchronously and works immediately even with REDIS_URL set', async () => {
    // Background Redis upgrade can't connect to a bogus URL in unit tests, so it
    // stays in-memory — but the returned registry must function from the first tick.
    const reg = createConnectionRegistry('redis://127.0.0.1:6390', { perTenantMax: 1 });
    expect(await reg.acquire('s', 't1')).not.toBeNull();
    expect(await reg.acquire('s', 't1')).toBeNull();
  });
});
