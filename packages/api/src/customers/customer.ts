import { v4 as uuidv4 } from 'uuid';
import { AuditEventInput, AuditRepository, createAuditEvent } from '../audit/audit';
import {
  checkCustomerDuplicatesPg,
  CustomerDuplicateLoader,
  DuplicateWarning,
  isCustomerDuplicateLoader,
  normalizeEmail,
  normalizePhone,
} from './dedup';

export type CustomerWithWarnings = Customer & { warnings?: DuplicateWarning[] };

export type PreferredChannel = 'phone' | 'email' | 'sms' | 'none';

/**
 * Jobber-parity "How did you hear about us?" attribution. Distinct from
 * `originatingLeadId` (which links a specific converted lead): `source` is the
 * marketing channel the customer came in through, set at creation and editable
 * later, so revenue can be rolled up by acquisition channel.
 */
export const CUSTOMER_SOURCES = [
  'website',
  'referral',
  'google',
  'social_media',
  'advertising',
  'repeat_client',
  'other',
] as const;
export type CustomerSource = (typeof CUSTOMER_SOURCES)[number];

export interface Customer {
  id: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  displayName: string;
  companyName?: string;
  // Communication fields (P1-002)
  primaryPhone?: string;
  secondaryPhone?: string;
  email?: string;
  preferredChannel: PreferredChannel;
  smsConsent: boolean;
  /**
   * Derived consent rollup (migration 132), maintained by the compliance
   * layer. 'revoked' means the customer opted out (STOP / manual). Surfaced
   * read-only on the record so opt-out state is visible (Story 10.6).
   */
  consentStatus?: 'granted' | 'revoked' | 'unknown';
  communicationNotes?: string;
  // Archive support
  isArchived: boolean;
  archivedAt?: Date;
  /**
   * Set when this customer was created by converting a Lead. Threads
   * source attribution forward — jobs/invoices created for this customer
   * will inherit it via the route handlers, so a payment can be traced
   * back to the originating campaign with a single join.
   */
  originatingLeadId?: string;
  /** Acquisition channel ("How did you hear about us?"). See CUSTOMER_SOURCES. */
  source?: CustomerSource;
  /**
   * Phase 4c: BCP-47 short code (e.g. 'en', 'es', 'vi') the operator or
   * caller-ID-resolution layer recorded as this customer's preferred
   * language. Read-only on the customer record today (Phase 4c writes
   * only the column + type; the FSM hint that consumes it is Phase 4d
   * once we have ASR-provider language-bias plumbing). Optional —
   * unset means "no preference recorded" and the FSM falls back to
   * detect-from-first-utterance. P11-002 voice flows narrow this at
   * the call-site to 'en' | 'es' for runtime catalog lookups.
   */
  preferredLanguage?: string;
  /**
   * P8-016 — date of birth (additive, migration 113). When present, the
   * vulnerability age detector derives age >65 from this in addition to a
   * self-reported age in the caller's utterance. Optional — most rows have
   * no DOB on file.
   */
  dateOfBirth?: Date;
  /**
   * P8-016 — account classification (additive, migration 113; extended in
   * migration 178 with 'property_manager'). 'b2b' / 'property_manager' mark
   * business accounts (e.g. a property manager reporting on residents); the
   * property-type vulnerability detector fires for these accounts AND
   * explicit currently-occupied intent. Optional — unset means unclassified.
   */
  accountType?: 'residential' | 'b2b' | 'property_manager';
  /**
   * B2B sub-account hierarchy (migration 178). When set, this customer is a
   * sub-account (e.g. a managed property) of the referenced parent customer
   * (e.g. the property-management company). Self-references and cycles are
   * rejected at the repository write boundary.
   */
  parentAccountId?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCustomerInput {
  tenantId: string;
  firstName: string;
  lastName: string;
  companyName?: string;
  primaryPhone?: string;
  secondaryPhone?: string;
  email?: string;
  preferredChannel?: PreferredChannel;
  smsConsent?: boolean;
  communicationNotes?: string;
  source?: CustomerSource;
  createdBy: string;
  actorRole?: string;
}

export interface UpdateCustomerInput {
  firstName?: string;
  lastName?: string;
  companyName?: string;
  primaryPhone?: string;
  secondaryPhone?: string;
  email?: string;
  preferredChannel?: PreferredChannel;
  smsConsent?: boolean;
  communicationNotes?: string;
  source?: CustomerSource;
}

export interface CustomerListOptions {
  includeArchived?: boolean;
  search?: string;
  /** Pagination cap. Default 50, hard-capped server-side at 200. */
  limit?: number;
  /** Pagination offset. Default 0. */
  offset?: number;
  /** Sort direction applied to the canonical sort column (display_name). */
  sort?: 'asc' | 'desc';
}

export interface CustomerListResult {
  data: Customer[];
  total: number;
}

export interface CustomerRepository {
  create(customer: Customer): Promise<Customer>;
  findById(tenantId: string, id: string): Promise<Customer | null>;
  findByTenant(tenantId: string, options?: CustomerListOptions): Promise<Customer[]>;
  /**
   * Paginated list with total count. Optional for InMemory parity in older
   * tests — implementations should provide this when supporting paginated UIs.
   */
  listWithMeta?(tenantId: string, options?: CustomerListOptions): Promise<CustomerListResult>;
  update(tenantId: string, id: string, updates: Partial<Customer>): Promise<Customer | null>;
  search(tenantId: string, query: string): Promise<Customer[]>;
  /**
   * P1-019: Find candidate duplicates by normalized phone OR email,
   * scoped to a single tenant. The normalization rules MUST match
   * those used by `normalizePhone` / `normalizeEmail` in dedup.ts.
   * Excludes archived rows.
   *
   * Optional on the interface so existing test fakes that stub
   * `CustomerRepository` continue to type-check; the dedup code path
   * uses `isCustomerDuplicateLoader()` to detect availability.
   */
  findDuplicates?(
    tenantId: string,
    criteria: { phone?: string; email?: string }
  ): Promise<Customer[]>;
  /**
   * VQ-006 follow-up (PR #265 review): push the lookup-by-phone filter
   * down to the repository so we don't fetch every tenant row to filter
   * in-memory by last-10-digits. The argument is a normalized digits-
   * only string (see `normalizePhone` in dedup.ts); implementations
   * MUST scope by tenantId first (defense-in-depth on top of RLS).
   *
   * Matching semantics: returns rows whose `phone_normalized` ends with
   * the supplied digits (or where the supplied digits end with the
   * stored value, for tolerant short-vs-long matching). This mirrors
   * the previous in-memory tail comparison so caller-ID resolution
   * keeps working across `+15551234567` / `5551234567` / `(555) 123-4567`.
   *
   * Includes archived rows so callers (e.g. `lookup_customer`) decide.
   *
   * Optional on the interface so existing CustomerRepository test
   * fakes keep type-checking — `lookup_customer` falls back to the
   * old findByTenant path when this method is missing.
   */
  findByPhoneNormalized?(
    tenantId: string,
    phoneNormalized: string
  ): Promise<Customer[]>;
  /**
   * U4 (B2B inbound recognition) — load the direct sub-accounts of a parent
   * account (`parent_account_id = parentAccountId`), tenant-scoped. Used when
   * an inbound caller resolves to a business / property-manager account so the
   * call / triage / booking context can carry the managed-property hierarchy
   * and route with priority.
   *
   * tenant_id MUST be the first WHERE predicate (defense-in-depth alongside
   * RLS). Excludes archived rows — a managed property that's been archived is
   * no longer part of the live account context.
   *
   * Optional on the interface so existing CustomerRepository test fakes keep
   * type-checking; the recognition path treats a missing method as "no
   * sub-accounts on file" (graceful standalone).
   */
  findByParentAccount?(
    tenantId: string,
    parentAccountId: string
  ): Promise<Customer[]>;
}

/** Server-side pagination defaults / caps. */
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

function computeDisplayName(firstName: string, lastName: string, companyName?: string): string {
  const name = `${firstName} ${lastName}`.trim();
  return name || companyName || '';
}

function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

interface CustomerFieldValues {
  firstName?: string;
  lastName?: string;
  companyName?: string;
  primaryPhone?: string;
  secondaryPhone?: string;
  email?: string;
  preferredChannel?: string;
  source?: string;
}

/**
 * Field-level rules shared by create and update validation. `alwaysCheckChannel`
 * is true for updates (the resolved channel is always validated) and false for
 * creates (only validated when explicitly provided).
 */
function validateCustomerFields(
  fields: CustomerFieldValues,
  alwaysCheckChannel: boolean
): string[] {
  const errors: string[] = [];
  if (!fields.firstName && !fields.companyName) {
    errors.push('firstName or companyName is required');
  }
  if (fields.firstName && fields.firstName.length > 100) {
    errors.push('firstName must be 100 characters or fewer');
  }
  if (fields.lastName && fields.lastName.length > 100) {
    errors.push('lastName must be 100 characters or fewer');
  }
  if (fields.primaryPhone && !isValidPhone(fields.primaryPhone)) {
    errors.push('Invalid primaryPhone format');
  }
  if (fields.secondaryPhone && !isValidPhone(fields.secondaryPhone)) {
    errors.push('Invalid secondaryPhone format');
  }
  if (fields.email && !isValidEmail(fields.email)) {
    errors.push('Invalid email format');
  }
  if (
    (alwaysCheckChannel || fields.preferredChannel) &&
    !['phone', 'email', 'sms', 'none'].includes(fields.preferredChannel as string)
  ) {
    errors.push('Invalid preferredChannel');
  }
  if (fields.source && !CUSTOMER_SOURCES.includes(fields.source as CustomerSource)) {
    errors.push('Invalid source');
  }
  return errors;
}

export function validateCustomerInput(input: CreateCustomerInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.createdBy) errors.push('createdBy is required');
  errors.push(...validateCustomerFields(input, false));
  return errors;
}

