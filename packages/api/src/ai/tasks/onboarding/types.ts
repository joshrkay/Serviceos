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

// --- Combined extraction ---

export interface OnboardingExtraction {
  transcript: string;
  businessProfile: BusinessProfileExtraction;
  categories: ServiceCategoryExtraction;
  pricing: PricingExtraction;
  team: TeamMemberExtraction;
  schedule: ScheduleExtraction;
}

// --- Proposal payloads ---

export interface OnboardingTenantSettingsPayload {
  businessName: string;
  city?: string;
  state?: string;
  verticalPacks: VerticalType[];
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
