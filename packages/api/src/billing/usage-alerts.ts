/**
 * AI-minute usage alerts for paid plans. After each recorded call the
 * owner is emailed when this period's usage first reaches 80% or 100% of
 * the included minutes, and when overage reaches their cap (after which
 * calls ring the owner). Each threshold fires at most once per billing
 * period, recorded in usage_alerts; when one call jumps several thresholds
 * only the highest is emailed and the lower ones are marked sent.
 * Trials are covered by the upgrade nudge instead.
 */
import { recordFunnelEvent } from '../analytics/posthog';
import type { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { AiUsageReader } from './ai-usage';
import { readTenantBillingState } from './tenant-billing-state';

export type UsageAlertThreshold = 'included_80' | 'included_100' | 'cap_reached';

export interface UsageAlertDeps {
  pool: Pool;
  sendEmail?: (input: { to: string; subject: string; text: string }) => Promise<unknown>;
  appBaseUrl: string;
}

class PgUsageAlertLedger extends PgBaseRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  /** Records thresholds for the period; returns those not recorded before. */
  async claim(
    tenantId: string,
    periodStart: Date,
    thresholds: UsageAlertThreshold[],
  ): Promise<UsageAlertThreshold[]> {
    return this.withTenant(tenantId, async (client) => {
      const claimed: UsageAlertThreshold[] = [];
      for (const threshold of thresholds) {
        const res = await client.query(
          `INSERT INTO usage_alerts (tenant_id, period_start, threshold)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, period_start, threshold) DO NOTHING`,
          [tenantId, periodStart, threshold],
        );
        if (res.rowCount) claimed.push(threshold);
      }
      return claimed;
    });
  }
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function checkUsageAlerts(deps: UsageAlertDeps, tenantId: string): Promise<void> {
  const tenant = await readTenantBillingState(deps.pool, tenantId);
  if (tenant?.status !== 'active') return;

  const usage = await new AiUsageReader(deps.pool).getUsage(tenantId);
  if (usage.kind !== 'period') return;

  const reached: UsageAlertThreshold[] = [];
  if (usage.usedMinutes * 100 >= usage.includedMinutes * 80) reached.push('included_80');
  if (usage.usedMinutes >= usage.includedMinutes) reached.push('included_100');
  if (usage.capReached) reached.push('cap_reached');
  if (reached.length === 0) return;

  const claimed = await new PgUsageAlertLedger(deps.pool).claim(tenantId, usage.periodStart, reached);
  for (const threshold of claimed) {
    recordFunnelEvent({
      distinctId: tenant.ownerId ?? tenantId,
      event: 'overage_threshold',
      properties: {
        tenant_id: tenantId,
        threshold,
        plan: usage.planId,
        used_minutes: usage.usedMinutes,
      },
    });
  }
  const highest = claimed[claimed.length - 1];
  const to = tenant.ownerEmail;
  if (!highest || !to || !deps.sendEmail) return;

  const settingsUrl = `${deps.appBaseUrl}/settings`;
  const rate = dollars(usage.overageCentsPerMinute);
  const used = `You've used ${usage.usedMinutes} of the ${usage.includedMinutes} AI answering minutes included this billing period.`;
  const email =
    highest === 'included_80'
      ? {
          subject: "You've used 80% of your AI answering minutes",
          text: `${used} Extra minutes are ${rate} each. Review usage and your overage cap: ${settingsUrl}`,
        }
      : highest === 'included_100'
        ? {
            subject: "You've used all your included AI answering minutes",
            text: `${used} Extra minutes are ${rate} each, up to your overage cap of ${
              usage.capCents === null ? 'no limit' : dollars(usage.capCents)
            } this period. Adjust it here: ${settingsUrl}`,
          }
        : {
            subject: 'Your AI overage cap is reached — calls now ring you',
            text: `This period's extra AI minutes have reached your ${dollars(
              usage.capCents ?? 0,
            )} overage cap, so new calls ring your phone instead of the AI answering. Raise or remove the cap to turn the AI back on: ${settingsUrl}`,
          };
  try {
    await deps.sendEmail({ to, ...email });
  } catch {
    // The threshold stays recorded; a failed email is not retried.
  }
}
