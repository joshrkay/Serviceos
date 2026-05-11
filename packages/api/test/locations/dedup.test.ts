import {
  checkLocationDuplicates,
  checkLocationDuplicatesPg,
  isLocationDuplicateLoader,
  normalizeAddress,
} from '../../src/locations/dedup';
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

describe('P1-019 — Pg-backed location dedup (checkLocationDuplicatesPg)', () => {
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
    // Same address on a DIFFERENT tenant — must not be a match.
    await createLocation(
      {
        tenantId: 'tenant-2',
        customerId: 'cust-1',
        street1: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
      },
      repo
    );
  });

  it('isLocationDuplicateLoader — InMemoryLocationRepository implements the loader contract', () => {
    expect(isLocationDuplicateLoader(repo)).toBe(true);
  });

  it('Address match — same address on same customer found', async () => {
    const warnings = await checkLocationDuplicatesPg(
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
    expect(warnings[0].score).toBe(1.0);
  });

  it('No match — different address returns no warnings', async () => {
    const warnings = await checkLocationDuplicatesPg(
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

  it('Cross-tenant — same address on different tenant is NOT a match', async () => {
    const warnings = await checkLocationDuplicatesPg(
      {
        tenantId: 'tenant-3',
        customerId: 'cust-1',
        street1: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
      },
      repo
    );
    expect(warnings).toHaveLength(0);
  });

  it('Cross-customer — same address on different customer in same tenant is NOT a match', async () => {
    const warnings = await checkLocationDuplicatesPg(
      {
        tenantId: 'tenant-1',
        customerId: 'cust-different',
        street1: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
      },
      repo
    );
    expect(warnings).toHaveLength(0);
  });

  it('Multiple matches — when a customer somehow has two identical addresses, both surface', async () => {
    // Create an explicit 2nd duplicate for cust-1 in tenant-1 by going
    // through the loader (real-world this should not happen because we
    // dedup on create, but the dedup is advisory so it's possible).
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
    const warnings = await checkLocationDuplicatesPg(
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
    expect(warnings.length).toBe(2);
  });
});
