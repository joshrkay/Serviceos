/**
 * Assistant / AI proposal UI shapes.
 * Types only — no fixture messages or sample proposals.
 */

export type ProposalType =
  | 'Invoice'
  | 'Estimate'
  | 'Schedule'
  | 'Follow-up'
  | 'Alert'
  | 'Duplicate'
  | 'Customer'
  | 'Clarification'
  | 'Note'
  | 'Payment'
  | 'Send';

export type ProposalConfidence = 'High' | 'Medium';

/**
 * 4-tier confidence vocabulary stamped on `payload._meta.overallConfidence`
 * (mirrors the API's CONFIDENCE_LEVELS).
 */
export type ProposalConfidenceLevel = 'high' | 'medium' | 'low' | 'very_low';

/** Severity tiers (same scale as voice triage) — MMS photo drafts. */
export type ProposalSeverity =
  | 'TIER_1_EVACUATE'
  | 'TIER_2_EMERGENCY_DISPATCH'
  | 'TIER_3_SAME_DAY_URGENT'
  | 'TIER_4_SCHEDULE';

/**
 * UI projection of the backend's `proposalConfidenceMetaSchema` (`_meta`).
 * Only the fields the review card renders are carried.
 */
export interface ProposalConfidenceMeta {
  overallConfidence: ProposalConfidenceLevel;
  fieldConfidence?: Record<string, ProposalConfidenceLevel>;
  /** Urgency of the visible problem (set on MMS photo drafts). */
  severity?: ProposalSeverity;
  /** "What I wasn't sure about" callouts the card surfaces. */
  markers?: { path: string; reason: string }[];
  /**
   * Owner standing instructions the drafting AI applied (server-side
   * intersected with what was injected; ids are never model-invented).
   */
  appliedStandingInstructions?: { id: string; text: string }[];
}

/**
 * Per-line subset the review card needs for the catalog-grounding badge.
 * Backend stamps `pricingSource` on each estimate/invoice line; 'manual'
 * is operator-entered and not badged.
 */
export interface ProposalLineMarker {
  description: string;
  pricingSource?: 'catalog' | 'ambiguous' | 'uncatalogued' | 'manual';
}

export interface AIProposal {
  id: string;
  title: string;
  summary: string;
  explanation: string;
  reasoning?: string[];
  editFields?: { label: string; value: string; key: string }[];
  confidence: ProposalConfidence;
  type: ProposalType;
  status: 'Pending' | 'Approved' | 'Rejected';
  relatedId?: string;
  impact?: string;
  /**
   * When the backend emits a voice_clarification proposal, guessed
   * intent(s) for "Did you mean…?" chips. Undefined otherwise.
   */
  suggestedIntents?: string[];
  /**
   * Fields the task handler couldn't fill from the transcript.
   * Approve is blocked until the operator fills each missing field.
   */
  missingFields?: string[];
  /** Backend payload `_meta` confidence fragment for the 4-tier bar. */
  meta?: ProposalConfidenceMeta;
  /** Per-line catalog-grounding signal (`pricingSource`). */
  lineItems?: ProposalLineMarker[];
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  time: string;
  inputMode?: 'text' | 'voice' | 'photo';
  voiceDuration?: number;
  attachments?: { type: 'photo' | 'document'; url?: string; name?: string }[];
  proposal?: AIProposal;
  autoApplied?: boolean;
  reasoning?: string;
}