export function validateCustomerUpdateInput(
  existing: Customer,
  input: UpdateCustomerInput
): string[] {
  return validateCustomerFields(
    {
      firstName: input.firstName ?? existing.firstName,
      lastName: input.lastName ?? existing.lastName,
      companyName: input.companyName ?? existing.companyName,
      primaryPhone: input.primaryPhone ?? existing.primaryPhone,
      secondaryPhone: input.secondaryPhone ?? existing.secondaryPhone,
      email: input.email ?? existing.email,
      preferredChannel: input.preferredChannel ?? existing.preferredChannel,
      source: input.source ?? existing.source,
    },
    true
  );
}

export async function createCustomer(
  input: CreateCustomerInput,
  repository: CustomerRepository,
  auditRepo?: AuditRepository
): Promise<CustomerWithWarnings> {
  const errors = validateCustomerInput(input);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  // P1-019: Advisory dedup BEFORE writing — never blocks creation.
  // The build prompt is explicit: warnings only, frontend handles the
  // "this looks like a duplicate" UX. We attach `warnings` to the
  // returned object so the route can surface them without changing
  // the existing 201 response contract.
  let warnings: DuplicateWarning[] | undefined;
  if (
    (input.primaryPhone || input.email) &&
    isCustomerDuplicateLoader(repository)
  ) {
    const found = await checkCustomerDuplicatesPg(
      {
        tenantId: input.tenantId,
        firstName: input.firstName,
        lastName: input.lastName,
        primaryPhone: input.primaryPhone,
        email: input.email,
      },
      repository as CustomerDuplicateLoader
    );
    if (found.length > 0) warnings = found;
  }

  const customer: Customer = {
    id: uuidv4(),
    tenantId: input.tenantId,
    firstName: input.firstName || '',
    lastName: input.lastName || '',
    displayName: computeDisplayName(input.firstName || '', input.lastName || '', input.companyName),
    companyName: input.companyName,
    primaryPhone: input.primaryPhone,
    secondaryPhone: input.secondaryPhone,
    email: input.email,
    preferredChannel: input.preferredChannel || 'none',
    smsConsent: input.smsConsent ?? false,
    communicationNotes: input.communicationNotes,
    source: input.source,
    isArchived: false,
    createdBy: input.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const created = await repository.create(customer);

  if (auditRepo) {
    const event = createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.createdBy,
      actorRole: input.actorRole ?? 'unknown',
      eventType: 'customer.created',
      entityType: 'customer',
      entityId: created.id,
    });
    await auditRepo.create(event);
  }

  return warnings ? { ...created, warnings } : created;
}

