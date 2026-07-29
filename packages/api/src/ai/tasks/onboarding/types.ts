import { VerticalType, ServiceCategory } from '../../../shared/vertical-types';
import { LineItemCategory } from '../../../shared/billing-engine';
import { ConfidenceMetadata } from '../../guardrails/confidence';

// --- Extractor interface ---

export interface ExtractionContext {
  tenantId: string;
  transcript: string;
  conversationId?: string;
  previousExtractions?: Partial<OnboardingExtraction>;
  userId: string;
}

export interface ExtractionResult<T> {
  data: T;
  confidence: ConfidenceMetadata;
  needsClarification: boolean;
  clarificationQuestions?: string[];
}

export interface OnboardingExtractor<T> {
  extractorType: string;
  extract(context: ExtractionContext): Promise<ExtractionResult<T>>;
}

// --- Extraction result types ---

export interface VerticalIdentification {
  type: VerticalType;
  confidence: number;
  sourceText: string;
}

export interface BusinessProfileExtraction {
  businessName: string | null;
  city: string | null;
  state: string | null;
  verticalPacks: VerticalIdentification[];
  serviceDescriptions: string[];
  confidence: number;
  lowConfidenceFields: string[];
}

export interface CategoryMatch {
  verticalType: VerticalType;
  categoryId: string;
  name: string;
  confidence: number;
  sourceText: string;
}

export interface ServiceCategoryExtraction {
  categories: CategoryMatch[];
}

export type PriceType = 'exact' | 'range_start' | 'range_end' | 'hourly_rate' | 'component';

export interface PriceEntry {
  serviceRef: string;
  amountCents: number;
  priceType: PriceType;
  qualifier?: string;
  confidence: number;
  sourceText: string;
}

export interface PricingExtraction {
  prices: PriceEntry[];
}

export type TeamMemberRole = 'technician' | 'dispatcher' | 'owner';

export interface TeamMemberEntry {
  name: string;
  inferredRole: TeamMemberRole;
  confidence: number;
  sourceText: string;
}

export interface TeamMemberExtraction {
  members: TeamMemberEntry[];
}

export interface WorkingHoursEntry {
  days: string[];
  startTime: string;
  endTime: string;
  seasonal?: string;
}

export interface SLAEntry {
  type: 'emergency' | 'standard';
  hoursTarget: number;
  isGuarantee: boolean;
  sourceText: string;
}

export interface ScheduleExtraction {
  workingHours: WorkingHoursEntry[];
  sla?: SLAEntry;
}

/**
 * B1.19 — the `tools` capture state (PRD §8, AC-3). What software/tools
 * the owner currently runs the business with (paper, a spreadsheet, a
 * competitor CRM, QuickBooks, …) — free-text, non-canonical. Unlike the
 * other five extraction states this never becomes an `onboarding_*`
 * proposal: there is no tenant_settings column or other row for
 * "tools currently used," so it's informational context only (surfaced
 * in the review summary), not a config write. See the B1.19 report for
 * the full rationale.
 */
export interface ToolEntry {
  name: string;
  confidence: number;
  sourceText: string;
}

export interface ToolsExtraction {
  tools: ToolEntry[];
}

// --- Combined extraction ---

export interface OnboardingExtraction {
  transcript: string;
  businessProfile: BusinessProfileExtraction;
  categories: ServiceCategoryExtraction;
  pricing: PricingExtraction;
  team: TeamMemberExtraction;
  schedule: ScheduleExtraction;
  // Optional: the dormant single-shot orchestrator (ai/orchestration/onboarding.ts)
  // predates the `tools` capture state and does not populate it; only the
  // conversational FSM (ai/orchestration/onboarding-conversation.ts) does.
  tools?: ToolsExtraction;
}

// --- Proposal payloads ---

export interface OnboardingTenantSettingsPayload {
  businessName: string;
  city?: string;
  state?: string;
  verticalPacks: VerticalType[];
  /**
   * B1.20 — the owner's hourly rate (integer cents), when the pricing
   * capture state extracted a `price_type: 'hourly_rate'` entry (see
   * pricing-extractor.ts). Carried on the tenant-settings proposal
   * (rather than a new proposal type) because both write through the
   * same `upsertIdentityFields` handler that already owns the tenant's
   * identity columns. Absent when the conversation never captured a
   * rate — the handler must never invent one (a wrong hourly rate is a
   * money defect, not just a UX gap).
   */
  hourlyRateCents?: number;
}

export interface OnboardingServiceCategoryPayload {
  verticalType: VerticalType;
  categoryId: string;
  displayName: string;
}

export interface TemplateLineItemPayload {
  description: string;
  category?: LineItemCategory;
  defaultQuantity: number;
  defaultUnitPriceCents: number;
  taxable: boolean;
  sortOrder: number;
}

export interface OnboardingEstimateTemplatePayload {
  verticalType: VerticalType;
  categoryId: string;
  templateName: string;
  lineItems: TemplateLineItemPayload[];
  defaultNotes?: string;
}

export interface OnboardingTeamMemberPayload {
  name: string;
  role: TeamMemberRole;
}

export interface OnboardingSchedulePayload {
  workingHours: WorkingHoursEntry[];
  emergencySLA?: {
    hoursTarget: number;
    isGuarantee: boolean;
  };
}

// --- Orchestration types ---

export interface OnboardingBatch {
  batchIndex: number;
  proposalIds: string[];
}

export interface OnboardingResult {
  extraction: OnboardingExtraction;
  proposalIds: string[];
  batches: OnboardingBatch[];
  needsClarification: boolean;
  clarificationQuestions: string[];
}
