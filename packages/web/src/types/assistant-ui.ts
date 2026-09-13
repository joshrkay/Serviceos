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
  /**
   * Edit-before-approve inputs. `kind` (review J5) says how the typed input
   * is PARSED before it goes to `PUT /api/proposals/:id { edits }`: a
   * 'cents' field is DOLLARS in the box and integer cents on the wire.
   * Absent means 'text', which is what every pre-existing emitter produces.
   * Without it the card sent the raw string for a `z.number()` payload field
   * and every money edit came back 400 "Invalid payload after edit".
   */
  editFields?: {
    label: string;
    value: string;
    key: string;
    kind?: 'text' | 'cents' | 'number';
  }[];
  confidence: ProposalConfidence;
  type: ProposalType;
  /**
   * 'Undone' (review N10) is a real terminal state — `POST
   * /api/proposals/:id/undo` moves the row to 'undone'. Without it the card
   * kept rendering "Applying shortly; undo now" for a write the operator had
   * just cancelled, because nothing could tell it otherwise.
   */
  status: 'Pending' | 'Approved' | 'Rejected' | 'Undone';
  /**
   * ISO instant the server's 5s undo window closes, present only on a card
   * that arrived ALREADY `Approved` — i.e. the backend auto-approved and
   * queued it with no human tap. The surface rendering the card anchors its
   * undo countdown to this instant (never a fresh client 5s), so the slice of
   * the window the request round-trip already spent is not offered back.
   * Absent ⇒ no server-side window ⇒ no undo affordance.
   */
  undoExpiresAt?: string;
  /**
   * The same window as a DURATION, in milliseconds, measured when the server
   * wrote the response (review N11). Preferred over `undoExpiresAt` because
   * it carries no clock: differencing a server instant against a local
   * `Date.now()` subtracts any skew straight out of a 5-second budget the
   * chat round trip (an LLM call) has already spent most of.
   */
  undoRemainingMs?: number;
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
  /**
   * The backend's internal proposal type (`create_customer`, `draft_estimate`,
   * …). Lets the card special-case a family without pattern-matching on the
   * humanized `type` label.
   */
  proposalType?: string;
  /**
   * `create_customer` only — the ADDRESS SLICE of the proposal payload, keys
   * spelled exactly as `createCustomerPayloadSchema` spells them: the verbatim
   * `address` the technician spoke plus any structured fields already set.
   *
   * Passed through unresolved on purpose. The card runs the SAME
   * `resolveSpokenAddress` the execution handler runs, so what the card calls
   * "still missing" and what the writer calls "can't become a service
   * location" are the same computation, not two that have to be kept in sync.
   */
  addressCapture?: {
    address?: string;
    street1?: string;
    street2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
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
