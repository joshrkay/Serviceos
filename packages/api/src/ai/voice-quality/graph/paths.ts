/**
 * Agent graph catalog — critical product paths and safety edges on the
 * customer-calling FSM.
 *
 * This is evaluation doctrine, not a runtime engine: the production agent
 * remains the pure reducer in `agents/customer-calling/transitions.ts`.
 * Graph coverage + path smoke measure whether those edges are exercised by
 * corpus scripts and (for intent-bearing edges) by a real model.
 *
 * IDs are stable — reports, CI gates, and path-smoke cases key off them.
 */

import type { CallingAgentState } from '../../agents/customer-calling/types';

/** All FSM states (nodes). Source of truth: CallingAgentState. */
export const FSM_NODES: readonly CallingAgentState[] = [
  'idle',
  'greeting',
  'identifying',
  'ask_caller',
  'intent_capture',
  'entity_resolution',
  'entity_confirm',
  'intent_confirm',
  'proposal_draft',
  'closing',
  'escalating',
  'degraded',
  'terminated',
] as const;

export type CriticalPathKind =
  /** Multi-turn product happy path ending in a proposal or lookup answer. */
  | 'product'
  /** Safety / compliance / escalation edge that must stay reachable. */
  | 'safety'
  /**
   * Structural edge driven by non-LLM events (cost cap, hangup, degrade).
   * Covered by unit/integration tests + scripts, not by path-smoke classify.
   */
  | 'structural';

export type CoverageSource =
  /** At least one Layer-1 corpus script maps to this path. */
  | 'corpus'
  /** Explicit unit/integration test suite (structural edges). */
  | 'unit'
  /** Real-LLM path smoke exercises this path. */
  | 'path-smoke'
  /** Known gap — documented but not exercised. */
  | 'gap';

export interface CriticalPath {
  /** Stable id, e.g. `book`, `negotiation`. */
  id: string;
  title: string;
  kind: CriticalPathKind;
  /**
   * Human-readable description of the trajectory (not a formal graph
   * query language — the FSM is the formal graph).
   */
  description: string;
  /**
   * Representative node sequence for docs/reports. Not exhaustively
   * every legal walk — the primary spine of the path.
   */
  spine: CallingAgentState[];
  /** Intent types the classifier should emit on this path (if any). */
  intents?: readonly string[];
  /**
   * Side-effect / outcome signals used when mapping corpus scripts
   * (proposal types, escalates flag, safety keywords).
   */
  signals: {
    proposalTypes?: readonly string[];
    escalates?: boolean;
    /** Script ids that intentionally exercise this path (hints). */
    scriptIdHints?: readonly string[];
    /** Bucket prefixes that contribute coverage. */
    bucketHints?: readonly string[];
  };
  /**
   * When true, missing corpus coverage fails `agent:graph-coverage --gate`.
   * Structural edges may require unit sources instead of corpus.
   */
  required: boolean;
  /**
   * When true, this path must also appear in the real-LLM path smoke
   * case list (intent-bearing product/safety paths).
   */
  pathSmokeRequired: boolean;
  /**
   * Production wiring notes — e.g. customer sessions currently cannot
   * reach negotiation because extendedIntents is owner-gated.
   */
  productionNotes?: string;
}

/**
 * The critical subgraph we care about for "hosted agents work".
 * Keep this list short and product-shaped — not every lookup intent.
 */
