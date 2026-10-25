import type { Pool, PoolClient } from 'pg';
import type { SettingsRepository } from '../settings/settings';
import type { DraftProposalsFact, OnboardingFacts } from './derive-status';
import { withTenantClient } from '../db/tenant-transaction';
import { toPhoneLineView, type TwilioIntegrationRow } from './phone-line';
import { classifyProvisioningFailure } from './provisioning-failure';
import { effectiveBufferMinutes } from '../scheduling/booking-availability';

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
  // The repository read first: inside a request it rides the request client;
  // off-request it is a short session of its own, closed before the one below
  // opens, so no two connections are held at once.
  const settings = await settingsRepo.findByTenant(tenantId);
  // The raw reads run under the tenant's context (rls_app_runtime, raw-pg
  // audit 2026-10-23 §4 P1.11): on the request's client inside GET
  // /api/onboarding/status and POST /api/onboarding/test-call/skip, and
  // otherwise — the setup-reminder sweep and scripts/provision-tenant.ts —
  // in ONE tenant session of their own.
  const { integRes, tenantRes, callsRes, tsRes, packsRes, draftRow, draftProposals } = await withTenantClient(
    pool,
    tenantId,
    (db) => readFactRows(db, tenantId),
  );

  const tenant = tenantRes.rows[0];
  const ts = tsRes.rows[0];
  const activePackCount = packsRes.rows[0]?.n ?? 0;
  const settingsPacks = settings?.activeVerticalPacks?.length ?? 0;

  const twilioRow = integRes.rows[0];
  const twilioLine = toPhoneLineView(twilioRow);
  return {
    tenantId,
    tenantExists: !!tenant,
    tenantCreatedAt: tenant?.created_at ?? null,
    identity: {
      businessName: settings?.businessName ?? null,
      businessHours: ts?.business_hours ?? null,
      // #1158 — NULL now means "buffer not configured" (migration 277), not
      // "identity incomplete": a settings row always has an effective buffer
      // (the 30-minute default), exactly as when the column defaulted to 30.
      jobBufferMinutes: ts ? effectiveBufferMinutes(ts.job_buffer_minutes) : null,
      hourlyRateCents: ts?.hourly_rate_cents ?? null,
      // Read from tenant_settings directly (like the other migration-098
      // columns above) rather than the repo mapper, which folds NULL into
      // `undefined` and loses the "never chosen" distinction.
      timezone: ts?.timezone ?? null,
    },
    packActivated: activePackCount > 0 || settingsPacks > 0,
    draft: draftRow
      ? {
          status: draftRow.status,
          choicesAnswered: draftRow.n,
          version: draftRow.version,
          ...(draftProposals ? { proposals: draftProposals } : {}),
        }
      : null,
    twilioStatus: integRes.rows[0]?.status ?? null,
    twilioPhoneNumber: twilioLine.phoneNumber,
    twilioLineState: integRes.rows[0] ? twilioLine.state : null,
    twilioPendingNumber: twilioLine.pendingNumber,
    // The status carries the code, never the recorded text.
    twilioFailureCode: twilioRow?.status === 'failed' ? classifyProvisioningFailure(twilioRow.last_error) : null,
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
    aiVerificationSkippedAt: ts?.ai_verification_skipped_at ?? null,
  };
}

/**
 * The fact reads, on a client already scoped to the tenant (the request's, or
 * a session's). One after another: a pg client runs one query at a time
 * anyway, so this costs nothing over handing it a Promise.all, which pg 8
 * deprecates (a query issued while another is in flight on the same client).
 */
async function readFactRows(db: PoolClient, tenantId: string) {
  const integRes = await db.query<TwilioIntegrationRow>(
    `SELECT status, last_error, provider_data
       FROM tenant_integrations WHERE tenant_id=$1 AND provider='twilio' LIMIT 1`,
    [tenantId]
  );
  const tenantRes = await db.query<{ stripe_subscription_id: string | null; subscription_status: string | null; created_at: Date | null }>(
    `SELECT stripe_subscription_id, subscription_status, created_at FROM tenants WHERE id=$1`,
    [tenantId]
  );
  const callsRes = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM voice_sessions
       WHERE tenant_id=$1 AND channel='voice_inbound' AND ended_at IS NOT NULL`,
    [tenantId]
  );
  // Read new columns from migration 098 directly — SettingsRepository.findByTenant
  // does not yet expose business_hours, job_buffer_minutes, hourly_rate_cents,
  // or onboarding_test_call_skipped_at.
  const tsRes = await db.query<{
    business_hours: unknown | null;
    job_buffer_minutes: number | null;
    hourly_rate_cents: number | null;
    timezone: string | null;
    onboarding_test_call_skipped_at: Date | null;
    onboarding_upgrade_prompt_shown_at: Date | null;
    voice_agent_live_at: Date | null;
    activated_at: Date | null;
    ai_model: string | null;
    ai_verification_status: string | null;
    ai_verification_error: string | null;
    ai_verification_skipped_at: Date | null;
  }>(
    `SELECT business_hours, job_buffer_minutes, hourly_rate_cents, timezone,
            onboarding_test_call_skipped_at, onboarding_upgrade_prompt_shown_at,
            voice_agent_live_at, activated_at,
            ai_model, ai_verification_status, ai_verification_error,
            ai_verification_skipped_at
       FROM tenant_settings WHERE tenant_id=$1`,
    [tenantId]
  );
  const packsRes = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pack_activations
       WHERE tenant_id=$1 AND status='active'`,
    [tenantId]
  );
  // "Pick, don't build" (migration 311) — one draft per tenant, or none.
  const draftRes = await db.query<{ status: 'draft' | 'approved'; version: number; n: number; expected: number }>(
    `SELECT status, version, (SELECT COUNT(*)::int FROM jsonb_object_keys(choices)) AS n,
            jsonb_array_length(proposal_ids)::int AS expected
       FROM onboarding_drafts WHERE tenant_id=$1`,
    [tenantId]
  );
  const draftRow = draftRes.rows[0];

  // Execution state of an approved draft: the status of each proposal it lists.
  // One extra query, and only once the draft is approved, so the polled status
  // endpoint stays cheap for every tenant that is still choosing (or has no draft).
  // `approved_at` rides beside the status so the undo-window hints (undoable,
  // recovery) can be derived; neither ever leaves the server raw.
  let draftProposals: DraftProposalsFact | undefined;
  if (draftRow?.status === 'approved' && draftRow.expected > 0) {
    const proposalsRes = await db.query<{ status: string; approved_at: Date | null }>(
      `SELECT p.status, p.approved_at FROM proposals p
         WHERE p.tenant_id=$1
           AND p.id IN (SELECT jsonb_array_elements_text(d.proposal_ids)::uuid
                          FROM onboarding_drafts d WHERE d.tenant_id=$1)`,
      [tenantId]
    );
    draftProposals = {
      expected: draftRow.expected,
      members: proposalsRes.rows.map((r) => ({ status: r.status, approvedAt: r.approved_at })),
    };
  }
  return { integRes, tenantRes, callsRes, tsRes, packsRes, draftRow, draftProposals };
}
