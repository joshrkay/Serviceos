import { describe, it, expect, vi } from 'vitest';
import { TenantGlossaryProvider } from '../../src/voice/tenant-glossary-provider';

describe('TenantGlossaryProvider', () => {
  it('collects and merges terms from catalog items, customers, and users', async () => {
    const catalogRepo = {
      listByTenant: vi.fn(async () => [
        { name: 'PEX pipe' } as never,
        { name: 'Water heater' } as never,
      ]),
    };
    const customerRepo = {
      findByTenant: vi.fn(async () => [
        { displayName: 'Maria Rodriguez' } as never,
        { displayName: 'Henderson HOA' } as never,
      ]),
    };
    const userRepo = {
      findByTenant: vi.fn(async () => [
        { firstName: 'Sam', lastName: 'Lee' } as never,
      ]),
    };

    const provider = new TenantGlossaryProvider({ catalogRepo, customerRepo, userRepo });
    const terms = await provider.termsForTenant('tenant-1');

    expect(terms).toEqual([
      'PEX pipe',
      'Water heater',
      'Maria Rodriguez',
      'Henderson HOA',
      'Sam Lee',
    ]);
    expect(catalogRepo.listByTenant).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ limit: 40 })
    );
    expect(customerRepo.findByTenant).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ includeArchived: false })
    );
    expect(userRepo.findByTenant).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ limit: 40 })
    );
  });

  it('dedupes case-insensitively across sources, preserving first-seen casing', async () => {
    const catalogRepo = { listByTenant: vi.fn(async () => [{ name: 'Henderson' } as never]) };
    const customerRepo = {
      findByTenant: vi.fn(async () => [{ displayName: 'henderson' } as never]),
    };
    const userRepo = { findByTenant: vi.fn(async () => []) };

    const provider = new TenantGlossaryProvider({ catalogRepo, customerRepo, userRepo });
    const terms = await provider.termsForTenant('tenant-1');

    expect(terms).toEqual(['Henderson']);
  });

  it('drops blank/whitespace-only names', async () => {
    const catalogRepo = {
      listByTenant: vi.fn(async () => [{ name: '  ' } as never, { name: 'Valid Item' } as never]),
    };
    const customerRepo = { findByTenant: vi.fn(async () => [{ displayName: '' } as never]) };
    const userRepo = {
      findByTenant: vi.fn(async () => [{ firstName: '', lastName: '' } as never]),
    };

    const provider = new TenantGlossaryProvider({ catalogRepo, customerRepo, userRepo });
    const terms = await provider.termsForTenant('tenant-1');

    expect(terms).toEqual(['Valid Item']);
  });

  it('returns an empty list when all sources are empty', async () => {
    const catalogRepo = { listByTenant: vi.fn(async () => []) };
    const customerRepo = { findByTenant: vi.fn(async () => []) };
    const userRepo = { findByTenant: vi.fn(async () => []) };

    const provider = new TenantGlossaryProvider({ catalogRepo, customerRepo, userRepo });
    expect(await provider.termsForTenant('tenant-1')).toEqual([]);
  });

  it('caps the total merged term count at 100', async () => {
    const catalogRepo = {
      listByTenant: vi.fn(async () =>
        Array.from({ length: 60 }, (_, i) => ({ name: `catalog-${i}` } as never))
      ),
    };
    const customerRepo = {
      findByTenant: vi.fn(async () =>
        Array.from({ length: 60 }, (_, i) => ({ displayName: `customer-${i}` } as never))
      ),
    };
    const userRepo = {
      findByTenant: vi.fn(async () =>
        Array.from({ length: 60 }, (_, i) => ({ firstName: `user-${i}`, lastName: '' } as never))
      ),
    };

    const provider = new TenantGlossaryProvider({ catalogRepo, customerRepo, userRepo });
    const terms = await provider.termsForTenant('tenant-1');

    expect(terms.length).toBe(100);
  });

  it('caps each source independently so one large source cannot crowd out the others', async () => {
    // 200 catalog items alone would fill the entire 100-term budget if
    // not capped per-source, starving customer/technician names.
    const catalogRepo = {
      listByTenant: vi.fn(async () =>
        Array.from({ length: 200 }, (_, i) => ({ name: `catalog-${i}` } as never))
      ),
    };
    const customerRepo = { findByTenant: vi.fn(async () => [{ displayName: 'Henderson' } as never]) };
    const userRepo = { findByTenant: vi.fn(async () => [{ firstName: 'Sam', lastName: 'Lee' } as never]) };

    const provider = new TenantGlossaryProvider({ catalogRepo, customerRepo, userRepo });
    const terms = await provider.termsForTenant('tenant-1');

    expect(terms).toContain('Henderson');
    expect(terms).toContain('Sam Lee');
    expect(terms.filter((t) => t.startsWith('catalog-')).length).toBeLessThanOrEqual(40);
  });

  it('returns partial terms when one repo throws, and never throws itself', async () => {
    const catalogRepo = {
      listByTenant: vi.fn(async () => {
        throw new Error('db unavailable');
      }),
    };
    const customerRepo = { findByTenant: vi.fn(async () => [{ displayName: 'Henderson' } as never]) };
    const userRepo = { findByTenant: vi.fn(async () => [{ firstName: 'Sam', lastName: 'Lee' } as never]) };

    const provider = new TenantGlossaryProvider({ catalogRepo, customerRepo, userRepo });
    const terms = await provider.termsForTenant('tenant-1');

    expect(terms).toEqual(['Henderson', 'Sam Lee']);
  });

  it('returns whatever terms are available even when all repos throw', async () => {
    const catalogRepo = {
      listByTenant: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const customerRepo = {
      findByTenant: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const userRepo = {
      findByTenant: vi.fn(async () => {
        throw new Error('boom');
      }),
    };

    const provider = new TenantGlossaryProvider({ catalogRepo, customerRepo, userRepo });
    await expect(provider.termsForTenant('tenant-1')).resolves.toEqual([]);
  });
});

