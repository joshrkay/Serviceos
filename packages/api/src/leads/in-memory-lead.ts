/**
 * VQ-002 — InMemoryLeadRepository (canonical module).
 *
 * Mirrors `InMemoryCustomerRepository` (packages/api/src/customers/customer.ts)
 * — tenant-isolated `Map<id, Lead>` with copy-on-read / copy-on-write semantics
 * so callers can safely mutate the returned objects without corrupting state.
 *
 * Implements the `LeadRepository` interface from `./lead` verbatim so it is
 * substitutable with `PgLeadRepository` (packages/api/src/leads/pg-lead.ts) at
 * any call site (the Voice Quality Layer 1 corpus runner is the primary new
 * consumer; the production wiring in `app.ts` selects between them based on
 * Pool availability).
 *
 * Originally lived inline in `./lead`; extracted here so the in-memory and
 * Pg variants are symmetric (each in its own file) and so test code can
 * import the in-memory repo without pulling the full lead-service surface.
 * The original `./lead` re-exports for backwards-compat with existing callers.
 */
import { normalizePhone } from '../shared/phone';
import {
  DEFAULT_LIST_LIMIT,
  Lead,
  LeadListOptions,
  LeadListResult,
  LeadRepository,
  MAX_LIST_LIMIT,
} from './lead';

export class InMemoryLeadRepository implements LeadRepository {
  private leads: Map<string, Lead> = new Map();

  async create(lead: Lead): Promise<Lead> {
    this.leads.set(lead.id, { ...lead });
    return { ...lead };
  }

  async findById(tenantId: string, id: string): Promise<Lead | null> {
    const l = this.leads.get(id);
    if (!l || l.tenantId !== tenantId) return null;
    return { ...l };
  }

  private filterAndSort(tenantId: string, options?: LeadListOptions): Lead[] {
    let results = Array.from(this.leads.values()).filter((l) => l.tenantId === tenantId);
    if (options?.stage) results = results.filter((l) => l.stage === options.stage);
    if (options?.source) results = results.filter((l) => l.source === options.source);
    if (options?.assignedUserId) {
      results = results.filter((l) => l.assignedUserId === options.assignedUserId);
    }
    // Newest first — kanban / list both want this.
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return results;
  }

  async findByTenant(tenantId: string, options?: LeadListOptions): Promise<Lead[]> {
    let results = this.filterAndSort(tenantId, options);
    if (options?.offset !== undefined || options?.limit !== undefined) {
      const offset = options?.offset ?? 0;
      const limit =
        options?.limit !== undefined ? Math.min(options.limit, MAX_LIST_LIMIT) : results.length;
      results = results.slice(offset, offset + limit);
    }
    return results.map((l) => ({ ...l }));
  }

  async listWithMeta(tenantId: string, options?: LeadListOptions): Promise<LeadListResult> {
    const all = this.filterAndSort(tenantId, options);
    const offset = options?.offset ?? 0;
    const limit = Math.min(options?.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    return {
      data: all.slice(offset, offset + limit).map((l) => ({ ...l })),
      total: all.length,
    };
  }

  async update(tenantId: string, id: string, updates: Partial<Lead>): Promise<Lead | null> {
    const l = this.leads.get(id);
    if (!l || l.tenantId !== tenantId) return null;
    const merged = { ...l, ...updates };
    this.leads.set(id, merged);
    return { ...merged };
  }

  async findByPhoneNormalized(
    tenantId: string,
    phoneNormalized: string
  ): Promise<Lead | null> {
    if (!phoneNormalized) return null;
    const matches = Array.from(this.leads.values())
      .filter(
        (l) =>
          l.tenantId === tenantId &&
          l.primaryPhone &&
          normalizePhone(l.primaryPhone) === phoneNormalized
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return matches.length > 0 ? { ...matches[0] } : null;
  }

  /** Test helper. */
  getAll(): Lead[] {
    return Array.from(this.leads.values()).map((l) => ({ ...l }));
  }
}
