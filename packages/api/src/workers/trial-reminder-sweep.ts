/**
 * Trial-ending reminder sweep — warns the owner before the 14-day trial
 * converts to a paid subscription (GTM risk #5: "trial expires silently and
 * the operator's AI goes dark").
 *
 * Reads tenants.trial_ends_at (mirrored from Stripe by the subscription
 * webhook) and sends at three windows, each its own at-most-once ledger kind:
 *   - trial_3d : ~3 days out (48h < remaining ≤ 72h)
 *   - trial_1d : ~1 day out  (12h < remaining ≤ 24h)
 *   - trial_0d : day-of      (0h  < remaining ≤ 12h)
 * The gaps between windows intentionally send nothing; an hourly sweep lands a
 * tenant in exactly one window per period and the per-(tenant,kind) ledger
 * makes each fire once. Mirrors the thank-you-sms sweep shape.
 */
import type { Pool } from 'pg';
import type { Logger } from '../logging/logger';
import type { MessageDeliveryProvider } from '../notifications/delivery-provider';
import type { SettingsRepository } from '../settings/settings';
import { AuditRepository } from '../audit/audit';
import { renderTrialEndingEmail } from '../notifications/templates';
import {
  sendLifecycleEmail,
  type LifecycleEmailKind,
} from '../notifications/lifecycle-email';

const HOUR_MS = 60 * 60 * 1000;

export interface TrialReminderSweepDeps {
  pool: Pool | null;
  settingsRepo: SettingsRepository;
  delivery: MessageDeliveryProvider | null;
  auditRepo?: AuditRepository;
  appBaseUrl: string;
  supportEmail: string;
  logger: Logger;
  now?: () => Date;
}

export interface TrialReminderSweepResult {
  candidates: number;
  sent: number;
  /** In a between-window gap, or already sent for the active window. */
  skipped: number;
  failed: number;
}

interface CandidateRow {
  tenant_id: string;
  owner_email: string | null;
  trial_ends_at: Date;
}

/** Only trialing tenants whose trial ends within the next 72h are candidates. */
const ELIGIBLE_SQL = `
  SELECT id AS tenant_id, owner_email, trial_ends_at
    FROM tenants
   WHERE subscription_status = 'trialing'
     AND trial_ends_at IS NOT NULL
     AND trial_ends_at > $1
     AND trial_ends_at <= $2
   ORDER BY trial_ends_at ASC
   LIMIT 500
`;

/** Maps hours-remaining to a window, or null when in a between-window gap. */
export function trialWindow(
  hoursLeft: number,
): { kind: LifecycleEmailKind; daysLeft: 0 | 1 | 3 } | null {
  if (hoursLeft > 48 && hoursLeft <= 72) return { kind: 'trial_3d', daysLeft: 3 };
  if (hoursLeft > 12 && hoursLeft <= 24) return { kind: 'trial_1d', daysLeft: 1 };
  if (hoursLeft > 0 && hoursLeft <= 12) return { kind: 'trial_0d', daysLeft: 0 };
  return null;
}

export async function runTrialReminderSweep(
  deps: TrialReminderSweepDeps,
): Promise<TrialReminderSweepResult> {
  const result: TrialReminderSweepResult = {
    candidates: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  };
  if (!deps.pool) return result;

  const now = deps.now ?? (() => new Date());
  const asOf = now();
  const horizon = new Date(asOf.getTime() + 72 * HOUR_MS);

  let rows: CandidateRow[];
  try {
    const res = await deps.pool.query<CandidateRow>(ELIGIBLE_SQL, [asOf, horizon]);
    rows = res.rows;
  } catch (err) {
    deps.logger.error('Trial-reminder sweep: eligibility query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  result.candidates = rows.length;

  for (const row of rows) {
    try {
      const hoursLeft = (new Date(row.trial_ends_at).getTime() - asOf.getTime()) / HOUR_MS;
      const window = trialWindow(hoursLeft);
      if (!window || !row.owner_email) {
        result.skipped++;
        continue;
      }

      const businessName = await deps.settingsRepo
        .findByTenant(row.tenant_id)
        .then((s) => s?.businessName ?? undefined)
        .catch(() => undefined);

      const rendered = renderTrialEndingEmail({
        businessName,
        appBaseUrl: deps.appBaseUrl,
        supportEmail: deps.supportEmail,
        daysLeft: window.daysLeft,
      });

      const outcome = await sendLifecycleEmail(
        { pool: deps.pool, delivery: deps.delivery, auditRepo: deps.auditRepo, logger: deps.logger },
        { tenantId: row.tenant_id, kind: window.kind, to: row.owner_email, rendered },
      );
      if (outcome === 'sent') result.sent++;
      else result.skipped++;
    } catch (err) {
      result.failed++;
      deps.logger.warn('Trial-reminder sweep: tenant failed', {
        tenantId: row.tenant_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
