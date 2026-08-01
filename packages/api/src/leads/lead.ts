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
  /**
   * P11-002: optional preferred language. Auto-stamped to 'es' when
   * find-or-create-lead fires for an unknown caller and the detected
   * call language is Spanish; otherwise null and resolved from the
   * tenant default at session time.
   */
  preferredLanguage?: 'en' | 'es';
  /** Optional structured service address — promoted to a primary location on convert. */
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  accessNotes?: string;
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
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  accessNotes?: string;
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
  preferredLanguage?: 'en' | 'es' | null;
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  accessNotes?: string | null;
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

// VQ-002 — InMemoryLeadRepository moved to ./in-memory-lead.ts so the
// in-memory and Pg variants are symmetric (each in its own file). Re-exported
// here so existing callers that import from './lead' continue to compile.
export { InMemoryLeadRepository } from './in-memory-lead';
