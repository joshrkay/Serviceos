import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createThresholdResolver,
  noopThresholdResolver,
} from '../../src/proposals/threshold-resolver';
import {
  InMemorySettingsRepository,
  ensureTenantSettings,
} from '../../src/settings/settings';

const TENANT = 'tenant-thresh';

describe('createThresholdResolver — Tier 4 PR B', () => {
  let repo: InMemorySettingsRepository;

  beforeEach(async () => {
    repo = new InMemorySettingsRepository();
  });

  it('returns undefined when the tenant has no settings row', async () => {
    const resolve = createThresholdResolver(repo, { ttlMs: 0 });
    expect(await resolve(TENANT)).toBeUndefined();
  });

  it('returns undefined when the tenant has settings but no override', async () => {
    await ensureTenantSettings(TENANT, repo, { businessName: 'Test' });
    const resolve = createThresholdResolver(repo, { ttlMs: 0 });
    expect(await resolve(TENANT)).toBeUndefined();
  });

  it('returns the persisted override when present', async () => {
    await ensureTenantSettings(TENANT, repo, { businessName: 'Test' });
    await repo.update(TENANT, {
      autoApproveThreshold: { supervisor: 0.95, both: 0.97, tech: 0.99 },
    });
    const resolve = createThresholdResolver(repo, { ttlMs: 0 });
    const override = await resolve(TENANT);
    expect(override).toEqual({ supervisor: 0.95, both: 0.97, tech: 0.99 });
  });

  it('caches the resolved override per tenant within the TTL', async () => {
    await ensureTenantSettings(TENANT, repo, { businessName: 'Test' });
    await repo.update(TENANT, { autoApproveThreshold: { supervisor: 0.91 } });
    const findSpy = vi.spyOn(repo, 'findByTenant');

    const resolve = createThresholdResolver(repo, { ttlMs: 60_000 });
    await resolve(TENANT);
    await resolve(TENANT);
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes the cache after the TTL expires', async () => {
    await ensureTenantSettings(TENANT, repo, { businessName: 'Test' });
    let nowMs = 1_000_000;
    const findSpy = vi.spyOn(repo, 'findByTenant');

    const resolve = createThresholdResolver(repo, {
      ttlMs: 1_000,
      now: () => nowMs,
    });
    await resolve(TENANT);
    nowMs += 5_000;
    await resolve(TENANT);
    expect(findSpy).toHaveBeenCalledTimes(2);
  });

  it('caches negative results so a missing override does not re-query every turn', async () => {
    const findSpy = vi.spyOn(repo, 'findByTenant');
    const resolve = createThresholdResolver(repo, { ttlMs: 60_000 });
    expect(await resolve(TENANT)).toBeUndefined();
    expect(await resolve(TENANT)).toBeUndefined();
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it('isolates tenants — A’s override is invisible to B', async () => {
    await ensureTenantSettings(TENANT, repo, { businessName: 'A' });
    await ensureTenantSettings('tenant-other', repo, { businessName: 'B' });
    await repo.update(TENANT, { autoApproveThreshold: { supervisor: 0.85 } });
    const resolve = createThresholdResolver(repo, { ttlMs: 0 });
    expect(await resolve(TENANT)).toEqual({ supervisor: 0.85 });
    expect(await resolve('tenant-other')).toBeUndefined();
  });

  it('returns undefined (does not throw) when the repo throws', async () => {
    const failingRepo = {
      ...repo,
      findByTenant: async () => {
        throw new Error('simulated DB outage');
      },
    } as unknown as InMemorySettingsRepository;
    const resolve = createThresholdResolver(failingRepo, { ttlMs: 0 });
    expect(await resolve(TENANT)).toBeUndefined();
  });

  it('returns undefined when tenantId is empty', async () => {
    const resolve = createThresholdResolver(repo, { ttlMs: 0 });
    expect(await resolve('')).toBeUndefined();
  });

  it('noopThresholdResolver always returns undefined', async () => {
    expect(await noopThresholdResolver('any-tenant')).toBeUndefined();
  });

  it('caps cache size and evicts LRU entries (gemini PR #316 review)', async () => {
    // Pre-create three tenants with overrides.
    for (const t of ['t-a', 't-b', 't-c']) {
      await ensureTenantSettings(t, repo, { businessName: t });
      await repo.update(t, { autoApproveThreshold: { supervisor: 0.9 } });
    }
    const findSpy = vi.spyOn(repo, 'findByTenant');
    const resolve = createThresholdResolver(repo, {
      ttlMs: 60_000,
      maxEntries: 2,
    });

    await resolve('t-a'); // populate
    await resolve('t-b'); // populate (cache: a, b)
    await resolve('t-c'); // populate, evict a (cache: b, c)

    expect(findSpy).toHaveBeenCalledTimes(3);
    findSpy.mockClear();

    // Hits cache.
    await resolve('t-c');
    await resolve('t-b');
    expect(findSpy).toHaveBeenCalledTimes(0);

    // 't-a' was evicted; re-resolving must hit the repo.
    await resolve('t-a');
    expect(findSpy).toHaveBeenCalledTimes(1);
  });
});
