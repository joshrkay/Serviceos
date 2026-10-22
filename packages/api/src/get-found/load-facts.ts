import type { Pool } from 'pg';
import type {
  CallRoutingMode,
  GetFoundFacts,
  GetFoundItemId,
  GoogleProfileState,
  PresencePath,
} from './derive-checklist';

type Queryable = Pick<Pool, 'query'>;

interface FactsRow {
  presence_path: PresencePath | null;
  google_review_url: string | null;
  call_routing_mode: CallRoutingMode | null;
  forwarding_verified_at: Date | null;
  get_found_skipped_items: GetFoundItemId[] | null;
  google_location_id: string | null;
  twilio_status: string | null;
  twilio_phone: string | null;
}

/**
 * One read over the tenant's settings and its Google / Twilio integration
 * rows. `db` is the request's tenant-bound client on the route path.
 *
 * A Google connection counts as a profile only once it found a location —
 * the connect flow stores tokens without one when discovery fails. Until
 * slice 2 records Google's verification state, a connected location is one
 * the owner already manages, so it reads as verified.
 */
export async function loadGetFoundFacts(db: Queryable, tenantId: string): Promise<GetFoundFacts> {
  const res = await db.query<FactsRow>(
    `SELECT ts.presence_path, ts.google_review_url, ts.call_routing_mode,
            ts.forwarding_verified_at, ts.get_found_skipped_items,
            COALESCE(gb.credentials->'providerData'->>'locationId', gb.credentials->>'locationId') AS google_location_id,
            tw.status AS twilio_status,
            tw.provider_data->>'phoneE164' AS twilio_phone
       FROM tenants t
       LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
       LEFT JOIN tenant_integrations gb ON gb.tenant_id = t.id AND gb.provider = 'google_business'
       LEFT JOIN tenant_integrations tw ON tw.tenant_id = t.id AND tw.provider = 'twilio'
      WHERE t.id = $1`,
    [tenantId],
  );
  const row = res.rows.at(0);
  const googleProfile: GoogleProfileState = row?.google_location_id ? 'verified' : 'none';
  return {
    presencePath: row?.presence_path ?? null,
    googleProfile,
    googleReviewUrl: row?.google_review_url ?? null,
    callRoutingMode: row?.call_routing_mode ?? null,
    rivetNumberProvisioned: row?.twilio_status === 'full_readiness' && !!row.twilio_phone,
    forwardingVerifiedAt: row?.forwarding_verified_at ?? null,
    skippedItems: row?.get_found_skipped_items ?? [],
  };
}
