import {
  checkCustomerDuplicates,
  checkCustomerDuplicatesPg,
  isCustomerDuplicateLoader,
  nameSimilarity,
  normalizePhone,
  normalizeEmail,
  normalizeName,
} from '../../src/customers/dedup';
import { createCustomer, InMemoryCustomerRepository } from '../../src/customers/customer';

describe('P1-004 — Deterministic duplicate prevention (customers)', () => {
  let repo: InMemoryCustomerRepository;

  beforeEach(async () => {
    repo = new InMemoryCustomerRepository();
    await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        primaryPhone: '555-123-4567',
        createdBy: 'user-1',
      },
      repo
    );
  });

  it('happy path — no duplicates found for unique customer', async () => {
    const warnings = await checkCustomerDuplicates(
      {
        tenantId: 'tenant-1',
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@example.com',
        primaryPhone: '555-999-8888',
      },
      repo
    );
    expect(warnings).toHaveLength(0);
  });

  it('happy path — detects phone match', async () => {
    const warnings = await checkCustomerDuplicates(
      {
        tenantId: 'tenant-1',
        firstName: 'Different',
        lastName: 'Person',
        primaryPhone: '(555) 123-4567',
      },
      repo
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].matchType).toBe('phone');
    expect(warnings[0].confidence).toBe('high');
  });

  it('happy path — detects email match', async () => {
    const warnings = await checkCustomerDuplicates(
      {
        tenantId: 'tenant-1',
        firstName: 'Different',
        lastName: 'Person',
        email: 'JOHN@EXAMPLE.COM',
      },
      repo
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].matchType).toBe('email');
    expect(warnings[0].confidence).toBe('high');
  });

  it('happy path — detects name match', async () => {
    const warnings = await checkCustomerDuplicates(
      {
        tenantId: 'tenant-1',
        firstName: 'john',
        lastName: 'doe',
      },
      repo
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].matchType).toBe('name');
    expect(warnings[0].confidence).toBe('medium');
  });

  it('normalizePhone — strips non-digits', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('5551234567');
    expect(normalizePhone('+1-555-123-4567')).toBe('15551234567');
  });

  it('normalizeEmail — lowercases and trims', () => {
    expect(normalizeEmail('  John@Example.COM  ')).toBe('john@example.com');
  });

  it('normalizeName — lowercases and normalizes whitespace', () => {
    expect(normalizeName('  John   Doe  ')).toBe('john doe');
  });

  it('validation — no false positives for different tenant', async () => {
    const warnings = await checkCustomerDuplicates(
      {
        tenantId: 'tenant-2',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
      },
      repo
    );
    expect(warnings).toHaveLength(0);
  });
});

