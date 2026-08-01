/**
 * Story 15.2 — Speed-to-lead instant response.
 *
 * On a new web/marketplace lead, send an immediate, tenant-templated SMS — the
 * digital equivalent of answering the phone before voicemail, the single
 * biggest determinant of who wins the lead. OFF by default (opt-in) for
 * TCPA/consent safety; the actual send routes through the DNC/consent-gated
 * conversation-reply path, so an opted-out number is never messaged.
 *
 * Pure decision + render live here; the send is injected (`SpeedToLeadSender`)
 * so the production path (find-or-create lead conversation →
 * `sendConversationReply`) and the tests share one contract. Best-effort: a
 * failed first-response must never disturb lead capture (the owner push has
 * already fired in `createLead`).
 */
import type { Lead } from './lead';
import type { LeadSource } from './enums';

/**
 * Lead sources eligible for an automated first-response. Phone-originated
 * leads are excluded — the voice agent already spoke to the caller, so an
 * auto-text would be a redundant second contact.
 */
const SPEED_TO_LEAD_SOURCES: ReadonlySet<LeadSource> = new Set<LeadSource>([
  'web_form',
  'marketplace',
  'customer_portal',
]);

export const DEFAULT_SPEED_TO_LEAD_TEMPLATE =
  'Hi {first_name}, thanks for reaching out to {business_name}! We got your request and will be in touch shortly. Reply STOP to opt out.';

export interface SpeedToLeadContext {
  businessName: string;
  firstName?: string;
}

/**
 * Render the first-response SMS. Substitutes `{first_name}` (→ "there" when
 * the lead gave no name) and `{business_name}` (→ "our team" when unset).
 * Falls back to the built-in default when the tenant hasn't set a template.
 */
export function renderSpeedToLeadMessage(
  template: string | null | undefined,
  ctx: SpeedToLeadContext,
): string {
  const tpl = (template && template.trim()) || DEFAULT_SPEED_TO_LEAD_TEMPLATE;
  const firstName = (ctx.firstName ?? '').trim() || 'there';
  const businessName = (ctx.businessName ?? '').trim() || 'our team';
  return tpl
    .replace(/\{first_name\}/g, firstName)
    .replace(/\{business_name\}/g, businessName)
    .trim();
}

export type SpeedToLeadSkipReason = 'disabled' | 'ineligible_source' | 'no_phone';

export interface SpeedToLeadGateInput {
  enabled: boolean;
  source: LeadSource;
  hasPhone: boolean;
}

export type SpeedToLeadGateResult =
  | { send: true }
  | { send: false; reason: SpeedToLeadSkipReason };

/** Decide whether a new lead should get an automated first-response SMS. */
export function shouldSendSpeedToLead(input: SpeedToLeadGateInput): SpeedToLeadGateResult {
  if (!input.enabled) return { send: false, reason: 'disabled' };
  if (!SPEED_TO_LEAD_SOURCES.has(input.source)) {
    return { send: false, reason: 'ineligible_source' };
  }
  if (!input.hasPhone) return { send: false, reason: 'no_phone' };
  return { send: true };
}

/** Injected send — production routes through the DNC/consent-gated reply path. */
export type SpeedToLeadSender = (args: {
  tenantId: string;
  leadId: string;
  toPhone: string;
  body: string;
}) => Promise<void>;

export interface SpeedToLeadSettings {
  speedToLeadEnabled?: boolean;
  speedToLeadTemplate?: string | null;
}

export interface SendSpeedToLeadDeps {
  send: SpeedToLeadSender;
  /** Optional sink for the best-effort outcome (logging / metrics). */
  onResult?: (r: { leadId: string; sent: boolean; reason: string }) => void;
}

export interface SendSpeedToLeadResult {
  sent: boolean;
  /** 'sent' on success; a skip reason or `send_failed:<msg>` otherwise. */
  reason: string;
}

/**
 * Orchestrate the speed-to-lead first response for a freshly-created lead:
 * gate → render → send. Best-effort — never throws. A DNC block or transport
 * failure surfaces as `sent:false` with a reason, so lead capture is never
 * disturbed by the auto-response.
 */
export async function sendSpeedToLeadResponse(
  deps: SendSpeedToLeadDeps,
  args: { lead: Lead; businessName: string; settings: SpeedToLeadSettings },
): Promise<SendSpeedToLeadResult> {
  const phone = args.lead.primaryPhone?.trim() ?? '';
  const gate = shouldSendSpeedToLead({
    enabled: args.settings.speedToLeadEnabled ?? false,
    source: args.lead.source,
    hasPhone: phone.length > 0,
  });
  if (!gate.send) {
    deps.onResult?.({ leadId: args.lead.id, sent: false, reason: gate.reason });
    return { sent: false, reason: gate.reason };
  }

  const body = renderSpeedToLeadMessage(args.settings.speedToLeadTemplate, {
    businessName: args.businessName,
    firstName: args.lead.firstName,
  });

  try {
    await deps.send({
      tenantId: args.lead.tenantId,
      leadId: args.lead.id,
      toPhone: phone,
      body,
    });
    deps.onResult?.({ leadId: args.lead.id, sent: true, reason: 'sent' });
    return { sent: true, reason: 'sent' };
  } catch (err) {
    const reason = `send_failed:${err instanceof Error ? err.message : String(err)}`;
    deps.onResult?.({ leadId: args.lead.id, sent: false, reason });
    return { sent: false, reason };
  }
}
