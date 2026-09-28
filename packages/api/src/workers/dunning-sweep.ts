/**
 * Payment-failure dunning sweep — chases the owner after a card is declined
 * at trial end / renewal (invoice.payment_failed), before the 7-day grace
 * window stamped on tenants.past_due_grace_until lapses and the voice gate
 * starts hard-blocking to voicemail (billing resilience, Part A).
 *
 * Sends at three windows, each its own at-most-once ledger kind, keyed off
 * hours since the failed charge (failure time = grace_until − 7 days):
 *   - dunning_0d : day of the failure (0h  < elapsed ≤ 12h)
 *   - dunning_3d : ~3 days out       (60h < elapsed ≤ 84h)
 *   - dunning_7d : last day of grace (156h < elapsed ≤ 168h)
 * The gaps between windows intentionally send nothing; an hourly sweep lands a
 * tenant in exactly one window per period and the per-(tenant,kind) ledger
 * makes each fire once. Mirrors the trial-reminder sweep shape (same
 * sendLifecycleEmail at-most-once gate, same result counters).
 *
 * Only past_due tenants with an unexpired grace are candidates — a recovered
 * card (subscription back to active/trialing) clears the grace column in the
 * subscription webhook, which drops the tenant out of the sweep naturally.
 */
import type { Pool } from 'pg';
import type { Logger } from '../logging/logger';
import type { MessageDeliveryProvider } from '../notifications/delivery-provider';
import type { SettingsRepository } from '../settings/settings';
import { AuditRepository } from '../audit/audit';
import { renderPaymentFailedEmail } from '../notifications/templates';
import {
  sendLifecycleEmail,
  type LifecycleEmailKind,
} from '../notifications/lifecycle-email';

const HOUR_MS = 60 * 60 * 1000;

/** Grace window stamped by invoice.payment_failed, in hours. */
export const DUNNING_GRACE_HOURS = 7 * 24;

export interface DunningSweepDeps {
  pool: Pool | null;
  settingsRepo: SettingsRepository;
  delivery: MessageDeliveryProvider | null;
  auditRepo?: AuditRepository;
  appBaseUrl: string;
  supportEmail: string;
  logger: Logger;
  now?: () => Date;
}

export interface DunningSweepResult {
  candidates: number;
  sent: number;
  /** In a between-window gap, already sent for the active window, or no email. */
  skipped: number;
  failed: number;
}

interface CandidateRow {
  tenant_id: string;
  owner_email: string | null;
  past_due_grace_until: Date;
}

/** Only past-due tenants with an unexpired grace are candidates. */
const ELIGIBLE_SQL = `
  SELECT id AS tenant_id, owner_email, past_due_grace_until
    FROM tenants
   WHERE subscription_status = 'past_due'
     AND past_due_grace_until IS NOT NULL
     AND past_due_grace_until > $1
     AND past_due_grace_until <= $2
   ORDER BY past_due_grace_until ASC
   LIMIT 500
`;

export type DunningDay = 0 | 3 | 7;

/** Maps hours-since-failure to a dunning window, or null in a gap. */
export function dunningWindow(
  hoursSinceFailure: number,
): { kind: LifecycleEmailKind; dunningDay: DunningDay } | null {
  if (hoursSinceFailure > 0 && hoursSinceFailure <= 12) {
    return { kind: 'dunning_0d', dunningDay: 0 };
  }
  if (hoursSinceFailure > 60 && hoursSinceFailure <= 84) {
    return { kind: 'dunning_3d', dunningDay: 3 };
  }
  if (hoursSinceFailure > 156 && hoursSinceFailure <= DUNNING_GRACE_HOURS) {
    return { kind: 'dunning_7d', dunningDay: 7 };
  }
  return null;
}

export async function runDunningSweep(deps: DunningSweepDeps): Promise<DunningSweepResult> {
  const result: DunningSweepResult = {
    candidates: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  };
  if (!deps.pool) return result;

  const now = deps.now ?? (() => new Date());
  const asOf = now();
  // Any grace expiring within the next 7 days can hold a candidate; the
  // window mapping below narrows it to the three send slots.
  const horizon = new Date(asOf.getTime() + DUNNING_GRACE_HOURS * HOUR_MS);

  let rows: CandidateRow[];
  try {
    const res = await deps.pool.query<CandidateRow>(ELIGIBLE_SQL, [asOf, horizon]);
    rows = res.rows;
  } catch (err) {
    deps.logger.error('Dunning sweep: eligibility query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  result.candidates = rows.length;

  for (const row of rows) {
    try {
      const graceUntil = new Date(row.past_due_grace_until).getTime();
      const failedAt = graceUntil - DUNNING_GRACE_HOURS * HOUR_MS;
      const hoursSinceFailure = (asOf.getTime() - failedAt) / HOUR_MS;
      const window = dunningWindow(hoursSinceFailure);
      if (!window || !row.owner_email) {
        result.skipped++;
        continue;
      }

      const businessName = await deps.settingsRepo
        .findByTenant(row.tenant_id)
        .then((s) => s?.businessName ?? undefined)
        .catch(() => undefined);

      const rendered = renderPaymentFailedEmail({
        businessName,
        appBaseUrl: deps.appBaseUrl,
        supportEmail: deps.supportEmail,
        dunningDay: window.dunningDay,
      });

      const outcome = await sendLifecycleEmail(
        { pool: deps.pool, delivery: deps.delivery, auditRepo: deps.auditRepo, logger: deps.logger },
        { tenantId: row.tenant_id, kind: window.kind, to: row.owner_email, rendered },
      );
      if (outcome === 'sent') result.sent++;
      else result.skipped++;
    } catch (err) {
      result.failed++;
      deps.logger.warn('Dunning sweep: tenant failed', {
        tenantId: row.tenant_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
