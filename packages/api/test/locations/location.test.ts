import {
  createLocation,
  getLocation,
  updateLocation,
  archiveLocation,
  listByCustomer,
  setPrimary,
  validateLocationInput,
  InMemoryLocationRepository,
} from '../../src/locations/location';

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
