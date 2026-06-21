import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';

/**
 * U1 (CRM Jobber parity) — multiple contacts per customer.
 *
 * A B2B / property-manager account separates the decision-maker (`primary`),
 * the bill-to (`billing`), and the on-site contact (`site`) onto distinct
 * rows. Mirrors the customer/service-location domain shape: a port interface
 * (`ContactRepository`), pure orchestration functions that emit audit events,
 * and an in-memory repo for unit tests. The Pg implementation lives in
 * `pg-contact.ts`; both honor the single-primary-per-customer invariant.
 *
 * Server-side dates are `Date`; the over-the-wire contract
 * (`customerContactSchema` in packages/shared) serializes them as ISO strings.
 */

export type CustomerContactRole = 'primary' | 'billing' | 'site' | 'other';

export const CONTACT_ROLES: readonly CustomerContactRole[] = [
  'primary',
  'billing',
  'site',
  'other',
];

export interface CustomerContact {
  id: string;
  tenantId: string;
  customerId: string;
  name: string;
  role: CustomerContactRole;
  phone?: string;
  email?: string;
  /**
   * At most one active contact per customer carries `isPrimary`. Setting it on
   * a contact demotes every sibling — enforced in the repository layer (a
   * cross-row constraint), mirrored by both the Pg and in-memory repos.
   */
  isPrimary: boolean;
  notes?: string;
  isArchived: boolean;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateContactInput {
  tenantId: string;
  customerId: string;
  name: string;
  role?: CustomerContactRole;
  phone?: string;
  email?: string;
  isPrimary?: boolean;
  notes?: string;
  createdBy: string;
  actorRole?: string;
}

export interface UpdateContactInput {
  name?: string;
  role?: CustomerContactRole;
  phone?: string;
  email?: string;
  isPrimary?: boolean;
  notes?: string;
}

export interface ContactRepository {
  create(contact: CustomerContact): Promise<CustomerContact>;
  findById(tenantId: string, id: string): Promise<CustomerContact | null>;
  /**
   * List a customer's contacts, primary first then by role/name. Excludes
   * archived rows unless `includeArchived`. tenant_id is the first predicate
   * (defense-in-depth alongside RLS).
   */
  findByCustomer(
    tenantId: string,
    customerId: string,
    includeArchived?: boolean
  ): Promise<CustomerContact[]>;
  /**
   * Partial update. When `updates.isPrimary === true` the implementation MUST
   * demote every other active contact for the same customer in the same write
   * (single-primary invariant).
   */
  update(
    tenantId: string,
    id: string,
    updates: Partial<CustomerContact>
  ): Promise<CustomerContact | null>;
}

function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validateContactInput(input: {
  name?: string;
  role?: string;
  phone?: string;
  email?: string;
}): string[] {
  const errors: string[] = [];
  if (!input.name || !input.name.trim()) {
    errors.push('name is required');
  }
  if (input.name && input.name.length > 200) {
    errors.push('name must be 200 characters or fewer');
  }
  if (input.role && !CONTACT_ROLES.includes(input.role as CustomerContactRole)) {
    errors.push('Invalid role');
  }
  if (input.phone && !isValidPhone(input.phone)) {
    errors.push('Invalid phone format');
  }
  if (input.email && !isValidEmail(input.email)) {
    errors.push('Invalid email format');
  }
  return errors;
}

export async function createContact(
  input: CreateContactInput,
  repository: ContactRepository,
  auditRepo?: AuditRepository
): Promise<CustomerContact> {
  const errors = validateContactInput(input);
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.customerId) errors.push('customerId is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const now = new Date();
  const contact: CustomerContact = {
    id: uuidv4(),
    tenantId: input.tenantId,
    customerId: input.customerId,
    name: input.name.trim(),
    role: input.role ?? 'other',
    phone: input.phone,
    email: input.email,
    isPrimary: input.isPrimary ?? false,
    notes: input.notes,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };

  const created = await repository.create(contact);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: input.actorRole ?? 'unknown',
        eventType: 'customer_contact.created',
        entityType: 'customer_contact',
        entityId: created.id,
        metadata: { customerId: created.customerId, role: created.role },
      })
    );
  }

  return created;
}

