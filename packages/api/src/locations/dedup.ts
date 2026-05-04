import { ServiceLocation, LocationRepository } from './location';

export interface DuplicateWarning {
  existingId: string;
  matchType: 'phone' | 'email' | 'name' | 'address';
  confidence: 'high' | 'medium';
  /**
   * Numeric confidence score for v1 dedup advisories.
   * Scoring (P1-019):
   *   1.0 — exact normalized match (street1+city+state+postalCode equal after lowercasing/whitespace-collapsing)
   *   0.6 — fuzzy/partial address match (currently unused — reserved for street1-only future heuristic)
   */
  score: number;
  message: string;
}

export function normalizeAddress(addr: { street1: string; city: string; state: string; postalCode: string }): string {
  return [addr.street1, addr.city, addr.state, addr.postalCode]
    .map((s) => s.toLowerCase().trim().replace(/\s+/g, ' '))
    .join('|');
}

export async function checkLocationDuplicates(
  input: { street1: string; city: string; state: string; postalCode: string; customerId: string; tenantId: string },
  repository: LocationRepository
): Promise<DuplicateWarning[]> {
  const warnings: DuplicateWarning[] = [];
  const existing = await repository.findByCustomer(input.tenantId, input.customerId);

  const inputAddr = normalizeAddress(input);

  for (const location of existing) {
    if (location.isArchived) continue;
    const existingAddr = normalizeAddress(location);
    if (inputAddr === existingAddr) {
      warnings.push({
        existingId: location.id,
        matchType: 'address',
        confidence: 'high',
        score: 1.0,
        message: `Address matches existing location: ${location.label || location.street1}`,
      });
    }
  }

  return warnings;
}

/**
 * Loader callback for Pg-backed location dedup.
 * Implementations MUST scope by tenantId AND customerId before any
 * other predicate (defense-in-depth on top of RLS).
 */
export interface LocationDuplicateLoader {
  findDuplicateAddresses(
    tenantId: string,
    customerId: string,
    address: { street1: string; city: string; state: string; postalCode: string }
  ): Promise<ServiceLocation[]>;
}

/**
 * P1-019: Pg-aware location dedup.
 *
 * Differs from `checkLocationDuplicates` in that the candidate set is
 * sourced via a parameterized SQL query that filters by
 * (tenant_id, customer_id, normalized address) rather than streaming
 * all locations for the customer.
 *
 * Always belt-and-braces verifies tenantId+customerId match in-memory.
 */
export async function checkLocationDuplicatesPg(
  input: { street1: string; city: string; state: string; postalCode: string; customerId: string; tenantId: string },
  loader: LocationDuplicateLoader
): Promise<DuplicateWarning[]> {
  const warnings: DuplicateWarning[] = [];
  const candidates = await loader.findDuplicateAddresses(
    input.tenantId,
    input.customerId,
    {
      street1: input.street1,
      city: input.city,
      state: input.state,
      postalCode: input.postalCode,
    }
  );

  // Belt-and-braces tenant+customer scoping (RLS should already enforce).
  const inScope = candidates.filter(
    (l) => l.tenantId === input.tenantId && l.customerId === input.customerId && !l.isArchived
  );

  const inputAddr = normalizeAddress(input);
  for (const location of inScope) {
    const existingAddr = normalizeAddress(location);
    if (inputAddr === existingAddr) {
      warnings.push({
        existingId: location.id,
        matchType: 'address',
        confidence: 'high',
        score: 1.0,
        message: `Address matches existing location: ${location.label || location.street1}`,
      });
    }
  }

  return warnings;
}

/**
 * Type-guard: does this LocationRepository also implement the
 * Pg-style duplicate loader?
 */
export function isLocationDuplicateLoader(
  repo: LocationRepository | (LocationRepository & LocationDuplicateLoader)
): repo is LocationRepository & LocationDuplicateLoader {
  return typeof (repo as Partial<LocationDuplicateLoader>).findDuplicateAddresses === 'function';
}
