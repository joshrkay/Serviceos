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
import { makeTranslator, type Language } from '../../i18n/i18n';

export type EscalationReason =
  | 'low_confidence_intent'
  | 'operator_request'
  | 'keyword_frustration'
  | 'llm_sentiment'
  | 'emergency_dispatch'
  /**
   * #1616 — the caller's identity could not be verified on this line: they
   * claim to be a customer whose number on file is not this one, their
   * record is archived, or caller identification itself failed.
   */
  | 'identity_unverified';

export interface TranscriptTurn {
  role: 'caller' | 'ai';
  text: string;
  ts: number;
}

export interface EscalationContext {
  shopName: string;
  /** IANA timezone (e.g. "America/New_York"). Defaults to UTC if omitted. */
  tenantTimezone?: string;
  caller: {
    name?: string;
    phone: string;
    customerId?: string;
    tags?: ReadonlyArray<string>;
    /**
     * #1616 — the name the caller gave for themselves when the line could
     * not be matched to a record (an `identity_unverified` hand-off). An
     * unverified CLAIM, never the caller's resolved name: it is only ever
     * rendered as "says they're …".
     */
    claimedName?: string;
  };
  customer?: {
    lastService?: { date: Date; type: string; amountCents?: number };
    isMember?: boolean;
    memberTier?: string;
    /** Free-form CRM notes (e.g. "prefers mornings") — panel only. */
    communicationNotes?: string;
    /**
     * #1616 — the caller's record is archived (#1587: the account is closed,
     * so the AI hands the call off). Names the identity problem for an
     * `identity_unverified` hand-off.
     */
    isArchived?: boolean;
  };
  intent: {
    type: string;
    entities: Record<string, unknown>;
    confidence: number;
  };
  reason: EscalationReason;
  /** Free-form detail: matched keyword, sentiment score, etc. */
  reasonDetail?: string;
  /**
   * #1616 — language of the dispatcher-facing identity copy (EN + ES).
   * Defaults to 'en'. This is the DISPATCHER's language, not the caller's:
   * no tenant setting carries it yet, so every production caller leaves it
   * unset. The rest of the summary (frame, intent, next action) is EN-only.
   */
  language?: Language;
  /** Last 4-6 turns before escalation fires. Caller-first ordering. */
  transcriptSnapshot: ReadonlyArray<TranscriptTurn>;
  /**
   * Public web app base URL (no trailing slash). Used to construct the
   * SMS short-link. Defaults to `app.rivet.ai` if not provided.
   * Pass `process.env.PUBLIC_WEB_URL` or equivalent at the call site.
   */
  publicWebBaseUrl?: string;
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

/**
 * #1616 — dispatcher-facing copy for an identity hand-off, EN + ES. It lives
 * here with its sibling reason phrases (`reasonHuman` / `reasonShort`), not
 * in tts-copy.ts, which holds CALLER-facing speech: the dispatcher hears and
 * reads these lines, the caller never does. `{{name}}` is the name the caller
 * gave for themselves (`caller.claimedName`).
 */
const identityCopy = makeTranslator({
  en: {
    'identity.claims.sentence':
      "Caller says they're {{name}} but the number doesn't match their record",
    // SMS forms are compact: the segment budget leaves ~30 chars after
    // "Reason:", so the claim leads and the qualifier is what a cut takes.
    'identity.claims.sms': "says they're {{name}} (unverified)",
    'identity.archived.sentence': "Caller's record is archived",
    'identity.archived.sms': 'record archived',
    'identity.unverified.sentence': "Caller's identity couldn't be verified",
    'identity.unverified.sms': 'identity unverified',
  },
  es: {
    'identity.claims.sentence':
      'La persona que llama dice ser {{name}}, pero el número no coincide con su registro',
    'identity.claims.sms': 'dice ser {{name}} (sin verificar)',
    'identity.archived.sentence': 'El registro de la persona que llama está archivado',
    'identity.archived.sms': 'registro archivado',
    'identity.unverified.sentence':
      'No se pudo verificar la identidad de la persona que llama',
    'identity.unverified.sms': 'identidad sin verificar',
  },
});

/**
 * Which identity problem to name for an `identity_unverified` hand-off. An
 * archived record outranks a claimed name: a record bound to this line is
 * known, a claim is not.
 */
function identityCase(ctx: EscalationContext): 'archived' | 'claims' | 'unverified' {
  if (ctx.customer?.isArchived) return 'archived';
  if (ctx.caller.claimedName) return 'claims';
  return 'unverified';
}

/** The plain sentence (panel + whisper) or the compact SMS form. */
function identityReason(ctx: EscalationContext, form: 'sentence' | 'sms'): string {
  const lang: Language = ctx.language ?? 'en';
  const vars = ctx.caller.claimedName ? { name: ctx.caller.claimedName } : undefined;
  return identityCopy(`identity.${identityCase(ctx)}.${form}`, lang, vars);
}

function reasonHuman(ctx: EscalationContext): string {
  const detail = ctx.reasonDetail;
  switch (ctx.reason) {
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
    case 'identity_unverified':
      return identityReason(ctx, 'sentence');
  }
}

/**
 * The reason after "Reason:" in the whisper (spoken, ≤25 words overall) or
 * the SMS (one segment, so the identity forms are compact there).
 */
function reasonShort(ctx: EscalationContext, channel: 'whisper' | 'sms'): string {
  switch (ctx.reason) {
    case 'operator_request': return 'operator request';
    case 'keyword_frustration': return 'frustration';
    case 'llm_sentiment': return 'frustration';
    case 'low_confidence_intent': return 'low confidence';
    case 'emergency_dispatch': return 'emergency';
    case 'identity_unverified':
      return channel === 'sms'
        ? identityReason(ctx, 'sms')
        : lowerFirst(identityReason(ctx, 'sentence'));
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

/**
 * Voice-parity (Feature 7) — a short imperative "what to do next" derived from
 * the caller's intent, so the receiving CSR sees a suggested next action in the
 * whisper / SMS / panel without parsing the transcript.
 */
function nextActionShort(intent: EscalationContext['intent']): string {
  switch (intent.type) {
    case 'create_appointment':
    case 'create_booking':
      return 'book the visit';
    case 'reschedule_appointment':
      return 'reschedule the visit';
    case 'cancel_appointment':
      return 'cancel the visit';
    case 'confirm_appointment':
      return 'confirm the visit';
    case 'create_invoice':
    case 'lookup_invoices':
      return 'pull up the invoice';
    case 'lookup_balance':
      return 'check the balance';
    case 'create_customer':
      return 'set up the new customer';
    case 'draft_estimate':
      return 'prepare the estimate';
    case 'emergency_dispatch':
      return 'dispatch a tech now';
    case 'reassign_appointment':
      return 'assign a different tech';
    default:
      return 'help the caller';
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
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

function lastInteractionText(customer?: EscalationContext['customer'], timeZone = 'UTC'): string | null {
  const parts: string[] = [];
  if (customer?.lastService) {
    const { date, type, amountCents } = customer.lastService;
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone });
    const amount = amountCents != null ? `, $${(amountCents / 100).toFixed(2)}` : '';
    parts.push(`Last service: ${dateStr} — ${type}${amount}`);
  }
  const notes = customer?.communicationNotes?.trim();
  if (notes) {
    const clipped = notes.length > 120 ? `${notes.slice(0, 117)}…` : notes;
    parts.push(`Notes: ${clipped}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function entitiesAsList(entities: Record<string, unknown>): ReadonlyArray<{ key: string; value: string }> {
  return Object.entries(entities)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => ({ key: k, value: String(v) }));
}

function buildWhisperString(callerName: string, intentText: string, member: string, reasonText: string): string {
  return [
    `Incoming call from ${callerName}.`,
    capitalizeFirst(`${intentText}.`),
    member,
    `Reason: ${reasonText}.`,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function smartTruncate(s: string, maxWords: number): string {
  const words = s.split(/\s+/);
  if (words.length <= maxWords) return s;
  // Truncate to maxWords, then walk back to the last sentence terminator.
  const truncated = words.slice(0, maxWords).join(' ');
  const lastPeriod = Math.max(
    truncated.lastIndexOf('.'),
    truncated.lastIndexOf('?'),
    truncated.lastIndexOf('!'),
  );
  if (lastPeriod >= truncated.length / 2) {
    // We have at least half the content ending at a sentence boundary — good.
    return truncated.slice(0, lastPeriod + 1);
  }
  // No clean break; strip trailing punctuation/preposition and add a period.
  const stripped = truncated.replace(/[:;,]+$/, '').replace(/\s+(of|and|the|a|to|in|on|for|with|from)$/i, '');
  return `${stripped}.`;
}

export function buildEscalationSummary(ctx: EscalationContext): EscalationSummary {
  const callerName = ctx.caller.name?.trim() || 'Unknown caller';
  const phoneReadable = formatPhone(ctx.caller.phone);
  const intent = intentShort(ctx.intent);
  const member = membershipPhrase(ctx.customer);
  const reasonText = reasonShort(ctx, 'whisper');
  const smsReasonText = reasonShort(ctx, 'sms');
  const nextAction = nextActionShort(ctx.intent);

  // Whisper: target ≤25 words. Drop membership phrase if needed, then smart-truncate.
  const whisperFull = `${buildWhisperString(callerName, intent, member, reasonText)} Suggested: ${nextAction}.`;
  let whisper: string;
  if (whisperFull.split(/\s+/).length <= 25) {
    whisper = whisperFull;
  } else {
    // Try dropping the membership phrase first (keep the suggested action).
    const withoutMember = `${buildWhisperString(callerName, intent, '', reasonText)} Suggested: ${nextAction}.`;
    if (withoutMember.split(/\s+/).length <= 25) {
      whisper = withoutMember;
    } else {
      whisper = smartTruncate(withoutMember, 25);
    }
  }

  // SMS: target ≤160 chars. Always reserve space for the link; truncate core at word boundary.
  const baseUrl = (ctx.publicWebBaseUrl ?? 'app.rivet.ai')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
  const linkPlaceholder = `${baseUrl}/c/<escalationId>`;
  const linkBudget = linkPlaceholder.length + 1; // space before link
  const coreBudget = 160 - linkBudget;

  let smsCore = `${ctx.shopName}: Incoming call from ${callerName} (${phoneReadable}). Re: ${intent}.${member ? ' ' + member : ''} Reason: ${smsReasonText}. Next: ${nextAction}.`;

  if (smsCore.length > coreBudget) {
    // Truncate at last word boundary within budget, append ellipsis.
    const cutAt = smsCore.lastIndexOf(' ', coreBudget - 1);
    smsCore = (cutAt > 0 ? smsCore.slice(0, cutAt) : smsCore.slice(0, coreBudget - 1)) + '…';
  }

  const sms = `${smsCore} ${linkPlaceholder}`;

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
    lastInteraction: lastInteractionText(ctx.customer, ctx.tenantTimezone),
    intent: {
      summary: `Calling about: ${intent}. Suggested next: ${nextAction}`,
      entities: entitiesAsList(ctx.intent.entities),
    },
    reason: {
      code: ctx.reason,
      humanReadable: reasonHuman(ctx),
    },
    transcriptSnapshot: ctx.transcriptSnapshot,
  };

  return { whisper, sms, panel };
}

function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s[0].toLowerCase() + s.slice(1);
}