export async function listContacts(
  tenantId: string,
  customerId: string,
  repository: ContactRepository,
  includeArchived = false
): Promise<CustomerContact[]> {
  return repository.findByCustomer(tenantId, customerId, includeArchived);
}

export async function updateContact(
  tenantId: string,
  id: string,
  input: UpdateContactInput,
  repository: ContactRepository,
  actorId?: string,
  auditRepo?: AuditRepository
): Promise<CustomerContact | null> {
  const existing = await repository.findById(tenantId, id);
  if (!existing) return null;

  const errors = validateContactInput({
    name: input.name ?? existing.name,
    role: input.role ?? existing.role,
    phone: input.phone ?? existing.phone,
    email: input.email ?? existing.email,
  });
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const updated = await repository.update(tenantId, id, {
    ...input,
    updatedAt: new Date(),
  });

  if (auditRepo && actorId && updated) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: 'unknown',
        eventType: 'customer_contact.updated',
        entityType: 'customer_contact',
        entityId: id,
        metadata: { customerId: updated.customerId, changes: Object.keys(input) },
      })
    );
  }

  return updated;
}

export async function archiveContact(
  tenantId: string,
  id: string,
  repository: ContactRepository,
  actorId?: string,
  auditRepo?: AuditRepository
): Promise<CustomerContact | null> {
  const updated = await repository.update(tenantId, id, {
    isArchived: true,
    archivedAt: new Date(),
    // An archived contact can no longer be the live primary.
    isPrimary: false,
    updatedAt: new Date(),
  });

  if (auditRepo && actorId && updated) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: 'unknown',
        eventType: 'customer_contact.archived',
        entityType: 'customer_contact',
        entityId: id,
        metadata: { customerId: updated.customerId },
      })
    );
  }

  return updated;
}

/**
 * In-memory contact repository for unit tests. Honors the same
 * single-primary-per-customer invariant as the Pg repo: setting `isPrimary`
 * on a create/update demotes every other active sibling.
 */
export class InMemoryContactRepository implements ContactRepository {
  private contacts: Map<string, CustomerContact> = new Map();

  private demoteSiblings(tenantId: string, customerId: string, exceptId: string): void {
    for (const c of this.contacts.values()) {
      if (
        c.tenantId === tenantId &&
        c.customerId === customerId &&
        c.id !== exceptId &&
        c.isPrimary
      ) {
        this.contacts.set(c.id, { ...c, isPrimary: false, updatedAt: new Date() });
      }
    }
  }

  async create(contact: CustomerContact): Promise<CustomerContact> {
    if (contact.isPrimary) {
      this.demoteSiblings(contact.tenantId, contact.customerId, contact.id);
    }
    this.contacts.set(contact.id, { ...contact });
    return { ...contact };
  }

  async findById(tenantId: string, id: string): Promise<CustomerContact | null> {
    const c = this.contacts.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    return { ...c };
  }

  async findByCustomer(
    tenantId: string,
    customerId: string,
    includeArchived = false
  ): Promise<CustomerContact[]> {
    const roleOrder: Record<CustomerContactRole, number> = {
      primary: 0,
      billing: 1,
      site: 2,
      other: 3,
    };
    return Array.from(this.contacts.values())
      .filter(
        (c) =>
          c.tenantId === tenantId &&
          c.customerId === customerId &&
          (includeArchived || !c.isArchived)
      )
      .sort((a, b) => {
        if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
        if (roleOrder[a.role] !== roleOrder[b.role]) return roleOrder[a.role] - roleOrder[b.role];
        return a.name.localeCompare(b.name);
      })
      .map((c) => ({ ...c }));
  }

  async update(
    tenantId: string,
    id: string,
    updates: Partial<CustomerContact>
  ): Promise<CustomerContact | null> {
    const c = this.contacts.get(id);
    if (!c || c.tenantId !== tenantId) return null;
    if (updates.isPrimary === true) {
      this.demoteSiblings(tenantId, c.customerId, id);
    }
    const updated = { ...c, ...updates };
    this.contacts.set(id, updated);
    return { ...updated };
  }
}
