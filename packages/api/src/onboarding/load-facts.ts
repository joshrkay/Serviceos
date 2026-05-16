import type { Pool } from 'pg';
import type { SettingsRepository } from '../settings/settings';
import type { OnboardingFacts } from './derive-status';

const VALID_SUBSCRIPTION_STATUSES = new Set(['trialing', 'active', 'past_due', 'canceled', 'incomplete']);
type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete';

function normalizeSubscriptionStatus(raw: string | null | undefined): SubscriptionStatus | null {
  if (!raw) return null;
  return VALID_SUBSCRIPTION_STATUSES.has(raw) ? (raw as SubscriptionStatus) : null;
}

export interface LoadFactsDeps {
  pool: Pool;
  settingsRepo: SettingsRepository;
}

export async function loadOnboardingFacts(deps: LoadFactsDeps, tenantId: string): Promise<OnboardingFacts> {
  const { pool, settingsRepo } = deps;

  const [settings, integRes, tenantRes, callsRes, tsRes] = await Promise.all([
    settingsRepo.findByTenant(tenantId),
    pool.query<{ status: string }>(
      `SELECT status FROM tenant_integrations WHERE tenant_id=$1 AND provider='twilio' LIMIT 1`,
      [tenantId]
    ),
    pool.query<{ stripe_subscription_id: string | null; subscription_status: string | null }>(
      `SELECT stripe_subscription_id, subscription_status FROM tenants WHERE id=$1`,
      [tenantId]
    ),
    pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM voice_sessions
         WHERE tenant_id=$1 AND channel='voice_inbound' AND ended_at IS NOT NULL`,
      [tenantId]
    ),
    // Read new columns from migration 098 directly — SettingsRepository.findByTenant
    // does not yet expose business_hours, job_buffer_minutes, hourly_rate_cents,
    // or onboarding_test_call_skipped_at.
    pool.query<{
      business_hours: unknown | null;
      job_buffer_minutes: number | null;
      hourly_rate_cents: number | null;
      onboarding_test_call_skipped_at: Date | null;
    }>(
      `SELECT business_hours, job_buffer_minutes, hourly_rate_cents, onboarding_test_call_skipped_at
         FROM tenant_settings WHERE tenant_id=$1`,
      [tenantId]
    ),
  ]);

  const tenant = tenantRes.rows[0];
  const ts = tsRes.rows[0];

  return {
    tenantExists: !!tenant,
    identity: {
      businessName: settings?.businessName ?? null,
      businessHours: ts?.business_hours ?? null,
      jobBufferMinutes: ts?.job_buffer_minutes ?? null,
      hourlyRateCents: ts?.hourly_rate_cents ?? null,
    },
    packActivated: (settings?.activeVerticalPacks?.length ?? 0) > 0,
    twilioStatus: integRes.rows[0]?.status ?? null,
    subscription: {
      stripeSubscriptionId: tenant?.stripe_subscription_id ?? null,
      status: normalizeSubscriptionStatus(tenant?.subscription_status),
    },
    inboundCallCount: callsRes.rows[0]?.n ?? 0,
    testCallSkippedAt: ts?.onboarding_test_call_skipped_at ?? null,
  };
}
