import { Customer, CustomerRepository } from './customer';

export interface DuplicateWarning {
  existingId: string;
  matchType: 'phone' | 'email' | 'name' | 'address';
  confidence: 'high' | 'medium';
  message: string;
}

export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

export function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

export async function checkCustomerDuplicates(
  input: { firstName?: string; lastName?: string; email?: string; primaryPhone?: string; tenantId: string },
  repository: CustomerRepository
): Promise<DuplicateWarning[]> {
  const warnings: DuplicateWarning[] = [];
  const existing = await repository.findByTenant(input.tenantId, { includeArchived: false });

  for (const customer of existing) {
    // Phone match (high confidence)
    if (input.primaryPhone && customer.primaryPhone) {
      const inputPhone = normalizePhone(input.primaryPhone);
      const existingPhone = normalizePhone(customer.primaryPhone);
      if (inputPhone.length >= 7 && inputPhone === existingPhone) {
        warnings.push({
          existingId: customer.id,
          matchType: 'phone',
          confidence: 'high',
          message: `Phone number matches existing customer: ${customer.displayName}`,
        });
      }
    }

    // Email match (high confidence)
    if (input.email && customer.email) {
      if (normalizeEmail(input.email) === normalizeEmail(customer.email)) {
        warnings.push({
          existingId: customer.id,
          matchType: 'email',
          confidence: 'high',
          message: `Email matches existing customer: ${customer.displayName}`,
        });
      }
    }

    // Name match (medium confidence)
    if (input.firstName && input.lastName && customer.firstName && customer.lastName) {
      const inputName = normalizeName(`${input.firstName} ${input.lastName}`);
      const existingName = normalizeName(`${customer.firstName} ${customer.lastName}`);
      if (inputName === existingName) {
        warnings.push({
          existingId: customer.id,
          matchType: 'name',
          confidence: 'medium',
          message: `Name matches existing customer: ${customer.displayName}`,
        });
      }
    }
  }

  // Deduplicate warnings by existingId
  const seen = new Set<string>();
  return warnings.filter((w) => {
    const key = `${w.existingId}-${w.matchType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
