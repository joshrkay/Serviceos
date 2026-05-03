import { normalizePhone } from '../shared/phone';
import { LeadSource, LeadStage } from './enums';

/**
 * P9-001 — Lead pipeline entity.
 *
 * A `Lead` is a sales-pipeline-only CRM record. Stage transitions are
 * direct PATCHes (CRM bookkeeping), NOT proposals — see lead-service.ts
 * for the full contract.
 */
export interface Lead {
  id: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  companyName?: string;
  primaryPhone?: string;
  email?: string;
  source: LeadSource;
  sourceDetail?: string;
  /** Indexed for reporting (`SELECT … GROUP BY utm_campaign`). */
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  /**
   * Open-shape attribution bag — gclid, fbclid, utm_content, utm_term,
   * referrer, landing_page, user_agent, etc. Stored as JSONB; capped to
   * 20 entries, 500 chars each by the Zod layer.
   */
  attribution?: Record<string, string>;
  stage: LeadStage;
  /** integer cents — never float */
  estimatedValueCents?: number;
  notes?: string;
  assignedUserId?: string;
  /** Set by `convertToCustomer`; null until conversion. */
  convertedCustomerId?: string;
  /** Required when stage='lost'; captured via `lose` endpoint. */
  lostReason?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateLeadInput {
  tenantId: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  primaryPhone?: string;
  email?: string;
  source: LeadSource;
  sourceDetail?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  attribution?: Record<string, string>;
  estimatedValueCents?: number;
  notes?: string;
  assignedUserId?: string;
  createdBy: string;
  actorRole?: string;
}

export interface UpdateLeadInput {
  firstName?: string;
  lastName?: string;
  companyName?: string;
  primaryPhone?: string;
  email?: string;
  source?: LeadSource;
  sourceDetail?: string;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  attribution?: Record<string, string>;
  stage?: LeadStage;
  estimatedValueCents?: number | null;
  notes?: string;
  assignedUserId?: string | null;
  lostReason?: string | null;
  convertedCustomerId?: string | null;
}

export interface LeadListOptions {
  stage?: LeadStage;
  source?: LeadSource;
  assignedUserId?: string;
  /** Pagination cap. Default 50, hard-capped server-side at 200. */
  limit?: number;
  /** Pagination offset. Default 0. */
  offset?: number;
}

export interface LeadListResult {
  data: Lead[];
  total: number;
}

export interface LeadRepository {
  create(lead: Lead): Promise<Lead>;
  findById(tenantId: string, id: string): Promise<Lead | null>;
  findByTenant(tenantId: string, options?: LeadListOptions): Promise<Lead[]>;
  listWithMeta(tenantId: string, options?: LeadListOptions): Promise<LeadListResult>;
  update(tenantId: string, id: string, updates: Partial<Lead>): Promise<Lead | null>;
  /**
   * Find the most recently created open lead matching this normalized phone.
   * Used by the inbound-call skill to dedupe unknown callers without scanning
   * the full tenant. Returns null when no match. The Pg implementation queries
   * the indexed `phone_normalized` generated column; the in-memory fallback
   * normalizes `primaryPhone` on the fly.
   */
  findByPhoneNormalized(tenantId: string, phoneNormalized: string): Promise<Lead | null>;
}

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

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
      const limit = options?.limit !== undefined
        ? Math.min(options.limit, MAX_LIST_LIMIT)
        : results.length;
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
