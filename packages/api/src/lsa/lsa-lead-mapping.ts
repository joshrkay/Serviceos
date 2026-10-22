/**
 * #1738 — LSA lead payload contract + mapping onto the existing Lead model.
 *
 * Pure: no I/O. The payload is OUR normalized delivery shape (what the relay /
 * poller posts), not Google's raw API object — keeping Google's schema out of
 * the ingest boundary so the OAuth poller follow-up only has to normalize into
 * this same shape.
 */
import { z } from 'zod';
import type { CreateLeadInput } from '../leads/lead';
import { LSA_LEAD_TYPES, type LsaLeadType } from './lsa-integration';

const text = (max: number) => z.string().trim().max(max);

export const lsaLeadPayloadSchema = z.object({
  /** Google's lead id — the idempotency key. */
  lead_id: text(128).min(1),
  lead_type: z.enum(LSA_LEAD_TYPES).default('message'),
  customer_name: text(200).optional(),
  phone: text(32).optional(),
  email: text(254).optional(),
  /** Consumer's message / job description, when Google provides one. */
  message: text(2000).optional(),
  /** Service category Google matched (e.g. "hvac", "plumber"). */
  category: text(100).optional(),
  account_id: text(64).optional(),
  campaign_id: text(64).optional(),
  gclid: text(500).optional(),
  /**
   * The sender's assertion that the consumer agreed to be texted (Google's
   * lead consent). Absent/false => NO automated text, whatever the owner
   * opted into. Never inferred.
   */
  sms_consent: z.boolean().optional(),
  /** ISO timestamp Google created the lead (informational). */
  created_at: text(40).optional(),
});
export type LsaLeadPayload = z.infer<typeof lsaLeadPayloadSchema>;

export const LSA_SOURCE_DETAIL = 'Google Local Services Ads';

function splitName(full: string | undefined): { firstName: string; lastName: string } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Map an LSA delivery to a Lead create input: source `marketplace` (the
 * speed-to-lead-eligible paid-marketplace source) with Google attribution in
 * the indexed utm columns plus the open `attribution` bag.
 */
export function mapLsaPayloadToLeadInput(
  tenantId: string,
  payload: LsaLeadPayload,
  integrationAccountId?: string,
): CreateLeadInput {
  const { firstName, lastName } = splitName(payload.customer_name);
  const attribution: Record<string, string> = {
    lsa_lead_id: payload.lead_id,
    lsa_lead_type: payload.lead_type,
  };
  const accountId = payload.account_id || integrationAccountId;
  if (accountId) attribution.lsa_account_id = accountId;
  if (payload.campaign_id) attribution.lsa_campaign_id = payload.campaign_id;
  if (payload.category) attribution.lsa_category = payload.category;
  if (payload.gclid) attribution.gclid = payload.gclid;
  if (payload.created_at) attribution.lsa_created_at = payload.created_at;

  return {
    tenantId,
    firstName,
    lastName,
    // captureLead requires a name or company; an anonymous LSA call/message
    // lead is still a lead the owner must see.
    ...(firstName ? {} : { companyName: 'Google LSA lead' }),
    primaryPhone: payload.phone || undefined,
    email: payload.email || undefined,
    source: 'marketplace',
    sourceDetail: LSA_SOURCE_DETAIL,
    utmSource: 'google',
    utmMedium: 'lsa',
    utmCampaign: payload.campaign_id || 'local_services_ads',
    attribution,
    notes: payload.message || undefined,
    createdBy: 'system:lsa',
    actorRole: 'system',
  };
}

/**
 * Lead types that get the automated first-response text. A phone-call LSA lead
 * already reached the business by voice, so (as with phone-originated leads in
 * speed-to-lead.ts) an auto-text would be a redundant second contact.
 */
export function isSpeedToLeadEligibleLsaType(type: LsaLeadType): boolean {
  return type !== 'phone_call';
}