export const CRITICAL_PATHS: readonly CriticalPath[] = [
  {
    id: 'book',
    title: 'Book appointment',
    kind: 'product',
    description:
      'Known customer books a service slot → create_appointment proposal.',
    spine: [
      'greeting',
      'identifying',
      'intent_capture',
      'intent_confirm',
      'proposal_draft',
      'closing',
    ],
    intents: ['create_appointment'],
    signals: {
      proposalTypes: ['create_appointment'],
      escalates: false,
      scriptIdHints: [
        'create-appointment-known-customer',
        'two-step-booking-known-customer',
      ],
      bucketHints: ['02-happy-booker'],
    },
    required: true,
    pathSmokeRequired: true,
    productionNotes:
      'On-call auto-confirm uses D-015 (tenant opt-in). Live path places hold + create_booking when customer/job/time resolve; otherwise draft with honest pending speech.',
  },
  {
    id: 'quote',
    title: 'Grounded mid-call quote',
    kind: 'product',
    description:
      'Caller asks what a job costs → draft_estimate grounded in catalog.',
    spine: [
      'intent_capture',
      'intent_confirm',
      'proposal_draft',
      'closing',
    ],
    intents: ['draft_estimate'],
    signals: {
      proposalTypes: ['create_estimate', 'draft_estimate'],
      scriptIdHints: [
        'ws21b-grounded-quote-catalog',
        'ws21b-quantity-variant-quote',
      ],
      bucketHints: ['02-happy-booker'],
    },
    required: true,
    pathSmokeRequired: true,
  },
  {
    id: 'invoice',
    title: 'Draft invoice from completed work',
    kind: 'product',
    description:
      'Operator asks to invoice a job → create_invoice → draft_invoice proposal.',
    spine: [
      'intent_capture',
      'intent_confirm',
      'proposal_draft',
      'closing',
    ],
    intents: ['create_invoice'],
    signals: {
      proposalTypes: ['draft_invoice'],
      // Operator-ops loop proves the money path; no Layer-1 CSR script required.
      scriptIdHints: [],
      bucketHints: [],
    },
    required: true,
    pathSmokeRequired: true,
    productionNotes:
      'Operator money loop covered by test/voice/operator-ops-loop.test.ts + path-smoke.',
  },
  {
    id: 'payment_chase',
    title: 'Chase unpaid invoice (payment reminder)',
    kind: 'product',
    description:
      'Operator chases collections → send_payment_reminder (comms; human approve).',
    spine: [
      'intent_capture',
      'intent_confirm',
      'proposal_draft',
      'closing',
    ],
    intents: ['send_payment_reminder'],
    signals: {
      proposalTypes: ['send_payment_reminder'],
      scriptIdHints: [],
      bucketHints: [],
    },
    required: true,
    pathSmokeRequired: true,
    productionNotes:
      'Collections path; path-smoke + INTENT_TO_PROPOSAL_TYPE + handler registry.',
  },
  {
    id: 'lead_capture',
    title: 'Capture new customer / lead',
    kind: 'product',
    description: 'Unknown caller signs up → create_customer / lead path.',
    spine: ['ask_caller', 'intent_capture', 'proposal_draft', 'closing'],
    intents: ['create_customer', 'find_or_create_lead'],
    signals: {
      proposalTypes: ['create_customer', 'create_lead'],
      scriptIdHints: [
        'create-customer-new-signup',
        'find-or-create-lead-unknown-caller',
      ],
      bucketHints: ['03-lead-capture'],
    },
    required: true,
    pathSmokeRequired: true,
  },
  {
    id: 'lookup',
    title: 'Read-only account lookup',
    kind: 'product',
    description: 'Caller asks about appointments / jobs / invoices (lookup_*).',
    spine: ['intent_capture', 'intent_capture'],
    intents: [
      'lookup_appointments',
      'lookup_jobs',
      'lookup_invoices',
      'lookup_estimates',
      'lookup_account_summary',
    ],
    signals: {
      scriptIdHints: [
        'lookup-appointments-next',
        'lookup-jobs-known-customer',
        'lookup-invoices-balance',
      ],
      bucketHints: ['01-happy-lookups'],
    },
    required: true,
    pathSmokeRequired: true,
  },
  {
    id: 'operator_request',
    title: 'Explicit human handoff',
    kind: 'safety',
    description:
      'Caller asks for a person → escalate (operator_request guard).',
    spine: ['intent_capture', 'escalating'],
    intents: ['operator_request'],
    signals: {
      escalates: true,
      // Prefer explicit script ids — 07-out-of-scope also holds complaint scripts.
      scriptIdHints: [
        'add-note-escalated',
        'payment-request-escalated',
        'update-customer-escalated',
      ],
      bucketHints: [],
    },
    required: true,
    pathSmokeRequired: true,
  },
  {
    id: 'emergency',
    title: 'Emergency keyword escalation',
    kind: 'safety',
    description:
      'Gas / flood / fire keywords → emergency_detected global guard → escalate.',
    spine: ['intent_capture', 'escalating'],
    intents: ['emergency_dispatch'],
    signals: {
      escalates: true,
      scriptIdHints: ['es-emergency-escalation'],
      // Do NOT list 07-out-of-scope — generic escalate scripts are not emergencies.
      bucketHints: ['11-spanish'],
    },
    required: true,
    pathSmokeRequired: true,
    productionNotes:
      'Primary path is deterministic keyword detection before LLM; path-smoke also checks classifier.',
  },
  {
    id: 'negotiation',
    title: 'Customer price negotiation guardrail',
    kind: 'safety',
    description:
      'Caller haggles on price → negotiation intent → holding line + owner callback (no discount).',
    spine: ['intent_capture', 'intent_capture'],
    intents: ['negotiation'],
    signals: {
      // No Layer-1 script currently targets customer negotiation.
      scriptIdHints: [],
      bucketHints: [],
    },
    required: true,
    pathSmokeRequired: true,
    productionNotes:
      'Classifier section is gated on extendedIntents; telephony only sets that for ownerSession today — customer path is unwired in production.',
  },
  {
    id: 'complaint',
    title: 'Customer complaint capture',
    kind: 'safety',
    description:
      'Caller reports dissatisfaction → complaint intent / escalate path.',
    spine: ['intent_capture', 'escalating'],
    intents: ['complaint'],
    signals: {
      escalates: true,
      scriptIdHints: ['vague-complaint-escalated'],
      bucketHints: [],
    },
    required: true,
    pathSmokeRequired: true,
    productionNotes:
      'vague-complaint-escalated expects escalate without asserting intent=complaint; extendedIntents still owner-gated on live telephony.',
  },
  {
    id: 'confidence_low',
    title: 'Low-confidence reprompt ladder',
    kind: 'safety',
    description:
      'Unintelligible / low-confidence speech → confidence_low → reprompt then escalate.',
    spine: ['intent_capture', 'intent_capture', 'escalating'],
    signals: {
      scriptIdHints: [
        'mumble-low-confidence-reprompt',
        'accent-uncertain-confidence',
      ],
      bucketHints: ['08-ambiguity'],
    },
    required: true,
    pathSmokeRequired: false,
  },
  {
    id: 'cost_cap',
    title: 'Session cost-cap escalation',
    kind: 'structural',
    description: 'cost_cap_exceeded event → escalate to human.',
    spine: ['intent_capture', 'escalating'],
    signals: {
      scriptIdHints: ['cost-cap-drain'],
      bucketHints: ['10-adversarial'],
    },
    required: true,
    pathSmokeRequired: false,
  },
  {
    id: 'hangup',
    title: 'Caller hangup terminal',
    kind: 'structural',
    description: 'caller_hangup from mid-call states → terminated cleanly.',
    spine: ['intent_capture', 'terminated'],
    signals: {
      scriptIdHints: [
        'hangup-before-intent',
        'hangup-mid-confirmation',
        'hangup-post-proposal',
      ],
      bucketHints: ['06-hangup-edges'],
    },
    required: true,
    pathSmokeRequired: false,
  },
  {
    id: 'compliance_dnc',
    title: 'DNC / compliance block',
    kind: 'safety',
    description: 'DNC or STOP → terminate without outbound SMS.',
    spine: ['greeting', 'terminated'],
    signals: {
      scriptIdHints: ['dnc-caller-terminated', 'stop-sent-no-sms'],
      bucketHints: ['05-compliance-edges'],
    },
    required: true,
    pathSmokeRequired: false,
  },
  {
    id: 'spanish_book',
    title: 'Spanish booking path',
    kind: 'product',
    description: 'Spanish caller books successfully (language path).',
    spine: [
      'intent_capture',
      'intent_confirm',
      'proposal_draft',
      'closing',
    ],
    intents: ['create_appointment', 'language_switch'],
    signals: {
      scriptIdHints: ['es-booking-happy-path', 'es-first-utterance-switch'],
      bucketHints: ['11-spanish'],
    },
    required: true,
    pathSmokeRequired: true,
  },
  {
    id: 'post_quote_close',
    title: 'Post-quote affirmative close',
    kind: 'product',
    description:
      'After grounded quote in closing, "yes book it" → post_quote_affirmative (no second intent drop).',
    spine: ['closing', 'closing'],
    signals: {
      // May not have a dedicated script id yet — coverage reports GAP if none.
      scriptIdHints: [],
      bucketHints: ['02-happy-booker'],
    },
    required: false,
    pathSmokeRequired: false,
    productionNotes:
      'WS18 deterministic pre-check; covered by unit tests more than corpus scripts.',
  },
] as const;

export function criticalPathById(id: string): CriticalPath | undefined {
  return CRITICAL_PATHS.find((p) => p.id === id);
}

export function pathSmokeRequiredPaths(): CriticalPath[] {
  return CRITICAL_PATHS.filter((p) => p.pathSmokeRequired);
}

export function requiredPaths(): CriticalPath[] {
  return CRITICAL_PATHS.filter((p) => p.required);
}
