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

function reasonHuman(reason: EscalationReason, detail?: string): string {
  switch (reason) {
    case 'operator_request':
      return 'Caller asked for a person';
    case 'keyword_frustration':
      return `Frustration detected${detail ? ` (${detail})` : ''}`;
    case 'llm_sentiment':
      return `Frustration detected${detail ? ` (sentiment ${detail})` : ''}`;
    case 'low_confidence_intent':
      return "AI didn't catch what they wanted after retries";
    case 'emergency_dispatch':
      return 'Emergency dispatch';
  }
}

function reasonShort(reason: EscalationReason): string {
  switch (reason) {
    case 'operator_request': return 'operator request';
    case 'keyword_frustration': return 'frustration';
    case 'llm_sentiment': return 'frustration';
    case 'low_confidence_intent': return 'low confidence';
    case 'emergency_dispatch': return 'emergency';
  }
}

function intentShort(intent: EscalationContext['intent']): string {
  const service = typeof intent.entities.service === 'string' ? intent.entities.service : null;
  switch (intent.type) {
    case 'create_appointment':
      return service ? `scheduling a ${service} visit` : 'scheduling a visit';
    case 'lookup_appointments': return 'checking on an appointment';
    case 'lookup_invoices': return 'asking about an invoice';
    case 'lookup_balance': return 'asking about their balance';
    case 'create_invoice': return 'wants an invoice';
    case 'cancel_appointment': return 'wants to cancel an appointment';
    case 'reschedule_appointment': return 'wants to reschedule';
    case 'reassign_appointment': return 'wants a different tech';
    case 'emergency_dispatch': return 'emergency';
    case 'unknown': return 'unclear what they need';
    default: return intent.type.replace(/_/g, ' ');
  }
}

function membershipPhrase(customer?: EscalationContext['customer']): string {
  if (!customer?.isMember) return '';
  return customer.memberTier ? `${customer.memberTier} member.` : 'Member.';
}

function formatPhone(phone: string): string {
  // E.164 → readable: +15125550142 → 512-555-0142
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    const d = digits.slice(1);
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return phone;
}

function lastInteractionText(customer?: EscalationContext['customer']): string | null {
  if (!customer?.lastService) return null;
  const { date, type, amountCents } = customer.lastService;
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const amount = amountCents != null ? `, $${(amountCents / 100).toFixed(0)}` : '';
  return `Last service: ${dateStr} — ${type}${amount}`;
}

function entitiesAsList(entities: Record<string, unknown>): ReadonlyArray<{ key: string; value: string }> {
  return Object.entries(entities)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => ({ key: k, value: String(v) }));
}

export function buildEscalationSummary(ctx: EscalationContext): EscalationSummary {
  const callerName = ctx.caller.name?.trim() || 'Unknown caller';
  const phoneReadable = formatPhone(ctx.caller.phone);
  const intent = intentShort(ctx.intent);
  const member = membershipPhrase(ctx.customer);
  const reasonText = reasonShort(ctx.reason);

  // Whisper: target ≤25 words. Drop membership phrase if needed.
  const whisperFull = [
    `Incoming call from ${callerName}.`,
    capitalizeFirst(`${intent}.`),
    member,
    `Reason: ${reasonText}.`,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const whisper = ensureMaxWords(whisperFull, 25);

  // SMS: target ≤160 chars. Short link placeholder; route resolves to mobile panel.
  const linkPlaceholder = `app.serviceos.app/c/<escalationId>`;
  const smsCore = `${ctx.shopName}: Incoming call from ${callerName} (${phoneReadable}). Re: ${intent}.${member ? ' ' + member : ''} Reason: ${reasonText}.`;
  const sms = (smsCore.length + linkPlaceholder.length + 1 <= 160)
    ? `${smsCore} ${linkPlaceholder}`
    : `${smsCore}`.slice(0, 160);

  const panel: PanelData = {
    header: {
      title: 'Incoming transfer — answering now',
      callerName,
      callerPhone: phoneReadable,
    },
    customer: {
      name: callerName,
      phone: phoneReadable,
      tags: ctx.caller.tags ?? [],
    },
    lastInteraction: lastInteractionText(ctx.customer),
    intent: {
      summary: `Calling about: ${intent}`,
      entities: entitiesAsList(ctx.intent.entities),
    },
    reason: {
      code: ctx.reason,
      humanReadable: reasonHuman(ctx.reason, ctx.reasonDetail),
    },
    transcriptSnapshot: ctx.transcriptSnapshot,
  };

  return { whisper, sms, panel };
}

function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function ensureMaxWords(s: string, maxWords: number): string {
  const words = s.split(/\s+/);
  if (words.length <= maxWords) return s;
  return words.slice(0, maxWords).join(' ');
}