export async function getCustomer(
  tenantId: string,
  id: string,
  repository: CustomerRepository
): Promise<Customer | null> {
  return repository.findById(tenantId, id);
}

export async function updateCustomer(
  tenantId: string,
  id: string,
  input: UpdateCustomerInput,
  repository: CustomerRepository,
  actorId?: string,
  auditRepo?: AuditRepository
): Promise<Customer | null> {
  const existing = await repository.findById(tenantId, id);
  if (!existing) return null;

  const validationErrors = validateCustomerUpdateInput(existing, input);
  if (validationErrors.length > 0) throw new Error(`Validation failed: ${validationErrors.join(', ')}`);

  const updates: Partial<Customer> = { ...input, updatedAt: new Date() };
  if (input.firstName !== undefined || input.lastName !== undefined || input.companyName !== undefined) {
    updates.displayName = computeDisplayName(
      input.firstName ?? existing.firstName,
      input.lastName ?? existing.lastName,
      input.companyName ?? existing.companyName
    );
  }

  const updated = await repository.update(tenantId, id, updates);

  if (auditRepo && actorId && updated) {
    const event = createAuditEvent({
      tenantId,
      actorId,
      actorRole: 'unknown',
      eventType: 'customer.updated',
      entityType: 'customer',
      entityId: id,
      metadata: { changes: Object.keys(input) },
    });
    await auditRepo.create(event);
  }

  return updated;
}

