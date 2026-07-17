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
    expect(catalogRepo.listByTenant).toHaveBeenCalledWith('tenant-1');
    expect(customerRepo.findByTenant).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ includeArchived: false })
    );
    expect(userRepo.findByTenant).toHaveBeenCalledWith('tenant-1');
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
