/**
 * Composes dispatcher-ready summaries from FSM context at escalation time.
 *
 * Pure function — no I/O. Used by the escalate-to-human skill to bundle
 * caller identity + intent + transcript snapshot into three coordinated
 * projections (whisper / SMS / in-app panel). Template-based on purpose:
 * adding an LLM call here would block the escalation path with ~500ms of
 * latency and add fabrication risk on critical fields (caller name,
 * address). Spoken phrasing is composed from structured fields.
 */

export type EscalationReason =
  | 'low_confidence_intent'
  | 'operator_request'
  | 'keyword_frustration'
  | 'llm_sentiment'
  | 'emergency_dispatch';

export interface TranscriptTurn {
  role: 'caller' | 'ai';
  text: string;
  ts: number;
}

export interface EscalationContext {
  shopName: string;
  caller: {
    name?: string;
    phone: string;
    customerId?: string;
    tags?: ReadonlyArray<string>;
  };
  customer?: {
    lastService?: { date: Date; type: string; amountCents?: number };
    isMember?: boolean;
    memberTier?: string;
  };
  intent: {
    type: string;
    entities: Record<string, unknown>;
    confidence: number;
  };
  reason: EscalationReason;
  /** Free-form detail: matched keyword, sentiment score, etc. */
  reasonDetail?: string;
  /** Last 4-6 turns before escalation fires. Caller-first ordering. */
  transcriptSnapshot: ReadonlyArray<TranscriptTurn>;
}

export interface PanelData {
  header: { title: string; callerName: string; callerPhone: string };
  customer: {
    name: string;
    phone: string;
    tags: ReadonlyArray<string>;
  };
  lastInteraction: string | null;
  intent: { summary: string; entities: ReadonlyArray<{ key: string; value: string }> };
  reason: { code: EscalationReason; humanReadable: string };
  transcriptSnapshot: ReadonlyArray<TranscriptTurn>;
}

export interface EscalationSummary {
  /** ≤25 words, TTS-friendly, fed to <Say> in whisper TwiML. */
  whisper: string;
  /** ≤160 chars, fits in one SMS segment. */
  sms: string;
  /** Structured object for in-app panel render. */
  panel: PanelData;
}