export async function archiveCustomer(
  tenantId: string,
  id: string,
  repository: CustomerRepository,
  actorId?: string,
  auditRepo?: AuditRepository
): Promise<Customer | null> {
  const updated = await repository.update(tenantId, id, {
    isArchived: true,
    archivedAt: new Date(),
    updatedAt: new Date(),
  });

  if (auditRepo && actorId && updated) {
    const event = createAuditEvent({
      tenantId,
      actorId,
      actorRole: 'unknown',
      eventType: 'customer.archived',
      entityType: 'customer',
      entityId: id,
    });
    await auditRepo.create(event);
  }

  return updated;
}

export async function restoreCustomer(
  tenantId: string,
  id: string,
  repository: CustomerRepository,
  actorId?: string,
  auditRepo?: AuditRepository
): Promise<Customer | null> {
  const updated = await repository.update(tenantId, id, {
    isArchived: false,
    archivedAt: undefined,
    updatedAt: new Date(),
  });

  if (auditRepo && actorId && updated) {
    const event = createAuditEvent({
      tenantId,
      actorId,
      actorRole: 'unknown',
      eventType: 'customer.restored',
      entityType: 'customer',
      entityId: id,
    });
    await auditRepo.create(event);
  }

  return updated;
}

export async function listCustomers(
  tenantId: string,
  repository: CustomerRepository,
  options?: CustomerListOptions
): Promise<Customer[]> {
  return repository.findByTenant(tenantId, options);
}

/**
 * P1-018: Paginated list helper for routes that need `{ data, total }` to
 * drive frontend pagination. Falls back to `findByTenant` + in-memory paging
 * when the repository hasn't implemented `listWithMeta` (keeps older repo
 * implementations functional).
 */
