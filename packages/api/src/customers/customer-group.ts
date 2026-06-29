import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors';

/**
 * U8 (CRM Jobber parity) — customer groups / segmentation.
 *
 * A first-class, named segment with explicit membership — distinct from
 * free-form `customer_tags` (which are ad-hoc labels). Groups are curated
 * collections an owner manages and reuses (e.g. "Service plan members",
 * "Commercial accounts") and can target with marketing campaigns. Mirrors the
 * customer custom-field domain shape (port + pure functions + in-memory repo);
 * Pg impl in `pg-customer-group.ts`.
 */

export interface CustomerGroup {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  /** Optional UI accent (hex like #3b82f6); null = default. */
  color: string | null;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerGroupWithCount extends CustomerGroup {
  memberCount: number;
}

export interface CreateCustomerGroupInput {
  tenantId: string;
  name: string;
  description?: string | null;
  color?: string | null;
  createdBy: string;
  actorRole?: string;
}

export interface UpdateCustomerGroupInput {
  name?: string;
  description?: string | null;
  color?: string | null;
}

export interface CustomerGroupRepository {
  createGroup(group: CustomerGroup): Promise<CustomerGroup>;
  findGroupById(tenantId: string, id: string): Promise<CustomerGroup | null>;
  findGroupByName(tenantId: string, name: string): Promise<CustomerGroup | null>;
  listGroups(tenantId: string, includeArchived?: boolean): Promise<CustomerGroupWithCount[]>;
  updateGroup(group: CustomerGroup): Promise<CustomerGroup>;
  archiveGroup(tenantId: string, id: string): Promise<CustomerGroup | null>;

  /** Returns true if the membership was newly added (false = already a member). */
  addMember(tenantId: string, groupId: string, customerId: string): Promise<boolean>;
  removeMember(tenantId: string, groupId: string, customerId: string): Promise<void>;
  listMemberIds(tenantId: string, groupId: string): Promise<string[]>;
  listGroupsForCustomer(tenantId: string, customerId: string): Promise<CustomerGroup[]>;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function validateCustomerGroupInput(input: {
  name?: string;
  color?: string | null;
}): string[] {
  const errors: string[] = [];
  if (!input.name || !input.name.trim()) errors.push('name is required');
  else if (input.name.trim().length > 100) errors.push('name must be 100 characters or fewer');
  if (input.color != null && input.color !== '' && !HEX_COLOR_RE.test(input.color)) {
    errors.push('color must be a hex value like #3b82f6');
  }
  return errors;
}

export async function createCustomerGroup(
  input: CreateCustomerGroupInput,
  repository: CustomerGroupRepository,
  auditRepo?: AuditRepository
): Promise<CustomerGroup> {
  const errors = validateCustomerGroupInput(input);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const name = input.name.trim();
  const existing = await repository.findGroupByName(input.tenantId, name);
  if (existing && !existing.isArchived) {
    throw new ConflictError(`A customer group named "${name}" already exists`);
  }

  const now = new Date();
  const group: CustomerGroup = {
    id: uuidv4(),
    tenantId: input.tenantId,
    name,
    description: input.description?.trim() || null,
    color: input.color?.trim() || null,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };
  const created = await repository.createGroup(group);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: input.actorRole ?? 'unknown',
        eventType: 'customer_group.created',
        entityType: 'customer_group',
        entityId: created.id,
        metadata: { name: created.name },
      })
    );
  }
  return created;
}

export async function updateCustomerGroup(
  tenantId: string,
  id: string,
  input: UpdateCustomerGroupInput,
  repository: CustomerGroupRepository,
  actorId?: string,
  auditRepo?: AuditRepository,
  actorRole?: string
): Promise<CustomerGroup> {
  const existing = await repository.findGroupById(tenantId, id);
  if (!existing) throw new NotFoundError('Customer group', id);

  const merged = {
    name: input.name !== undefined ? input.name : existing.name,
    color: input.color !== undefined ? input.color : existing.color,
  };
  const errors = validateCustomerGroupInput(merged);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  if (input.name !== undefined && input.name.trim() !== existing.name) {
    const clash = await repository.findGroupByName(tenantId, input.name.trim());
    if (clash && clash.id !== id && !clash.isArchived) {
      throw new ConflictError(`A customer group named "${input.name.trim()}" already exists`);
    }
  }

  const updated: CustomerGroup = {
    ...existing,
    name: input.name !== undefined ? input.name.trim() : existing.name,
    description:
      input.description !== undefined ? input.description?.trim() || null : existing.description,
    color: input.color !== undefined ? input.color?.trim() || null : existing.color,
    updatedAt: new Date(),
  };
  const saved = await repository.updateGroup(updated);

  if (auditRepo && actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: actorRole ?? 'unknown',
        eventType: 'customer_group.updated',
        entityType: 'customer_group',
        entityId: saved.id,
        metadata: { name: saved.name },
      })
    );
  }
  return saved;
}

