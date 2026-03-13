import { ServiceLocation, LocationRepository } from './location';

export interface DuplicateWarning {
  existingId: string;
  matchType: 'phone' | 'email' | 'name' | 'address';
  confidence: 'high' | 'medium';
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
        message: `Address matches existing location: ${location.label || location.street1}`,
      });
    }
  }

  return warnings;
}
