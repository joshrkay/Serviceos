import type { Pool } from 'pg';
import { recordFunnelEvent } from '../analytics/posthog';
import { PgCallUsageRepository } from '../billing/call-usage-events';
import { TRIAL_MINUTE_LIMITS } from './trial-limits';
import { readTenantBillingState } from '../billing/tenant-billing-state';
import { loadConfig } from '../shared/config';

/**
 * Cumulative trial minutes at which we surface the early-upgrade nudge.
 * Hits at 30% of the trial AI-minute budget — high enough to mean the
 * agent has handled real calls, low enough to fire well before the
 * 100-minute trial cap.
 */
const UPGRADE_THRESHOLD_MINUTES = 30;

export type SendEmailFn = (input: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}) => Promise<unknown>;

export interface CheckAndFireUpgradeNudgeDeps {
  pool: Pool;
  /** Optional — when unset, the timestamp is still recorded so the banner
   * fires, but no email is sent. Wire to your notification provider for
   * the email channel. */
  sendEmail?: SendEmailFn;
  /** Override for the web URL embedded in the email CTA. */
  webUrl?: string;
}

/**
 * §10 onboarding — checks whether a trialing tenant has crossed 40 billable
 * AI minutes (of the 60-minute trial) and, if so, records the prompt timestamp +
 * optionally sends a one-time email. Idempotent: a second call with the
 * prompt timestamp already set is a no-op.
 *
 * Designed to be safe to call after every inbound-call end — short
 * read-only path until the threshold is actually crossed.
 */
export async function checkAndFireUpgradeNudge(
  deps: CheckAndFireUpgradeNudgeDeps,
  tenantId: string,
): Promise<{ fired: boolean }> {
  const { pool } = deps;

  const tenant = await readTenantBillingState(pool, tenantId);
  if (!tenant || tenant.status !== 'trialing') return { fired: false };

  const settingsRes = await pool.query<{ onboarding_upgrade_prompt_shown_at: Date | null }>(
    `SELECT onboarding_upgrade_prompt_shown_at FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  if (settingsRes.rows[0]?.onboarding_upgrade_prompt_shown_at) return { fired: false };

  // Billable AI minutes across the trial — the owner's own test calls and
  // in-app voice never count (see call-usage-events classifyCall).
  const billableSeconds = await new PgCallUsageRepository(pool).sumTrialBillableSeconds(tenantId);
  if (billableSeconds < TRIAL_MINUTE_LIMITS.UPGRADE_NUDGE_SECONDS) return { fired: false };

  // Cross the threshold atomically — guard against a second concurrent
  // call also writing the timestamp. The WHERE on the existing column
  // makes this a check-and-set.
  const updateRes = await pool.query(
    `UPDATE tenant_settings
       SET onboarding_upgrade_prompt_shown_at = now()
     WHERE tenant_id = $1 AND onboarding_upgrade_prompt_shown_at IS NULL`,
    [tenantId],
  );
  if ((updateRes.rowCount ?? 0) === 0) return { fired: false };

  recordFunnelEvent({
    distinctId: tenant.ownerId ?? tenantId,
    event: 'trial_minutes_milestone',
    properties: { tenant_id: tenantId, trial_minutes_used: Math.floor(billableSeconds / 60) },
  });

  if (deps.sendEmail && tenant.ownerEmail) {
    try {
      const webUrl = deps.webUrl ?? loadConfig().publicOrigins.web;
      await deps.sendEmail({
        to: tenant.ownerEmail,
        subject: "Your AI agent is earning — lock in your subscription",
        text:
          `You've used ${TRIAL_MINUTE_LIMITS.UPGRADE_NUDGE_SECONDS / 60} of your ` +
          `${TRIAL_MINUTE_LIMITS.TRIAL_TOTAL_SECONDS / 60} trial AI minutes. ` +
          `Convert now to remove caps and bill today: ${webUrl}/onboarding?action=upgrade-now`,
      });
    } catch {
      // Email failure does not roll back the timestamp; we still fired.
    }
  }

  return { fired: true };
}
