import type { Pool } from 'pg';
import type { SettingsRepository } from '../settings/settings';
import type { OnboardingFacts } from './derive-status';
import { currentTenantContext } from '../middleware/tenant-context';

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
  // Prefer the request-scoped, GUC-bound client so these reads against
  // FORCE-RLS tables (tenant_settings, tenant_integrations) run under the
  // tenant's RLS policy. Falls back to the raw pool for callers without a
  // tenant transaction (e.g. tests, background contexts).
  const db = currentTenantContext()?.client ?? pool;

  const [settings, integRes, tenantRes, callsRes, tsRes, packsRes] = await Promise.all([
    settingsRepo.findByTenant(tenantId),
    db.query<{ status: string; phone_e164: string | null }>(
      `SELECT status, (provider_data->>'phoneE164') AS phone_e164
         FROM tenant_integrations WHERE tenant_id=$1 AND provider='twilio' LIMIT 1`,
      [tenantId]
    ),
    db.query<{ stripe_subscription_id: string | null; subscription_status: string | null; created_at: Date | null }>(
      `SELECT stripe_subscription_id, subscription_status, created_at FROM tenants WHERE id=$1`,
      [tenantId]
    ),
    db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM voice_sessions
         WHERE tenant_id=$1 AND channel='voice_inbound' AND ended_at IS NOT NULL`,
      [tenantId]
    ),
    // Read new columns from migration 098 directly — SettingsRepository.findByTenant
    // does not yet expose business_hours, job_buffer_minutes, hourly_rate_cents,
    // or onboarding_test_call_skipped_at.
    db.query<{
      business_hours: unknown | null;
      job_buffer_minutes: number | null;
      hourly_rate_cents: number | null;
      onboarding_test_call_skipped_at: Date | null;
      onboarding_upgrade_prompt_shown_at: Date | null;
      voice_agent_live_at: Date | null;
      activated_at: Date | null;
      ai_model: string | null;
      ai_verification_status: string | null;
      ai_verification_error: string | null;
    }>(
      `SELECT business_hours, job_buffer_minutes, hourly_rate_cents,
              onboarding_test_call_skipped_at, onboarding_upgrade_prompt_shown_at,
              voice_agent_live_at, activated_at,
              ai_model, ai_verification_status, ai_verification_error
         FROM tenant_settings WHERE tenant_id=$1`,
      [tenantId]
    ),
    db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pack_activations
         WHERE tenant_id=$1 AND status='active'`,
      [tenantId]
    ),
  ]);

  const tenant = tenantRes.rows[0];
  const ts = tsRes.rows[0];
  const activePackCount = packsRes.rows[0]?.n ?? 0;
  const settingsPacks = settings?.activeVerticalPacks?.length ?? 0;

  return {
    tenantId,
    tenantExists: !!tenant,
    tenantCreatedAt: tenant?.created_at ?? null,
    identity: {
      businessName: settings?.businessName ?? null,
      businessHours: ts?.business_hours ?? null,
      jobBufferMinutes: ts?.job_buffer_minutes ?? null,
      hourlyRateCents: ts?.hourly_rate_cents ?? null,
    },
    packActivated: activePackCount > 0 || settingsPacks > 0,
    twilioStatus: integRes.rows[0]?.status ?? null,
    twilioPhoneNumber: integRes.rows[0]?.phone_e164 ?? null,
    subscription: {
      stripeSubscriptionId: tenant?.stripe_subscription_id ?? null,
      status: normalizeSubscriptionStatus(tenant?.subscription_status),
    },
    inboundCallCount: callsRes.rows[0]?.n ?? 0,
    testCallSkippedAt: ts?.onboarding_test_call_skipped_at ?? null,
    upgradePromptShownAt: ts?.onboarding_upgrade_prompt_shown_at ?? null,
    voiceAgentLiveAt: ts?.voice_agent_live_at ?? null,
    activatedAt: ts?.activated_at ?? null,
    aiConfigPresent: !!ts?.ai_model,
    aiVerificationStatus: (ts?.ai_verification_status as OnboardingFacts['aiVerificationStatus']) ?? null,
    aiVerificationError: ts?.ai_verification_error ?? null,
  };
}
