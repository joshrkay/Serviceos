import type { Pool } from 'pg';

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
 * §10 onboarding — checks whether a tenant has crossed the 30-minute
 * trial usage threshold and, if so, records the prompt timestamp +
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

  const tenantRes = await pool.query<{ subscription_status: string | null; owner_email: string | null }>(
    `SELECT subscription_status, owner_email FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const tenant = tenantRes.rows[0];
  if (!tenant || tenant.subscription_status !== 'trialing') return { fired: false };

  const settingsRes = await pool.query<{ onboarding_upgrade_prompt_shown_at: Date | null }>(
    `SELECT onboarding_upgrade_prompt_shown_at FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  if (settingsRes.rows[0]?.onboarding_upgrade_prompt_shown_at) return { fired: false };

  const usageRes = await pool.query<{ mins: number }>(
    `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60), 0)::int AS mins
       FROM voice_sessions
       WHERE tenant_id = $1 AND channel = 'voice_inbound' AND ended_at IS NOT NULL`,
    [tenantId],
  );
  const mins = usageRes.rows[0]?.mins ?? 0;
  if (mins < UPGRADE_THRESHOLD_MINUTES) return { fired: false };

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

  if (deps.sendEmail && tenant.owner_email) {
    try {
      const webUrl = deps.webUrl ?? process.env.WEB_URL ?? '';
      await deps.sendEmail({
        to: tenant.owner_email,
        subject: "Your AI agent is earning — lock in your subscription",
        text:
          `You've used ${UPGRADE_THRESHOLD_MINUTES} minutes of trial voice. ` +
          `Convert now to remove caps and bill today: ${webUrl}/onboarding?action=upgrade-now`,
      });
    } catch {
      // Email failure does not roll back the timestamp; we still fired.
    }
  }

  return { fired: true };
}
