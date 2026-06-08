import type { Pool } from 'pg';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import { recordFunnelEvent } from '../analytics/posthog';
import type { SendEmailFn } from './check-upgrade-nudge';

/**
 * Activation milestone — `first_real_call_received`.
 *
 * Fired exactly once per tenant, the first time the tenant's voice agent
 * handles a "real" inbound call (a customer call, as opposed to the
 * onboarding test call). This is THE activation event for the launch
 * funnel: it marks the moment the product delivered its core promise.
 *
 * ## Why a count-based rule (not caller identity)
 * The `onSessionEnded` hook receives only `{ tenantId, channel }`, and
 * `voice_sessions` does not persist the caller's number, so we cannot ask
 * "is this caller the owner's verified phone?" at this hook without new
 * plumbing (threading the `From` through the telephony adapter + a new
 * column). Instead we use a count-based heuristic that matches the product
 * flow: the onboarding test call is the FIRST inbound call (it's what trips
 * `maybeAutoGoLiveOnInboundEnd` and sets `voice_agent_live_at`), so the
 * first REAL call is the next one.
 *
 *   threshold = test call was skipped ? 1 : 2
 *   activation fires when inboundCallCount >= threshold
 *
 * - Test call made (not skipped): call #1 = test (count 1, below threshold
 *   2 → no fire), call #2 = first real (count 2 → fire).
 * - Test call skipped: the first real inbound call (count 1 ≥ threshold 1)
 *   fires immediately.
 *
 * The identity-based variant is deferred (see BLOCKED.md). Documented in
 * FUNNEL.md / DECISIONS.md.
 *
 * ## Idempotency
 * `tenant_settings.activated_at` (migration 146) is the once-per-tenant
 * guard. We stamp it with a check-and-set UPDATE; a second concurrent or
 * replayed call observes `rowCount === 0` and no-ops — so the funnel event
 * and the activation email fire exactly once, forever.
 *
 * Safe to call after every inbound-call end: it's a short read-only path
 * until the threshold is actually crossed and `activated_at` is still NULL.
 */

const VOICE_INBOUND_CHANNEL = 'voice_inbound';

export interface MaybeFireFirstRealCallActivationDeps {
  pool: Pool;
  auditRepo: AuditRepository;
  /** Optional — when set, the activation email is sent to the tenant owner.
   * When unset, the milestone + funnel event still fire; only the email is
   * skipped (mirrors the upgrade-nudge contract). */
  sendEmail?: SendEmailFn;
  /** Override for the web URL embedded in the email CTA. */
  webUrl?: string;
}

interface TenantRow {
  owner_id: string | null;
  owner_email: string | null;
  subscription_status: string | null;
}

interface SettingsRow {
  voice_agent_live_at: Date | null;
  activated_at: Date | null;
  onboarding_test_call_skipped_at: Date | null;
}

export async function maybeFireFirstRealCallActivation(
  deps: MaybeFireFirstRealCallActivationDeps,
  input: { tenantId: string; channel: string },
): Promise<{ fired: boolean }> {
  const { pool } = deps;
  const { tenantId, channel } = input;

  // Only inbound voice calls can be a "first real call". In-app voice
  // (operator testing from the dashboard) never counts.
  if (channel !== VOICE_INBOUND_CHANNEL) return { fired: false };

  const tenantRes = await pool.query<TenantRow>(
    `SELECT owner_id, owner_email, subscription_status FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const tenant = tenantRes.rows[0];
  if (!tenant) return { fired: false };

  // Subscription must be live (trial counts — activation can happen during
  // the trial; that's the point of the funnel). Same bar as go-live.
  if (tenant.subscription_status !== 'trialing' && tenant.subscription_status !== 'active') {
    return { fired: false };
  }

  const settingsRes = await pool.query<SettingsRow>(
    `SELECT voice_agent_live_at, activated_at, onboarding_test_call_skipped_at
       FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  const settings = settingsRes.rows[0];
  if (!settings) return { fired: false };

  // The agent must be live (a call could only be handled by a live agent),
  // and we must not have already activated.
  if (!settings.voice_agent_live_at) return { fired: false };
  if (settings.activated_at) return { fired: false };

  // Count ended inbound calls — INCLUDES the call that just ended (its
  // ended_at is written before this hook runs, same assumption the upgrade
  // nudge relies on).
  const countRes = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM voice_sessions
       WHERE tenant_id = $1 AND channel = 'voice_inbound' AND ended_at IS NOT NULL`,
    [tenantId],
  );
  const inboundCallCount = countRes.rows[0]?.n ?? 0;

  // Test call skipped → the first real inbound call is call #1. Otherwise
  // call #1 was the onboarding test call, so the first real call is #2.
  const threshold = settings.onboarding_test_call_skipped_at ? 1 : 2;
  if (inboundCallCount < threshold) return { fired: false };

  // Cross the activation line atomically. The WHERE on activated_at makes
  // this a check-and-set: a concurrent or replayed call writes 0 rows and
  // bails, so the event + email fire exactly once.
  const updateRes = await pool.query(
    `UPDATE tenant_settings
        SET activated_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND activated_at IS NULL`,
    [tenantId],
  );
  if ((updateRes.rowCount ?? 0) === 0) return { fired: false };

  const ts = new Date().toISOString();

  // Funnel event. distinctId is the Clerk userId (tenants.owner_id) so the
  // server event stitches to the browser SDK's identify(). Carries the four
  // required funnel fields: tenant_id, user_id, timestamp, source.
  if (tenant.owner_id) {
    recordFunnelEvent({
      distinctId: tenant.owner_id,
      event: 'first_real_call_received',
      properties: {
        tenant_id: tenantId,
        user_id: tenant.owner_id,
        timestamp: ts,
        source: 'server',
        inbound_call_count: inboundCallCount,
      },
    });
  }

  // Audit trail — every mutation emits an audit event (CLAUDE.md mandate).
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId,
      actorId: 'system',
      actorRole: 'system',
      eventType: 'tenant.activated',
      entityType: 'tenant_settings',
      entityId: tenantId,
      metadata: { milestone: 'first_real_call_received', inboundCallCount },
    }),
  );

  // Activation email — best effort. A failure here must NOT roll back the
  // activation (we already stamped activated_at and fired the funnel event);
  // a retry that re-enters this function will no-op on the check-and-set.
  if (deps.sendEmail && tenant.owner_email) {
    try {
      const webUrl = deps.webUrl ?? process.env.WEB_URL ?? '';
      await deps.sendEmail({
        to: tenant.owner_email,
        subject: 'Your AI agent just handled its first real call 🎉',
        text:
          'Great news — your AI agent just answered its first real customer ' +
          'call. That call is captured in your dashboard with a full ' +
          'transcript and any booking it created.\n\n' +
          `See it here: ${webUrl}/dashboard`,
        html:
          '<p>Great news — your AI agent just answered its first real ' +
          'customer call.</p><p>That call is captured in your dashboard with ' +
          'a full transcript and any booking it created.</p>' +
          `<p><a href="${webUrl}/dashboard">Open your dashboard</a></p>`,
      });
    } catch {
      // Email failure does not roll back activation; we still fired.
    }
  }

  return { fired: true };
}
