/**
 * Partner lead-channel adapter seam (LSA / Angi / Thumbtack).
 *
 * SCOPE: interface + stubs ONLY. Live Google LSA / Angi / Thumbtack
 * integrations (signature schemes, OAuth, lead-detail pulls) are sequenced
 * separately as partner access lands — see the loop non-goals. What ships here
 * is the deterministic mapping seam every partner will plug into: a raw partner
 * webhook payload → the canonical shared `InboundLead` contract, which the
 * existing lead-intake path then validates + persists. No network calls, no
 * partner-specific auth.
 */
import { InboundLead, inboundLeadSchema } from '@ai-service-os/shared';

export const PARTNER_CHANNELS = ['google_lsa', 'angi', 'thumbtack'] as const;
export type PartnerChannel = (typeof PARTNER_CHANNELS)[number];

export interface PartnerLeadAdapter {
  readonly channel: PartnerChannel;
  readonly displayName: string;
  /**
   * Map a raw partner webhook payload to the canonical InboundLead. Returns a
   * value validated by `inboundLeadSchema`; throws a ZodError (field-level) if
   * the partner payload lacks a usable name/company + contact channel.
   */
  toInboundLead(raw: Record<string, unknown>): InboundLead;
}

/** First non-empty trimmed string found at any of the given top-level OR
 *  dotted-path keys. Tolerant of the varied shapes partners send. */
export function pickString(
  raw: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = key.includes('.') ? resolvePath(raw, key) : raw[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function resolvePath(raw: Record<string, unknown>, path: string): unknown {
  let cur: unknown = raw;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Shared builder: assemble + validate a marketplace InboundLead from extracted
 * fields. All partner leads land as source 'marketplace' with the originating
 * channel recorded in attribution + sourceDetail; the verbatim payload is
 * retained in rawPayload for the inbox.
 */
export function buildPartnerInboundLead(
  channel: PartnerChannel,
  displayName: string,
  fields: {
    firstName?: string;
    lastName?: string;
    companyName?: string;
    primaryPhone?: string;
    email?: string;
    serviceSummary?: string;
    partnerLeadId?: string;
  },
  raw: Record<string, unknown>,
): InboundLead {
  const sourceDetailParts = [displayName];
  if (fields.serviceSummary) sourceDetailParts.push(fields.serviceSummary);

  const attribution: Record<string, string> = { partner_channel: channel };
  if (fields.partnerLeadId) attribution.partner_lead_id = fields.partnerLeadId;

  return inboundLeadSchema.parse({
    source: 'marketplace',
    firstName: fields.firstName,
    lastName: fields.lastName,
    companyName: fields.companyName,
    primaryPhone: fields.primaryPhone,
    email: fields.email,
    sourceDetail: sourceDetailParts.join(': ').slice(0, 500),
    attribution,
    rawPayload: raw,
  });
}
