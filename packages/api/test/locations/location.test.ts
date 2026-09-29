import {
  createLocation,
  getLocation,
  updateLocation,
  archiveLocation,
  listByCustomer,
  setPrimary,
  validateLocationInput,
  validateLocationUpdateInput,
  InMemoryLocationRepository,
} from '../../src/locations/location';
import { InMemoryAuditRepository } from '../../src/audit/audit';

describe('P1-003 — Service location entity', () => {
  let repo: InMemoryLocationRepository;

  beforeEach(() => {
    repo = new InMemoryLocationRepository();
  });

  it('happy path — creates location and retrieves it', async () => {
    const location = await createLocation(
      {
        tenantId: 'tenant-1',
        customerId: 'cust-1',
        label: 'Main Office',
        street1: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
      },
      repo
    );

    expect(location.id).toBeTruthy();
    expect(location.street1).toBe('123 Main St');
    expect(location.country).toBe('US');
    expect(location.isPrimary).toBe(true); // First location is primary

    const found = await getLocation('tenant-1', location.id, repo);
    expect(found).not.toBeNull();
    expect(found!.label).toBe('Main Office');
  });

  it('happy path — first location becomes primary automatically', async () => {
    const loc1 = await createLocation(
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

    expect(loc1.isPrimary).toBe(true);

    const loc2 = await createLocation(
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

    expect(loc2.isPrimary).toBe(false);
  });

  it('happy path — updates location', async () => {
    const location = await createLocation(
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

    const updated = await updateLocation(
      'tenant-1',
      location.id,
      { accessNotes: 'Ring doorbell twice' },
      repo
    );

    expect(updated!.accessNotes).toBe('Ring doorbell twice');
  });

  it('validation — rejects invalid location update before write', async () => {
    const location = await createLocation(
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

    await expect(
      updateLocation('tenant-1', location.id, { street1: '' }, repo)
    ).rejects.toThrow('Validation failed: street1 is required');

    const unchanged = await getLocation('tenant-1', location.id, repo);
    expect(unchanged!.street1).toBe('123 Main St');
  });

  it('validation — partial update validation uses merged fields', () => {
    const errors = validateLocationUpdateInput(
      {
        id: 'loc-1',
        tenantId: 'tenant-1',
        customerId: 'cust-1',
        street1: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        country: 'US',
        isPrimary: true,
        isArchived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      { accessNotes: 'Use side gate' }
    );

    expect(errors).toHaveLength(0);
  });

  it('happy path — archives location', async () => {
    const location = await createLocation(
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

    const archived = await archiveLocation('tenant-1', location.id, repo);
    expect(archived!.isArchived).toBe(true);
    expect(archived!.archivedAt).toBeTruthy();

    const customerLocations = await listByCustomer('tenant-1', 'cust-1', repo);
    expect(customerLocations).toHaveLength(0);
  });

  it('happy path — sets primary location', async () => {
    const loc1 = await createLocation(
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

    const loc2 = await createLocation(
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

    await setPrimary('tenant-1', loc2.id, repo);

    const updatedLoc1 = await getLocation('tenant-1', loc1.id, repo);
    const updatedLoc2 = await getLocation('tenant-1', loc2.id, repo);

    expect(updatedLoc1!.isPrimary).toBe(false);
    expect(updatedLoc2!.isPrimary).toBe(true);
  });

  it('isPrimary — creating with isPrimary unsets existing primary', async () => {
    const loc1 = await createLocation(
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
    expect(loc1.isPrimary).toBe(true);

    const loc2 = await createLocation(
      {
        tenantId: 'tenant-1',
        customerId: 'cust-1',
        street1: '456 Oak Ave',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62702',
        isPrimary: true,
      },
      repo
    );
    expect(loc2.isPrimary).toBe(true);

    const updatedLoc1 = await getLocation('tenant-1', loc1.id, repo);
    expect(updatedLoc1!.isPrimary).toBe(false);
  });

  it('archive — archiving primary promotes sibling', async () => {
    const loc1 = await createLocation(
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

    const loc2 = await createLocation(
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

    // loc1 is primary, archive it
    await archiveLocation('tenant-1', loc1.id, repo);

    const archivedLoc1 = await getLocation('tenant-1', loc1.id, repo);
    expect(archivedLoc1!.isArchived).toBe(true);
    expect(archivedLoc1!.isPrimary).toBe(false);

    const promotedLoc2 = await getLocation('tenant-1', loc2.id, repo);
    expect(promotedLoc2!.isPrimary).toBe(true);
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateLocationInput({
      tenantId: '',
      customerId: '',
      street1: '',
      city: '',
      state: '',
      postalCode: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('customerId is required');
    expect(errors).toContain('street1 is required');
    expect(errors).toContain('city is required');
    expect(errors).toContain('state is required');
    expect(errors).toContain('postalCode is required');
  });

  it('tenant isolation — cross-tenant data inaccessible', async () => {
    const location = await createLocation(
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

    const found = await getLocation('tenant-2', location.id, repo);
    expect(found).toBeNull();
  });
});

describe('P1-019 — createLocation attaches dedup warnings (advisory, never blocks)', () => {
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

  it('createLocation.duplicate — same address on same customer attaches a warning', async () => {
    const created = await createLocation(
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
    expect(created.id).toBeTruthy();
    expect(created.warnings).toBeDefined();
    expect(created.warnings!.length).toBe(1);
    expect(created.warnings![0].matchType).toBe('address');
    expect(created.warnings![0].score).toBe(1.0);
  });

  it('createLocation.duplicate — unique address has NO warnings field', async () => {
    const created = await createLocation(
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
    expect(created.warnings).toBeUndefined();
  });

  it('createLocation.duplicate — same address on different customer is NOT flagged', async () => {
    const created = await createLocation(
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
    expect(created.warnings).toBeUndefined();
  });

  it('createLocation.duplicate — creation is NEVER blocked (advisory only)', async () => {
    const before = await repo.findByCustomer('tenant-1', 'cust-1');
    const beforeCount = before.length;
    const created = await createLocation(
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
    const after = await repo.findByCustomer('tenant-1', 'cust-1');
    expect(after.length).toBe(beforeCount + 1);
    expect(created.warnings).toBeDefined();
  });
});

describe('location mutations — audit trail and missing rows', () => {
  let repo: InMemoryLocationRepository;
  let audit: InMemoryAuditRepository;
  const base = {
    tenantId: 'tenant-1',
    customerId: 'cust-1',
    street1: '9 Audit Rd',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
  };

  beforeEach(() => {
    repo = new InMemoryLocationRepository();
    audit = new InMemoryAuditRepository();
  });

  async function eventTypes(entityId: string): Promise<string[]> {
    return (await audit.findByEntity('tenant-1', 'location', entityId)).map((e) => e.eventType);
  }

  it('create, update, set-primary and archive each emit their audit event', async () => {
    const a = await createLocation(base, repo, audit, 'user-1', 'owner');
    const b = await createLocation({ ...base, street1: '10 Audit Rd' }, repo, audit, 'user-1', 'owner');
    await updateLocation('tenant-1', a.id, { label: 'HQ' }, repo, audit, 'user-1', 'owner');
    await setPrimary('tenant-1', b.id, repo, audit, 'user-1', 'owner');
    await archiveLocation('tenant-1', a.id, repo, audit, 'user-1', 'owner');

    expect(await eventTypes(a.id)).toEqual(['location.created', 'location.updated', 'location.archived']);
    expect(await eventTypes(b.id)).toEqual(['location.created', 'location.primary_set']);
  });

  it('update, set-primary and archive return null for a missing location', async () => {
    expect(await updateLocation('tenant-1', 'nope', { label: 'x' }, repo)).toBeNull();
    expect(await setPrimary('tenant-1', 'nope', repo)).toBeNull();
    expect(await archiveLocation('tenant-1', 'nope', repo)).toBeNull();
  });
});

describe('#1473 — service types are normalised on write', () => {
  let repo: InMemoryLocationRepository;
  const base = {
    tenantId: 'tenant-1',
    customerId: 'cust-1',
    street1: '1 Chip St',
    city: 'Phoenix',
    state: 'AZ',
    postalCode: '85001',
  };

  beforeEach(() => {
    repo = new InMemoryLocationRepository();
  });

  it('create stores known trades in chip casing and drops case-insensitive duplicates', async () => {
    const loc = await createLocation(
      { ...base, serviceTypes: ['plumbing', ' hvac ', 'PLUMBING', 'painting'] },
      repo
    );
    expect(loc.serviceTypes).toEqual(['Plumbing', 'HVAC', 'Painting']);
  });

  it('create keeps an unknown trade as typed (trimmed), deduped case-insensitively', async () => {
    const loc = await createLocation({ ...base, serviceTypes: [' Roofing', 'roofing'] }, repo);
    expect(loc.serviceTypes).toEqual(['Roofing']);
  });

  it('create without service types stores an empty list', async () => {
    const loc = await createLocation(base, repo);
    expect(loc.serviceTypes).toEqual([]);
  });

  it('update normalises service types the same way', async () => {
    const loc = await createLocation({ ...base, serviceTypes: ['HVAC'] }, repo);
    const updated = await updateLocation('tenant-1', loc.id, { serviceTypes: ['hvac', 'plumbing'] }, repo);
    expect(updated?.serviceTypes).toEqual(['HVAC', 'Plumbing']);
  });

  it('update without service types leaves them unchanged', async () => {
    const loc = await createLocation({ ...base, serviceTypes: ['Painting'] }, repo);
    const updated = await updateLocation('tenant-1', loc.id, { label: 'Shop' }, repo);
    expect(updated?.serviceTypes).toEqual(['Painting']);
    expect(updated?.label).toBe('Shop');
  });

  it('create refuses a blank service type before writing', async () => {
    await expect(createLocation({ ...base, serviceTypes: [' '] }, repo)).rejects.toThrow(
      'Validation failed: serviceTypes must be an array of at most 10 non-empty strings',
    );
    expect(repo.getAll()).toEqual([]);
  });

  it('validation rejects a blank service type', () => {
    expect(validateLocationInput({ ...base, serviceTypes: ['  '] })).toEqual([
      'serviceTypes must be an array of at most 10 non-empty strings',
    ]);
  });
});
