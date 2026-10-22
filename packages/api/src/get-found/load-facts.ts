import type { Pool } from 'pg';
import type { ForwardingMode, GetFoundFacts, GetFoundItemId, GoogleProfileState, PresencePath } from './derive-checklist';

type Queryable = Pick<Pool, 'query'>;

interface FactsRow {
  presence_path: PresencePath | null;
  google_review_url: string | null;
  has_existing_line: boolean;
  forwarding_mode: ForwardingMode | null;
  forwarding_verified_at: Date | null;
  get_found_skipped_items: GetFoundItemId[] | null;
  google_location_id: string | null;
  twilio_status: string | null;
  twilio_phone: string | null;
  first_real_call_received: boolean;
}

/**
 * One read over the tenant's settings, its Google / Twilio integration
 * rows, and its onboarding draft's "existing business number" answer (a
 * draft-only answer approve never copies to settings — option b is "Yes, I
 * have a business line"). `db` is the request's tenant-bound client on the route path.
 *
 * A Google connection counts as a profile only once it found a location —
 * the connect flow stores tokens without one when discovery fails. Until
 * the Google slice records Google's verification state, a connected location
 * is one the owner already manages, so it reads as verified.
 */
export async function loadGetFoundFacts(db: Queryable, tenantId: string): Promise<GetFoundFacts> {
  const res = await db.query<FactsRow>(
    `SELECT ts.presence_path, ts.google_review_url,
            (ts.forwarding_source_number IS NOT NULL
              OR d.choices->'existing_number'->>'option' = 'b'
              OR COALESCE((d.choices->'existing_number'->'override'->'writes'->>'hasExistingBusinessNumber')::boolean, false)
            ) AS has_existing_line,
            ts.forwarding_mode, ts.forwarding_verified_at, ts.get_found_skipped_items,
            -- The first real call (activated_at) proves the number only until
            -- the number changes; after a change, a call must reach the new one.
            (ts.activated_at IS NOT NULL AND (
               tw.provider_data->>'phoneE164ChangedAt' IS NULL
               OR EXISTS (SELECT 1 FROM voice_sessions vs
                           WHERE vs.tenant_id = t.id AND vs.channel = 'voice_inbound' AND vs.ended_at IS NOT NULL
                             AND vs.started_at > (tw.provider_data->>'phoneE164ChangedAt')::timestamptz))
            ) AS first_real_call_received,
            COALESCE(gb.credentials->'providerData'->>'locationId', gb.credentials->>'locationId') AS google_location_id,
            tw.status AS twilio_status,
            tw.provider_data->>'phoneE164' AS twilio_phone
       FROM tenants t
       LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
       LEFT JOIN tenant_integrations gb ON gb.tenant_id = t.id AND gb.provider = 'google_business'
       LEFT JOIN tenant_integrations tw ON tw.tenant_id = t.id AND tw.provider = 'twilio'
       LEFT JOIN onboarding_drafts d ON d.tenant_id = t.id
      WHERE t.id = $1`,
    [tenantId],
  );
  const row = res.rows.at(0);
  const googleProfile: GoogleProfileState = row?.google_location_id ? 'verified' : 'none';
  return {
    presencePath: row?.presence_path ?? null,
    googleProfile,
    googleReviewUrl: row?.google_review_url ?? null,
    hasExistingLine: row?.has_existing_line ?? false,
    forwardingCheckPassedAt: row?.forwarding_verified_at ?? null,
    rivetNumberLive: row?.twilio_status === 'full_readiness' && !!row.twilio_phone,
    forwardingMode: row?.forwarding_mode ?? 'missed_calls',
    firstRealCallReceived: row?.first_real_call_received ?? false,
    skippedItems: row?.get_found_skipped_items ?? [],
  };
}