describe('TenantGlossaryProvider — per-tenant TTL cache + coalescing', () => {
  function makeRepos() {
    const catalogRepo = { listByTenant: vi.fn(async () => [{ name: 'PEX pipe' } as never]) };
    const customerRepo = {
      findByTenant: vi.fn(async () => [{ displayName: 'Maria Rodriguez' } as never]),
    };
    const userRepo = { findByTenant: vi.fn(async () => [{ firstName: 'Sam', lastName: 'Lee' } as never]) };
    return { catalogRepo, customerRepo, userRepo };
  }

  it('hits the repos once for two sequential calls within the TTL window', async () => {
    const { catalogRepo, customerRepo, userRepo } = makeRepos();
    const provider = new TenantGlossaryProvider({ catalogRepo, customerRepo, userRepo });

    const first = await provider.termsForTenant('tenant-1');
    const second = await provider.termsForTenant('tenant-1');

    expect(first).toEqual(second);
    expect(catalogRepo.listByTenant).toHaveBeenCalledTimes(1);
    expect(customerRepo.findByTenant).toHaveBeenCalledTimes(1);
    expect(userRepo.findByTenant).toHaveBeenCalledTimes(1);
  });

  it('re-queries once the TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const { catalogRepo, customerRepo, userRepo } = makeRepos();
      const provider = new TenantGlossaryProvider(
        { catalogRepo, customerRepo, userRepo },
        { cacheTtlMs: 1000 }
      );

      await provider.termsForTenant('tenant-1');
      expect(catalogRepo.listByTenant).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(999);
      await provider.termsForTenant('tenant-1');
      expect(catalogRepo.listByTenant).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2);
      await provider.termsForTenant('tenant-1');
      expect(catalogRepo.listByTenant).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces concurrent calls for the same tenant into one query set', async () => {
    let resolveCatalog!: (items: Array<{ name: string }>) => void;
    const catalogRepo = {
      listByTenant: vi.fn(
        () =>
          new Promise<Array<{ name: string }>>((resolve) => {
            resolveCatalog = resolve;
          }) as never
      ),
    };
    const customerRepo = {
      findByTenant: vi.fn(async () => [{ displayName: 'Maria Rodriguez' } as never]),
    };
    const userRepo = { findByTenant: vi.fn(async () => [{ firstName: 'Sam', lastName: 'Lee' } as never]) };
    const provider = new TenantGlossaryProvider({ catalogRepo, customerRepo, userRepo });

    const call1 = provider.termsForTenant('tenant-1');
    const call2 = provider.termsForTenant('tenant-1');

    resolveCatalog([{ name: 'PEX pipe' }]);
    const [terms1, terms2] = await Promise.all([call1, call2]);

    expect(terms1).toEqual(terms2);
    expect(catalogRepo.listByTenant).toHaveBeenCalledTimes(1);
    expect(customerRepo.findByTenant).toHaveBeenCalledTimes(1);
    expect(userRepo.findByTenant).toHaveBeenCalledTimes(1);
  });

  it('keeps separate cache entries per tenant — no term bleed', async () => {
    const catalogRepo = {
      listByTenant: vi.fn(async (tenantId: string) => [{ name: `item-${tenantId}` } as never]),
    };
    const customerRepo = { findByTenant: vi.fn(async () => []) };
    const userRepo = { findByTenant: vi.fn(async () => []) };
    const provider = new TenantGlossaryProvider({ catalogRepo, customerRepo, userRepo });

    const termsA = await provider.termsForTenant('tenant-a');
    const termsB = await provider.termsForTenant('tenant-b');
    // Re-fetch tenant-a — should still be cached (repo hit once for A).
    const termsAAgain = await provider.termsForTenant('tenant-a');

    expect(termsA).toEqual(['item-tenant-a']);
    expect(termsB).toEqual(['item-tenant-b']);
    expect(termsAAgain).toEqual(['item-tenant-a']);
    expect(catalogRepo.listByTenant).toHaveBeenCalledTimes(2);
  });

  it('cacheTtlMs: 0 disables caching — repos are hit on every call', async () => {
    const { catalogRepo, customerRepo, userRepo } = makeRepos();
    const provider = new TenantGlossaryProvider(
      { catalogRepo, customerRepo, userRepo },
      { cacheTtlMs: 0 }
    );

    await provider.termsForTenant('tenant-1');
    await provider.termsForTenant('tenant-1');
    await provider.termsForTenant('tenant-1');

    expect(catalogRepo.listByTenant).toHaveBeenCalledTimes(3);
    expect(customerRepo.findByTenant).toHaveBeenCalledTimes(3);
    expect(userRepo.findByTenant).toHaveBeenCalledTimes(3);
  });

  it('evicts the oldest tenant once the 500-entry bound is exceeded', async () => {
    const catalogRepo = {
      listByTenant: vi.fn(async (tenantId: string) => [{ name: `item-${tenantId}` } as never]),
    };
    const customerRepo = { findByTenant: vi.fn(async () => []) };
    const userRepo = { findByTenant: vi.fn(async () => []) };
    const provider = new TenantGlossaryProvider({ catalogRepo, customerRepo, userRepo });

    // Fill the cache with 500 distinct tenants, then push one more in —
    // the oldest (tenant-0) should be evicted and re-queried on next call.
    for (let i = 0; i < 500; i++) {
      await provider.termsForTenant(`tenant-${i}`);
    }
    expect(catalogRepo.listByTenant).toHaveBeenCalledTimes(500);

    await provider.termsForTenant('tenant-500');
    expect(catalogRepo.listByTenant).toHaveBeenCalledTimes(501);

    // tenant-0 was the oldest entry and was evicted to make room for
    // tenant-500 — re-fetching it re-queries the repo.
    await provider.termsForTenant('tenant-0');
    expect(catalogRepo.listByTenant).toHaveBeenCalledTimes(502);

    // tenant-499 was never evicted — still cached.
    await provider.termsForTenant('tenant-499');
    expect(catalogRepo.listByTenant).toHaveBeenCalledTimes(502);
  });
});
