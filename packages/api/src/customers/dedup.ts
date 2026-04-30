import { Customer, CustomerRepository } from './customer';

export interface DuplicateWarning {
  existingId: string;
  matchType: 'phone' | 'email' | 'name' | 'address';
  confidence: 'high' | 'medium';
  /**
   * Numeric confidence score for v1 dedup advisories.
   * Scoring (P1-019):
   *   1.0 — exact normalized match on phone or email (high)
   *   0.8 — name-only match (medium)
   *   0.6 — fuzzy/address match candidate (medium, locations only)
   */
  score: number;
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

  scoreCustomerMatches(input, existing, warnings);

  // Deduplicate warnings by existingId+matchType
  const seen = new Set<string>();
  return warnings.filter((w) => {
    const key = `${w.existingId}-${w.matchType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreCustomerMatches(
  input: { firstName?: string; lastName?: string; email?: string; primaryPhone?: string },
  candidates: Customer[],
  warnings: DuplicateWarning[]
): void {
  for (const customer of candidates) {
    // Phone match (high confidence — score 1.0)
    if (input.primaryPhone && customer.primaryPhone) {
      const inputPhone = normalizePhone(input.primaryPhone);
      const existingPhone = normalizePhone(customer.primaryPhone);
      if (inputPhone.length >= 7 && inputPhone === existingPhone) {
        warnings.push({
          existingId: customer.id,
          matchType: 'phone',
          confidence: 'high',
          score: 1.0,
          message: `Phone number matches existing customer: ${customer.displayName}`,
        });
      }
    }

    // Email match (high confidence — score 1.0)
    if (input.email && customer.email) {
      if (normalizeEmail(input.email) === normalizeEmail(customer.email)) {
        warnings.push({
          existingId: customer.id,
          matchType: 'email',
          confidence: 'high',
          score: 1.0,
          message: `Email matches existing customer: ${customer.displayName}`,
        });
      }
    }

    // Name match (medium confidence — score 0.8)
    if (input.firstName && input.lastName && customer.firstName && customer.lastName) {
      const inputName = normalizeName(`${input.firstName} ${input.lastName}`);
      const existingName = normalizeName(`${customer.firstName} ${customer.lastName}`);
      if (inputName === existingName) {
        warnings.push({
          existingId: customer.id,
          matchType: 'name',
          confidence: 'medium',
          score: 0.8,
          message: `Name matches existing customer: ${customer.displayName}`,
        });
      }
    }
  }
}

/**
 * Loader callback for Pg-backed dedup.
 * Implementations MUST scope by tenantId before any other predicate
 * (defense-in-depth on top of RLS — see repository-conventions.md).
 */
export interface CustomerDuplicateLoader {
  findDuplicates(
    tenantId: string,
    criteria: { phone?: string; email?: string }
  ): Promise<Customer[]>;
}

/**
 * P1-019: Pg-aware customer dedup.
 *
 * Differs from `checkCustomerDuplicates` in that the candidate set is
 * sourced via a parameterized SQL query that filters by tenant and by
 * (normalized phone OR normalized email), rather than streaming the
 * full tenant. This is the path used by `createCustomer` when a
 * loader-capable repository (i.e. a CustomerRepository whose concrete
 * type also implements CustomerDuplicateLoader) is provided.
 *
 * The function still scopes every match by tenantId in-memory as a
 * belt-and-braces check; if the loader ever returns a cross-tenant
 * row (it should not), no warning is emitted.
 */
export async function checkCustomerDuplicatesPg(
  input: { firstName?: string; lastName?: string; email?: string; primaryPhone?: string; tenantId: string },
  loader: CustomerDuplicateLoader
): Promise<DuplicateWarning[]> {
  const warnings: DuplicateWarning[] = [];
  const candidates = await loader.findDuplicates(input.tenantId, {
    phone: input.primaryPhone,
    email: input.email,
  });

  // Belt-and-braces: never let a cross-tenant row through, even if RLS
  // or the loader misbehaves.
  const sameTenant = candidates.filter((c) => c.tenantId === input.tenantId && !c.isArchived);

  scoreCustomerMatches(input, sameTenant, warnings);

  const seen = new Set<string>();
  return warnings.filter((w) => {
    const key = `${w.existingId}-${w.matchType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Type-guard: does this CustomerRepository also implement the
 * Pg-style duplicate loader? Used by createCustomer to pick the
 * right dedup path.
 */
export function isCustomerDuplicateLoader(
  repo: CustomerRepository | (CustomerRepository & CustomerDuplicateLoader)
): repo is CustomerRepository & CustomerDuplicateLoader {
  return typeof (repo as Partial<CustomerDuplicateLoader>).findDuplicates === 'function';
}
