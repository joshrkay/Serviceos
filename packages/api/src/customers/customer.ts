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
  /**
   * Phase 4c: BCP-47 short code (e.g. 'en', 'es', 'vi') the operator or
   * caller-ID-resolution layer recorded as this customer's preferred
   * language. Read-only on the customer record today (Phase 4c writes
   * only the column + type; the FSM hint that consumes it is Phase 4d
   * once we have ASR-provider language-bias plumbing). Optional —
   * unset means "no preference recorded" and the FSM falls back to
   * detect-from-first-utterance.
   */
  preferredLanguage?: string;
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

export function validateCustomerInput(input: CreateCustomerInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.firstName && !input.companyName) {
    errors.push('firstName or companyName is required');
  }
  if (input.firstName && input.firstName.length > 100) {
    errors.push('firstName must be 100 characters or fewer');
  }
  if (input.lastName && input.lastName.length > 100) {
    errors.push('lastName must be 100 characters or fewer');
  }
  if (!input.createdBy) errors.push('createdBy is required');
  if (input.primaryPhone && !isValidPhone(input.primaryPhone)) {
    errors.push('Invalid primaryPhone format');
  }
  if (input.secondaryPhone && !isValidPhone(input.secondaryPhone)) {
    errors.push('Invalid secondaryPhone format');
  }
  if (input.email && !isValidEmail(input.email)) {
    errors.push('Invalid email format');
  }
  if (input.preferredChannel && !['phone', 'email', 'sms', 'none'].includes(input.preferredChannel)) {
    errors.push('Invalid preferredChannel');
  }
  return errors;
}

export function validateCustomerUpdateInput(
  existing: Customer,
  input: UpdateCustomerInput
): string[] {
  const mergedFirstName = input.firstName ?? existing.firstName;
  const mergedLastName = input.lastName ?? existing.lastName;
  const mergedCompanyName = input.companyName ?? existing.companyName;
  const mergedPrimaryPhone = input.primaryPhone ?? existing.primaryPhone;
  const mergedSecondaryPhone = input.secondaryPhone ?? existing.secondaryPhone;
  const mergedEmail = input.email ?? existing.email;
  const mergedPreferredChannel = input.preferredChannel ?? existing.preferredChannel;

  const errors: string[] = [];

  if (!mergedFirstName && !mergedCompanyName) {
    errors.push('firstName or companyName is required');
  }
  if (mergedFirstName && mergedFirstName.length > 100) {
    errors.push('firstName must be 100 characters or fewer');
  }
  if (mergedLastName && mergedLastName.length > 100) {
    errors.push('lastName must be 100 characters or fewer');
  }
  if (mergedPrimaryPhone && !isValidPhone(mergedPrimaryPhone)) {
    errors.push('Invalid primaryPhone format');
  }
  if (mergedSecondaryPhone && !isValidPhone(mergedSecondaryPhone)) {
    errors.push('Invalid secondaryPhone format');
  }
  if (mergedEmail && !isValidEmail(mergedEmail)) {
    errors.push('Invalid email format');
  }
  if (!['phone', 'email', 'sms', 'none'].includes(mergedPreferredChannel)) {
    errors.push('Invalid preferredChannel');
  }

  return errors;
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

  getAll(): Customer[] {
    return Array.from(this.customers.values()).map((c) => ({ ...c }));
  }
}
