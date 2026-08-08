/**
 * Tradesperson wave 1, Task 8 — voice-captured materials/shopping list.
 *
 * A material item is a first-class operational row (like
 * `call_me_back_tasks`), NOT a proposal: capturing "grab 3 boxes of PEX"
 * is a task list entry, not an AI mutation requiring approval. Backed by
 * `material_items` (migration 272), tenant-scoped via RLS. Purchasing/PO
 * automation is a non-goal — `markPurchased` just records who bought it
 * and when.
 *
 * This module is substrate only: nothing constructs a repo instance at
 * the composition root (`app.ts`) yet, and no voice intent reads/writes
 * through it. The forthcoming `add_material` / `lookup_materials` voice
 * intents (tradesperson wave 1, Task 9) will wire it in — mirroring how
 * `expenseRepo` / `agreementRepo` are threaded into the execution-handler
 * deps bag — at which point it starts having real callers instead of
 * sitting unread.
 */
import { v4 as uuidv4 } from 'uuid';
import { ValidationError } from '../shared/errors';

export type MaterialItemStatus = 'pending' | 'purchased' | 'cancelled';

export interface MaterialItem {
  id: string;
  tenantId: string;
  /** Optional link to the job this material is needed for. */
  jobId?: string;
  description: string;
  /** Always a positive integer; defaults to 1 (mirrors the DB column default). */
  quantity: number;
  /** Free-text vendor / supply-house name. */
  vendor?: string;
  status: MaterialItemStatus;
  /** When the material is needed by, if the caller gave a date. */
  neededBy?: Date;
  createdBy: string;
  /** Set once markPurchased succeeds. */
  purchasedBy?: string;
  purchasedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMaterialItemInput {
  tenantId: string;
  jobId?: string;
  description: string;
  /** Defaults to 1. */
  quantity?: number;
  vendor?: string;
  neededBy?: Date;
  createdBy: string;
}

export interface MaterialItemListOptions {
  jobId?: string;
}

export interface MaterialItemRepository {
  create(input: CreateMaterialItemInput): Promise<MaterialItem>;
  /** Pending items for a tenant, oldest-created first; optionally scoped to a job. */
  listPending(tenantId: string, options?: MaterialItemListOptions): Promise<MaterialItem[]>;
  /** Transition pending -> purchased. Null if not found, wrong tenant, or not pending. */
  markPurchased(tenantId: string, id: string, actorId: string): Promise<MaterialItem | null>;
}

export function validateCreateMaterialItemInput(input: CreateMaterialItemInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.createdBy) errors.push('createdBy is required');
  if (!input.description || input.description.trim().length === 0) {
    errors.push('description is required');
  }
  if (input.quantity !== undefined) {
    if (
      typeof input.quantity !== 'number' ||
      !Number.isFinite(input.quantity) ||
      input.quantity <= 0
    ) {
      errors.push('quantity must be a positive number');
    } else if (!Number.isInteger(input.quantity)) {
      errors.push('quantity must be an integer');
    }
  }
  return errors;
}

/** Shared row builder so the in-memory + pg repos stay in shape-sync. */
export function buildMaterialItem(input: CreateMaterialItemInput): MaterialItem {
  const errors = validateCreateMaterialItemInput(input);
  if (errors.length > 0) {
    throw new ValidationError(`Validation failed: ${errors.join(', ')}`);
  }
  const now = new Date();
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    description: input.description.trim(),
    quantity: input.quantity ?? 1,
    ...(input.vendor !== undefined ? { vendor: input.vendor } : {}),
    status: 'pending',
    ...(input.neededBy !== undefined ? { neededBy: input.neededBy } : {}),
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

export class InMemoryMaterialItemRepository implements MaterialItemRepository {
  private readonly items = new Map<string, MaterialItem>();

  async create(input: CreateMaterialItemInput): Promise<MaterialItem> {
    const item = buildMaterialItem(input);
    this.items.set(item.id, item);
    return { ...item };
  }

  async listPending(
    tenantId: string,
    options?: MaterialItemListOptions,
  ): Promise<MaterialItem[]> {
    return Array.from(this.items.values())
      .filter((i) => i.tenantId === tenantId)
      .filter((i) => i.status === 'pending')
      .filter((i) => !options?.jobId || i.jobId === options.jobId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((i) => ({ ...i }));
  }

  async markPurchased(tenantId: string, id: string, actorId: string): Promise<MaterialItem | null> {
    const item = this.items.get(id);
    if (!item || item.tenantId !== tenantId) return null;
    if (item.status !== 'pending') return null;
    const updated: MaterialItem = {
      ...item,
      status: 'purchased',
      purchasedBy: actorId,
      purchasedAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(id, updated);
    return { ...updated };
  }
}
