import { Customer, CustomerRepository } from './customer';

export interface DuplicateWarning {
  existingId: string;
  matchType: 'phone' | 'email' | 'name' | 'address';
  confidence: 'high' | 'medium';
  /**
   * Numeric confidence score for v1 dedup advisories.
   * Scoring (P1-019):
   *   1.0 — exact normalized match on phone or email (high)
   *   0.8 — exact normalized name match (medium)
   *   0.6 — fuzzy name match via pg_trgm (medium, "possible duplicate"),
   *         or fuzzy/address match candidate (medium, locations only)
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

/**
 * P4-004 — fuzzy name dedup.
 *
 * A trigram similarity that mirrors PostgreSQL `pg_trgm.similarity()`:
 * lowercase, split into alphanumeric words, pad each word with two leading
 * and one trailing space, and emit consecutive 3-character windows. The
 * GIN trgm index `idx_customers_name_trgm` accelerates the SQL pre-filter
 * (`display_name % $name`); this pure function is the deterministic scorer
 * so fuzzy-name behavior is unit-testable without a live database.
 *
 * Two names at/above {@link FUZZY_NAME_THRESHOLD} are flagged as a
 * "possible duplicate" (medium confidence). The threshold sits at/above
 * pg_trgm's default `%` threshold (0.3) so the SQL candidate set is always
 * a superset of what this scorer will flag.
 */
export const FUZZY_NAME_THRESHOLD = 0.4;

export function nameTrigrams(value: string): Set<string> {
  const set = new Set<string>();
  const words = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const word of words) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      set.add(padded.slice(i, i + 3));
    }
  }
  return set;
}

export function nameSimilarity(a: string, b: string): number {
  const ta = nameTrigrams(a);
  const tb = nameTrigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

export async function checkCustomerDuplicates(
  input: { firstName?: string; lastName?: string; companyName?: string; email?: string; primaryPhone?: string; tenantId: string },
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
  input: { firstName?: string; lastName?: string; companyName?: string; email?: string; primaryPhone?: string },
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

    // Name match. Exact normalized match is medium/0.8; a close trigram
    // match (pg_trgm parity) is a "possible duplicate" at medium/0.6.
    // Company-only records (no first/last) fall back to companyName on both
    // sides so B2B duplicates are still caught.
    const inputName =
      [input.firstName, input.lastName].filter(Boolean).join(' ').trim() ||
      (input.companyName ?? '').trim();
    const existingName =
      [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() ||
      customer.displayName;
    if (inputName && existingName) {
      const a = normalizeName(inputName);
      const b = normalizeName(existingName);
      if (a === b) {
        warnings.push({
          existingId: customer.id,
          matchType: 'name',
          confidence: 'medium',
          score: 0.8,
          message: `Name matches existing customer: ${customer.displayName}`,
        });
      } else if (nameSimilarity(a, b) >= FUZZY_NAME_THRESHOLD) {
        warnings.push({
          existingId: customer.id,
          matchType: 'name',
          confidence: 'medium',
          score: 0.6,
          message: `Name closely matches existing customer (possible duplicate): ${customer.displayName}`,
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
    criteria: { phone?: string; email?: string; name?: string }
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
  input: { firstName?: string; lastName?: string; companyName?: string; email?: string; primaryPhone?: string; tenantId: string },
  loader: CustomerDuplicateLoader
): Promise<DuplicateWarning[]> {
  const warnings: DuplicateWarning[] = [];
  // Company-only records fall back to companyName so B2B duplicates are still
  // name-checked (display_name == companyName for those rows).
  const name =
    [input.firstName, input.lastName].filter(Boolean).join(' ').trim() ||
    (input.companyName ?? '').trim();
  const candidates = await loader.findDuplicates(input.tenantId, {
    phone: input.primaryPhone,
    email: input.email,
    name: name || undefined,
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