describe('P1-019 — Pg-backed customer dedup (checkCustomerDuplicatesPg)', () => {
  let repo: InMemoryCustomerRepository;

  beforeEach(async () => {
    repo = new InMemoryCustomerRepository();
    // Tenant 1 baseline customer
    await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        primaryPhone: '(415) 555-1234',
        createdBy: 'user-1',
      },
      repo
    );
    // Tenant 2 has a customer with the EXACT same phone/email — must
    // not surface as a duplicate when querying tenant 1.
    await createCustomer(
      {
        tenantId: 'tenant-2',
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
        primaryPhone: '(415) 555-1234',
        createdBy: 'user-1',
      },
      repo
    );
  });

  it('isCustomerDuplicateLoader — InMemoryCustomerRepository implements the loader contract', () => {
    expect(isCustomerDuplicateLoader(repo)).toBe(true);
  });

  it('Phone match — normalized phone finds existing customer', async () => {
    const warnings = await checkCustomerDuplicatesPg(
      {
        tenantId: 'tenant-1',
        firstName: 'Different',
        lastName: 'Person',
        primaryPhone: '4155551234',
      },
      repo
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const phoneMatch = warnings.find((w) => w.matchType === 'phone');
    expect(phoneMatch).toBeDefined();
    expect(phoneMatch!.confidence).toBe('high');
    expect(phoneMatch!.score).toBe(1.0);
  });

  it('Email match — case-insensitive email finds existing customer', async () => {
    const warnings = await checkCustomerDuplicatesPg(
      {
        tenantId: 'tenant-1',
        firstName: 'Different',
        lastName: 'Person',
        email: '  JOHN@EXAMPLE.COM  ',
      },
      repo
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const emailMatch = warnings.find((w) => w.matchType === 'email');
    expect(emailMatch).toBeDefined();
    expect(emailMatch!.confidence).toBe('high');
    expect(emailMatch!.score).toBe(1.0);
  });

  it('No match — new unique customer returns no warnings', async () => {
    const warnings = await checkCustomerDuplicatesPg(
      {
        tenantId: 'tenant-1',
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@example.com',
        primaryPhone: '555-999-8888',
      },
      repo
    );
    expect(warnings).toHaveLength(0);
  });

  it('Cross-tenant — same phone on different tenant is NOT a match', async () => {
    // Querying tenant-3 with the phone that exists in tenants 1 and 2
    // must NOT return the tenant-1 or tenant-2 row.
    const warnings = await checkCustomerDuplicatesPg(
      {
        tenantId: 'tenant-3',
        primaryPhone: '(415) 555-1234',
        email: 'john@example.com',
      },
      repo
    );
    expect(warnings).toHaveLength(0);
  });

  it('Multiple matches — phone AND email on the same record return both warnings', async () => {
    const warnings = await checkCustomerDuplicatesPg(
      {
        tenantId: 'tenant-1',
        primaryPhone: '4155551234',
        email: 'john@example.com',
      },
      repo
    );
    // The same record matches both phone and email — both warnings
    // are emitted (different matchType keys are deduplicated, but
    // not collapsed across types).
    expect(warnings.length).toBe(2);
    const types = warnings.map((w) => w.matchType).sort();
    expect(types).toEqual(['email', 'phone']);
  });

  it('Multiple matches — distinct customers each surface as a warning', async () => {
    // Add a second customer in tenant-1 with the same email, different phone.
    await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: 'Janet',
        lastName: 'Doe',
        email: 'john@example.com',
        primaryPhone: '555-000-1111',
        createdBy: 'user-1',
      },
      repo
    );
    const warnings = await checkCustomerDuplicatesPg(
      {
        tenantId: 'tenant-1',
        email: 'JOHN@example.com',
      },
      repo
    );
    // Two customers in tenant-1 share this email → two warnings.
    expect(warnings.filter((w) => w.matchType === 'email').length).toBe(2);
    const ids = new Set(warnings.map((w) => w.existingId));
    expect(ids.size).toBe(2);
  });

  it('Empty inputs — no phone and no email returns no warnings (no-op)', async () => {
    const warnings = await checkCustomerDuplicatesPg(
      { tenantId: 'tenant-1', firstName: 'No', lastName: 'Contact' },
      repo
    );
    expect(warnings).toHaveLength(0);
  });

  it('Archived rows — archived customer is NOT returned as a duplicate', async () => {
    const orphan = await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: 'Archived',
        lastName: 'Customer',
        email: 'archived@example.com',
        createdBy: 'user-1',
      },
      repo
    );
    await repo.update('tenant-1', orphan.id, { isArchived: true });
    const warnings = await checkCustomerDuplicatesPg(
      { tenantId: 'tenant-1', email: 'archived@example.com' },
      repo
    );
    expect(warnings).toHaveLength(0);
  });
});

describe('P4-004 — Fuzzy name dedup (pg_trgm parity)', () => {
  it('nameSimilarity — identical names score 1.0', () => {
    expect(nameSimilarity('john doe', 'john doe')).toBe(1);
  });

  it('nameSimilarity — a close typo scores above the fuzzy threshold', () => {
    expect(nameSimilarity('john doe', 'jon doe')).toBeGreaterThanOrEqual(0.4);
  });

  it('nameSimilarity — unrelated names score below the fuzzy threshold', () => {
    expect(nameSimilarity('john doe', 'jane smith')).toBeLessThan(0.4);
  });

  it('nameSimilarity — empty input scores 0', () => {
    expect(nameSimilarity('', 'john doe')).toBe(0);
  });

  let repo: InMemoryCustomerRepository;
  beforeEach(async () => {
    repo = new InMemoryCustomerRepository();
    await createCustomer(
      {
        tenantId: 'tenant-1',
        firstName: 'Jonathan',
        lastName: 'Doe',
        primaryPhone: '(415) 555-7777',
        createdBy: 'user-1',
      },
      repo
    );
  });

  it('flags a close name as a "possible duplicate" (medium, score 0.6)', async () => {
    const warnings = await checkCustomerDuplicatesPg(
      { tenantId: 'tenant-1', firstName: 'Jonathon', lastName: 'Doe' },
      repo
    );
    const nameMatch = warnings.find((w) => w.matchType === 'name');
    expect(nameMatch).toBeDefined();
    expect(nameMatch!.confidence).toBe('medium');
    expect(nameMatch!.score).toBe(0.6);
  });

  it('exact normalized name match still scores 0.8', async () => {
    const warnings = await checkCustomerDuplicatesPg(
      { tenantId: 'tenant-1', firstName: 'jonathan', lastName: 'DOE' },
      repo
    );
    const nameMatch = warnings.find((w) => w.matchType === 'name');
    expect(nameMatch).toBeDefined();
    expect(nameMatch!.score).toBe(0.8);
  });

  it('an unrelated name produces no warning', async () => {
    const warnings = await checkCustomerDuplicatesPg(
      { tenantId: 'tenant-1', firstName: 'Maria', lastName: 'Gonzalez' },
      repo
    );
    expect(warnings).toHaveLength(0);
  });

  it('cross-tenant — a close name on another tenant is NOT flagged', async () => {
    const warnings = await checkCustomerDuplicatesPg(
      { tenantId: 'tenant-2', firstName: 'Jonathon', lastName: 'Doe' },
      repo
    );
    expect(warnings).toHaveLength(0);
  });
});
