import { AuditRepository, createAuditEvent } from '../audit/audit';

/**
 * U2 (CRM Jobber parity) — customer tags.
 *
 * Tags are free-form labels for segmentation ("vip", "net-30", "snowbird").
 * The Customer list contract already declared a `tags` field that was never
 * persisted; this domain makes it real. Tags are normalized (trimmed, inner
 * whitespace collapsed) and de-duplicated per customer; the Pg repo's UNIQUE
 * constraint makes add idempotent. The pure layer emits audit events.
 */

export const MAX_TAG_LENGTH = 50;

/** Normalize a tag for storage/compare: trim + collapse inner whitespace. */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/\s+/g, ' ');
}

export interface TagRepository {
  /** Idempotent add. Returns true when a new row was inserted, false if it already existed. */
  addTag(tenantId: string, customerId: string, tag: string): Promise<boolean>;
  removeTag(tenantId: string, customerId: string, tag: string): Promise<void>;
  listForCustomer(tenantId: string, customerId: string): Promise<string[]>;
  /** Customer ids carrying a given tag — drives the list filter. */
  listCustomerIdsByTag(tenantId: string, tag: string): Promise<string[]>;
  /** Distinct tags in the tenant — drives the tag picker. */
  listDistinctTags(tenantId: string): Promise<string[]>;
}

export function validateTag(tag: string): string[] {
  const errors: string[] = [];
  const normalized = normalizeTag(tag);
  if (!normalized) errors.push('tag is required');
  if (normalized.length > MAX_TAG_LENGTH) {
    errors.push(`tag must be ${MAX_TAG_LENGTH} characters or fewer`);
  }
  return errors;
}

export async function addCustomerTag(
  tenantId: string,
  customerId: string,
  tag: string,
  repository: TagRepository,
  actorId?: string,
  auditRepo?: AuditRepository
): Promise<string> {
  const errors = validateTag(tag);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);
  const normalized = normalizeTag(tag);

  const inserted = await repository.addTag(tenantId, customerId, normalized);

  // Only audit a real state change — re-adding an existing tag is a no-op.
  if (inserted && auditRepo && actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: 'unknown',
        eventType: 'customer.tagged',
        entityType: 'customer',
        entityId: customerId,
        metadata: { tag: normalized },
      })
    );
  }

  return normalized;
}

export async function removeCustomerTag(
  tenantId: string,
  customerId: string,
  tag: string,
  repository: TagRepository,
  actorId?: string,
  auditRepo?: AuditRepository
): Promise<void> {
  const normalized = normalizeTag(tag);
  await repository.removeTag(tenantId, customerId, normalized);

  if (auditRepo && actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: 'unknown',
        eventType: 'customer.untagged',
        entityType: 'customer',
        entityId: customerId,
        metadata: { tag: normalized },
      })
    );
  }
}

export async function listCustomerTags(
  tenantId: string,
  customerId: string,
  repository: TagRepository
): Promise<string[]> {
  return repository.listForCustomer(tenantId, customerId);
}

export class InMemoryTagRepository implements TagRepository {
  // key = `${tenantId}:${customerId}` → Set<tag>
  private byCustomer: Map<string, Set<string>> = new Map();

  private key(tenantId: string, customerId: string): string {
    return `${tenantId}:${customerId}`;
  }

  async addTag(tenantId: string, customerId: string, tag: string): Promise<boolean> {
    const k = this.key(tenantId, customerId);
    const set = this.byCustomer.get(k) ?? new Set<string>();
    const existed = set.has(tag);
    set.add(tag);
    this.byCustomer.set(k, set);
    return !existed;
  }

  async removeTag(tenantId: string, customerId: string, tag: string): Promise<void> {
    this.byCustomer.get(this.key(tenantId, customerId))?.delete(tag);
  }

  async listForCustomer(tenantId: string, customerId: string): Promise<string[]> {
    return Array.from(this.byCustomer.get(this.key(tenantId, customerId)) ?? []).sort();
  }

  async listCustomerIdsByTag(tenantId: string, tag: string): Promise<string[]> {
    const ids: string[] = [];
    for (const [k, set] of this.byCustomer.entries()) {
      const [t, customerId] = k.split(':');
      if (t === tenantId && set.has(tag)) ids.push(customerId);
    }
    return ids;
  }

  async listDistinctTags(tenantId: string): Promise<string[]> {
    const all = new Set<string>();
    for (const [k, set] of this.byCustomer.entries()) {
      if (k.startsWith(`${tenantId}:`)) for (const t of set) all.add(t);
    }
    return Array.from(all).sort();
  }
}