export async function archiveCustomerGroup(
  tenantId: string,
  id: string,
  repository: CustomerGroupRepository,
  actorId?: string,
  auditRepo?: AuditRepository,
  actorRole?: string
): Promise<CustomerGroup | null> {
  const archived = await repository.archiveGroup(tenantId, id);
  if (archived && auditRepo && actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: actorRole ?? 'unknown',
        eventType: 'customer_group.archived',
        entityType: 'customer_group',
        entityId: archived.id,
        metadata: { name: archived.name },
      })
    );
  }
  return archived;
}

export async function addCustomerToGroup(
  tenantId: string,
  groupId: string,
  customerId: string,
  repository: CustomerGroupRepository,
  actorId?: string,
  auditRepo?: AuditRepository
): Promise<boolean> {
  const group = await repository.findGroupById(tenantId, groupId);
  if (!group) throw new NotFoundError('Customer group', groupId);
  if (group.isArchived) throw new ConflictError('Cannot add members to an archived group');

  const added = await repository.addMember(tenantId, groupId, customerId);
  if (added && auditRepo && actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: 'unknown',
        eventType: 'customer_group.member_added',
        entityType: 'customer',
        entityId: customerId,
        metadata: { groupId, groupName: group.name },
      })
    );
  }
  return added;
}

export async function removeCustomerFromGroup(
  tenantId: string,
  groupId: string,
  customerId: string,
  repository: CustomerGroupRepository,
  actorId?: string,
  auditRepo?: AuditRepository
): Promise<void> {
  await repository.removeMember(tenantId, groupId, customerId);
  if (auditRepo && actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: 'unknown',
        eventType: 'customer_group.member_removed',
        entityType: 'customer',
        entityId: customerId,
        metadata: { groupId },
      })
    );
  }
}

export class InMemoryCustomerGroupRepository implements CustomerGroupRepository {
  private groups: Map<string, CustomerGroup> = new Map();
  // key = `${tenantId}:${groupId}:${customerId}`
  private members: Set<string> = new Set();

  async createGroup(group: CustomerGroup): Promise<CustomerGroup> {
    this.groups.set(group.id, { ...group });
    return { ...group };
  }

  async findGroupById(tenantId: string, id: string): Promise<CustomerGroup | null> {
    const g = this.groups.get(id);
    if (!g || g.tenantId !== tenantId) return null;
    return { ...g };
  }

  async findGroupByName(tenantId: string, name: string): Promise<CustomerGroup | null> {
    // Prefer the active row so the duplicate check sees it (an archived group of
    // the same name must not mask an active one — see pg-customer-group.ts).
    const matches = Array.from(this.groups.values()).filter(
      (g) => g.tenantId === tenantId && g.name.toLowerCase() === name.toLowerCase()
    );
    if (matches.length === 0) return null;
    const active = matches.find((g) => !g.isArchived);
    return { ...(active ?? matches[0]) };
  }

  async listGroups(tenantId: string, includeArchived = false): Promise<CustomerGroupWithCount[]> {
    return Array.from(this.groups.values())
      .filter((g) => g.tenantId === tenantId && (includeArchived || !g.isArchived))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((g) => ({ ...g, memberCount: this.countMembers(tenantId, g.id) }));
  }

  async updateGroup(group: CustomerGroup): Promise<CustomerGroup> {
    this.groups.set(group.id, { ...group });
    return { ...group };
  }

  async archiveGroup(tenantId: string, id: string): Promise<CustomerGroup | null> {
    const g = this.groups.get(id);
    if (!g || g.tenantId !== tenantId) return null;
    const updated = { ...g, isArchived: true, updatedAt: new Date() };
    this.groups.set(id, updated);
    return { ...updated };
  }

  async addMember(tenantId: string, groupId: string, customerId: string): Promise<boolean> {
    const k = `${tenantId}:${groupId}:${customerId}`;
    if (this.members.has(k)) return false;
    this.members.add(k);
    return true;
  }

  async removeMember(tenantId: string, groupId: string, customerId: string): Promise<void> {
    this.members.delete(`${tenantId}:${groupId}:${customerId}`);
  }

  async listMemberIds(tenantId: string, groupId: string): Promise<string[]> {
    const prefix = `${tenantId}:${groupId}:`;
    return Array.from(this.members)
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }

  async listGroupsForCustomer(tenantId: string, customerId: string): Promise<CustomerGroup[]> {
    const suffix = `:${customerId}`;
    const groupIds = Array.from(this.members)
      .filter((k) => k.startsWith(`${tenantId}:`) && k.endsWith(suffix))
      .map((k) => k.split(':')[1]);
    return groupIds
      .map((id) => this.groups.get(id))
      .filter((g): g is CustomerGroup => !!g && !g.isArchived)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((g) => ({ ...g }));
  }

  private countMembers(tenantId: string, groupId: string): number {
    const prefix = `${tenantId}:${groupId}:`;
    let n = 0;
    for (const k of this.members) if (k.startsWith(prefix)) n += 1;
    return n;
  }
}