export async function listCustomersWithMeta(
  tenantId: string,
  repository: CustomerRepository,
  options?: CustomerListOptions
): Promise<CustomerListResult> {
  if (repository.listWithMeta) {
    return repository.listWithMeta(tenantId, options);
  }
  const all = await repository.findByTenant(tenantId, { ...options, limit: undefined, offset: undefined });
  const limit = Math.min(options?.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const offset = options?.offset ?? 0;
  return { data: all.slice(offset, offset + limit), total: all.length };
}

export async function searchCustomers(
  tenantId: string,
  query: string,
  repository: CustomerRepository
): Promise<Customer[]> {
  return repository.search(tenantId, query);
}

export class InMemoryCustomerRepository implements CustomerRepository {
  private customers: Map<string, Customer> = new Map();

  async create(customer: Customer): Promise<Customer> {
    this.customers.set(customer.id, { ...customer });
    return { ...customer };
  }

  async findById(tenantId: string, id: string): Promise<Customer | null> {
    const c = this.customers.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    return { ...c };
  }

  async findByTenant(tenantId: string, options?: CustomerListOptions): Promise<Customer[]> {
    let results = Array.from(this.customers.values()).filter((c) => c.tenantId === tenantId);
    if (!options?.includeArchived) {
      results = results.filter((c) => !c.isArchived);
    }
    if (options?.search) {
      const q = options.search.toLowerCase();
      results = results.filter(
        (c) =>
          c.displayName.toLowerCase().includes(q) ||
          (c.companyName && c.companyName.toLowerCase().includes(q)) ||
          (c.email && c.email.toLowerCase().includes(q)) ||
          (c.primaryPhone && c.primaryPhone.toLowerCase().includes(q))
      );
    }
    // Default sort: name ASC. P1-018 lets callers flip direction.
    const sortDir = options?.sort === 'desc' ? -1 : 1;
    results.sort((a, b) => sortDir * a.displayName.localeCompare(b.displayName));
    if (options?.offset !== undefined || options?.limit !== undefined) {
      const offset = options?.offset ?? 0;
      const limit = options?.limit !== undefined
        ? Math.min(options.limit, MAX_LIST_LIMIT)
        : results.length;
      results = results.slice(offset, offset + limit);
    }
    return results.map((c) => ({ ...c }));
  }

  async listWithMeta(tenantId: string, options?: CustomerListOptions): Promise<CustomerListResult> {
    // Compute total against the unpaginated filtered set so the count
    // reflects the full result the user could page through.
    const totalRows = await this.findByTenant(tenantId, {
      ...options,
      limit: undefined,
      offset: undefined,
    });
    const data = await this.findByTenant(tenantId, options);
    return { data, total: totalRows.length };
  }

  async update(tenantId: string, id: string, updates: Partial<Customer>): Promise<Customer | null> {
    const c = this.customers.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    const updated = { ...c, ...updates };
    this.customers.set(id, updated);
    return { ...updated };
  }

  async search(tenantId: string, query: string): Promise<Customer[]> {
    const q = query.toLowerCase();
    return Array.from(this.customers.values())
      .filter(
        (c) =>
          c.tenantId === tenantId &&
          !c.isArchived &&
          (c.displayName.toLowerCase().includes(q) ||
            (c.companyName && c.companyName.toLowerCase().includes(q)) ||
            (c.email && c.email.toLowerCase().includes(q)) ||
            (c.primaryPhone && c.primaryPhone.includes(q)))
      )
      .map((c) => ({ ...c }));
  }

  /**
   * VQ-006 follow-up (PR #265): in-memory mirror of the Pg phone lookup.
   * Tenant-scope FIRST, then match against the normalized digits using
   * the same tolerant-tail semantics as the pre-refactor lookup-customer
   * skill: stored.endsWith(target) || target.endsWith(stored). Includes
   * archived rows so callers can decide. Returns multiple matches when
   * a phone is shared (e.g. household lines).
   */
  async findByPhoneNormalized(
    tenantId: string,
    phoneNormalized: string
  ): Promise<Customer[]> {
    if (!phoneNormalized || phoneNormalized.length < 7) return [];
    const target = phoneNormalized.slice(-10);
    return Array.from(this.customers.values())
      .filter((c) => c.tenantId === tenantId)
      .filter((c) => {
        if (!c.primaryPhone) return false;
        const stored = normalizePhone(c.primaryPhone);
        return stored.endsWith(target) || target.endsWith(stored);
      })
      .map((c) => ({ ...c }));
  }

  /**
   * P1-019: In-memory mirror of the Pg-backed dedup query.
   * Filters by tenant first, then by normalized phone OR email.
   */
  async findDuplicates(
    tenantId: string,
    criteria: { phone?: string; email?: string }
  ): Promise<Customer[]> {
    const phoneNorm = criteria.phone ? normalizePhone(criteria.phone) : '';
    const emailNorm = criteria.email ? normalizeEmail(criteria.email) : '';
    if (!phoneNorm && !emailNorm) return [];
    return Array.from(this.customers.values())
      .filter((c) => c.tenantId === tenantId && !c.isArchived)
      .filter((c) => {
        const phoneMatch =
          phoneNorm.length >= 7 &&
          c.primaryPhone &&
          normalizePhone(c.primaryPhone) === phoneNorm;
        const emailMatch =
          !!emailNorm && c.email && normalizeEmail(c.email) === emailNorm;
        return phoneMatch || emailMatch;
      })
      .map((c) => ({ ...c }));
  }

  /**
   * U4: in-memory mirror of the Pg sub-account lookup. Tenant-scope FIRST,
   * then match on parentAccountId. Excludes archived rows (parity with the
   * Pg query).
   */
  async findByParentAccount(
    tenantId: string,
    parentAccountId: string
  ): Promise<Customer[]> {
    if (!parentAccountId) return [];
    return Array.from(this.customers.values())
      .filter(
        (c) =>
          c.tenantId === tenantId &&
          !c.isArchived &&
          c.parentAccountId === parentAccountId
      )
      .map((c) => ({ ...c }));
  }

  getAll(): Customer[] {
    return Array.from(this.customers.values()).map((c) => ({ ...c }));
  }
}
