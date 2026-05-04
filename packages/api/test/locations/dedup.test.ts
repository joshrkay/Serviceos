import { checkLocationDuplicates, normalizeAddress } from '../../src/locations/dedup';
import { createLocation, InMemoryLocationRepository } from '../../src/locations/location';

describe('P1-004 — Deterministic duplicate prevention (locations)', () => {
  let repo: InMemoryLocationRepository;

  beforeEach(async () => {
    repo = new InMemoryLocationRepository();
    await createLocation(
      {
        tenantId: 'tenant-1',
        customerId: 'cust-1',
        street1: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
      },
      repo
    );
  });

  it('happy path — no duplicates for unique address', async () => {
    const warnings = await checkLocationDuplicates(
      {
        tenantId: 'tenant-1',
        customerId: 'cust-1',
        street1: '456 Oak Ave',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62702',
      },
      repo
    );
    expect(warnings).toHaveLength(0);
  });

  it('happy path — detects address match with normalization', async () => {
    const warnings = await checkLocationDuplicates(
      {
        tenantId: 'tenant-1',
        customerId: 'cust-1',
        street1: '  123 MAIN ST  ',
        city: 'springfield',
        state: 'il',
        postalCode: '62701',
      },
      repo
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].matchType).toBe('address');
    expect(warnings[0].confidence).toBe('high');
  });

  it('normalizeAddress — lowercases and normalizes', () => {
    const result = normalizeAddress({
      street1: '  123 Main  St  ',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
    });
    expect(result).toBe('123 main st|springfield|il|62701');
  });

  it('validation — no false positives for different customer', async () => {
    const warnings = await checkLocationDuplicates(
      {
        tenantId: 'tenant-1',
        customerId: 'cust-2',
        street1: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
      },
      repo
    );
    expect(warnings).toHaveLength(0);
  });
});
