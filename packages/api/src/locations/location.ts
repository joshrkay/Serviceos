import { v4 as uuidv4 } from 'uuid';

export interface ServiceLocation {
  id: string;
  tenantId: string;
  customerId: string;
  label?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude?: number;
  longitude?: number;
  accessNotes?: string;
  isPrimary: boolean;
  isArchived: boolean;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateLocationInput {
  tenantId: string;
  customerId: string;
  label?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  accessNotes?: string;
  isPrimary?: boolean;
}

export interface UpdateLocationInput {
  label?: string;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  accessNotes?: string;
}

export interface LocationRepository {
  create(location: ServiceLocation): Promise<ServiceLocation>;
  findById(tenantId: string, id: string): Promise<ServiceLocation | null>;
  findByCustomer(tenantId: string, customerId: string): Promise<ServiceLocation[]>;
  findByTenant(tenantId: string): Promise<ServiceLocation[]>;
  update(tenantId: string, id: string, updates: Partial<ServiceLocation>): Promise<ServiceLocation | null>;
}

export function validateLocationInput(input: CreateLocationInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.customerId) errors.push('customerId is required');
  if (!input.street1) errors.push('street1 is required');
  if (!input.city) errors.push('city is required');
  if (!input.state) errors.push('state is required');
  if (!input.postalCode) errors.push('postalCode is required');
  return errors;
}

export function validateLocationUpdateInput(
  existing: ServiceLocation,
  input: UpdateLocationInput
): string[] {
  return validateLocationInput({
    tenantId: existing.tenantId,
    customerId: existing.customerId,
    label: input.label ?? existing.label,
    street1: input.street1 ?? existing.street1,
    street2: input.street2 ?? existing.street2,
    city: input.city ?? existing.city,
    state: input.state ?? existing.state,
    postalCode: input.postalCode ?? existing.postalCode,
    country: input.country ?? existing.country,
    latitude: input.latitude ?? existing.latitude,
    longitude: input.longitude ?? existing.longitude,
    accessNotes: input.accessNotes ?? existing.accessNotes,
    isPrimary: existing.isPrimary,
  });
}

export async function createLocation(
  input: CreateLocationInput,
  repository: LocationRepository
): Promise<ServiceLocation> {
  const errors = validateLocationInput(input);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const location: ServiceLocation = {
    id: uuidv4(),
    tenantId: input.tenantId,
    customerId: input.customerId,
    label: input.label,
    street1: input.street1,
    street2: input.street2,
    city: input.city,
    state: input.state,
    postalCode: input.postalCode,
    country: input.country || 'US',
    latitude: input.latitude,
    longitude: input.longitude,
    accessNotes: input.accessNotes,
    isPrimary: input.isPrimary ?? false,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // If this is the first location for the customer, make it primary
  const existing = await repository.findByCustomer(input.tenantId, input.customerId);
  if (existing.length === 0) {
    location.isPrimary = true;
  } else if (location.isPrimary) {
    // Unset existing primary when new location requests primary
    for (const loc of existing) {
      if (loc.isPrimary) {
        await repository.update(input.tenantId, loc.id, { isPrimary: false, updatedAt: new Date() });
      }
    }
  }

  return repository.create(location);
}

export async function getLocation(
  tenantId: string,
  id: string,
  repository: LocationRepository
): Promise<ServiceLocation | null> {
  return repository.findById(tenantId, id);
}

export async function updateLocation(
  tenantId: string,
  id: string,
  input: UpdateLocationInput,
  repository: LocationRepository
): Promise<ServiceLocation | null> {
  const existing = await repository.findById(tenantId, id);
  if (!existing) return null;

  const validationErrors = validateLocationUpdateInput(existing, input);
  if (validationErrors.length > 0) throw new Error(`Validation failed: ${validationErrors.join(', ')}`);

  return repository.update(tenantId, id, { ...input, updatedAt: new Date() });
}

export async function archiveLocation(
  tenantId: string,
  id: string,
  repository: LocationRepository
): Promise<ServiceLocation | null> {
  const location = await repository.findById(tenantId, id);
  if (!location) return null;

  // If archiving the primary, promote another active location
  if (location.isPrimary) {
    const siblings = await repository.findByCustomer(tenantId, location.customerId);
    const otherActive = siblings.filter((l) => l.id !== id && !l.isArchived);
    if (otherActive.length > 0) {
      await repository.update(tenantId, otherActive[0].id, { isPrimary: true, updatedAt: new Date() });
    }
  }

  return repository.update(tenantId, id, {
    isArchived: true,
    isPrimary: false,
    archivedAt: new Date(),
    updatedAt: new Date(),
  });
}

export async function listByCustomer(
  tenantId: string,
  customerId: string,
  repository: LocationRepository
): Promise<ServiceLocation[]> {
  const locations = await repository.findByCustomer(tenantId, customerId);
  return locations.filter((l) => !l.isArchived);
}

export async function setPrimary(
  tenantId: string,
  locationId: string,
  repository: LocationRepository
): Promise<ServiceLocation | null> {
  const location = await repository.findById(tenantId, locationId);
  if (!location) return null;

  // Unset current primary for this customer
  const customerLocations = await repository.findByCustomer(tenantId, location.customerId);
  for (const loc of customerLocations) {
    if (loc.isPrimary && loc.id !== locationId) {
      await repository.update(tenantId, loc.id, { isPrimary: false, updatedAt: new Date() });
    }
  }

  return repository.update(tenantId, locationId, { isPrimary: true, updatedAt: new Date() });
}

export class InMemoryLocationRepository implements LocationRepository {
  private locations: Map<string, ServiceLocation> = new Map();

  async create(location: ServiceLocation): Promise<ServiceLocation> {
    this.locations.set(location.id, { ...location });
    return { ...location };
  }

  async findById(tenantId: string, id: string): Promise<ServiceLocation | null> {
    const l = this.locations.get(id);
    if (!l || l.tenantId !== tenantId) return null;
    return { ...l };
  }

  async findByCustomer(tenantId: string, customerId: string): Promise<ServiceLocation[]> {
    return Array.from(this.locations.values())
      .filter((l) => l.tenantId === tenantId && l.customerId === customerId)
      .map((l) => ({ ...l }));
  }

  async findByTenant(tenantId: string): Promise<ServiceLocation[]> {
    return Array.from(this.locations.values())
      .filter((l) => l.tenantId === tenantId)
      .map((l) => ({ ...l }));
  }

  async update(tenantId: string, id: string, updates: Partial<ServiceLocation>): Promise<ServiceLocation | null> {
    const l = this.locations.get(id);
    if (!l || l.tenantId !== tenantId) return null;
    const updated = { ...l, ...updates };
    this.locations.set(id, updated);
    return { ...updated };
  }

  getAll(): ServiceLocation[] {
    return Array.from(this.locations.values()).map((l) => ({ ...l }));
  }
}
