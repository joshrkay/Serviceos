/**
 * Weekly HFCR owner summary sweeper.
 *
 * Once a week, for each tenant, summarize the most recently COMPLETED
 * calendar week's Hands-Free Collected Revenue and text the owner a single
 * line: "This week I collected $X hands-free and recovered N calls." No
 * dashboard, no chart — one number + one count (PRD §9).
 *
 * Mirrors the overdue-invoice sweep: a cross-tenant loop with per-tenant
 * try/catch (one tenant's failure never crashes the rest) and a `failed`
 * counter. Idempotency is the hfcr_weekly_sends ledger: we record the
 * (tenant, week) row BEFORE sending, so a re-run — or two app instances —
 * sends exactly one SMS per tenant per week. Weeks with nothing hands-free
 * are skipped (no $0 spam).
 */
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../logging/logger';
import { PaymentRepository } from '../invoices/payment';
import { ProposalRepository } from '../proposals/proposal';
import { AuditRepository } from '../audit/audit';
import { computeHfcrForTenant } from '../metrics/hfcr';
import { HfcrWeeklySendRepository } from '../metrics/hfcr-weekly-send';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface HfcrWeeklySendDeps {
  paymentRepo: PaymentRepository;
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
  hfcrSendRepo: HfcrWeeklySendRepository;
  /** Resolve the tenant's owner phone (E.164), or null when none is set. */
  resolveOwnerPhone: (tenantId: string) => Promise<string | null>;
  /** The owner-SMS seam (the same `{ to, body }` primitive the rest of the app uses). */
  sendSms: (args: { to: string; body: string }) => Promise<unknown>;
  listTenantIds: () => Promise<string[]>;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
}

/** UTC Monday 00:00 of the week containing `d`. */
export function startOfWeekUTC(d: Date): Date {
  const sinceMonday = (d.getUTCDay() + 6) % 7; // Mon→0 … Sun→6
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday),
  );
}

function dateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

function formatMoneyCents(cents: number): string {
  return CURRENCY_FORMATTER.format(cents / 100);
}

export function composeWeeklyHfcrSms(hfcrCents: number, recoveredCallCount: number): string {
  const money = formatMoneyCents(hfcrCents);
  if (recoveredCallCount > 0) {
    const calls = `${recoveredCallCount} ${recoveredCallCount === 1 ? 'call' : 'calls'}`;
    return `This week I collected ${money} hands-free and recovered ${calls} — all without you opening the app.`;
  }
  return `This week I collected ${money} hands-free — all without you opening the app.`;
}

export async function runHfcrWeeklySendSweep(
  deps: HfcrWeeklySendDeps,
): Promise<{ tenants: number; sent: number; failed: number }> {
  const now = (deps.now ?? (() => new Date()))();

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('HFCR weekly send: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, sent: 0, failed: 0 };
  }

  // Summarize the most recently COMPLETED week: [prevMonday, thisMonday).
  const thisMonday = startOfWeekUTC(now);
  const prevMonday = new Date(thisMonday.getTime() - 7 * MS_PER_DAY);
  const period = { from: prevMonday, to: thisMonday };
  const weekStartingDate = dateString(prevMonday);

  let sent = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    try {
      // Idempotency short-circuit: already summarized this week.
      if (await deps.hfcrSendRepo.findByWeek(tenantId, weekStartingDate)) continue;

      const result = await computeHfcrForTenant(tenantId, period, {
        paymentRepo: deps.paymentRepo,
        proposalRepo: deps.proposalRepo,
        auditRepo: deps.auditRepo,
      });

      // Nothing hands-free happened — don't text a $0 summary.
      if (result.hfcrCents <= 0 && result.recoveredCallCount <= 0) continue;

      const ownerPhone = await deps.resolveOwnerPhone(tenantId);
      if (!ownerPhone) continue; // no owner phone configured — can't send

      // Send the summary FIRST, then record it. A transient SMS failure
      // throws here → the per-tenant catch logs it and NO row is written, so
      // the next daily tick retries this week (the deliverable is the SMS; a
      // record-first order would let one failed send silently drop the week).
      // The cross-instance runAsLeader lock + the top-of-loop existence check
      // keep this to one send per week; a duplicate would require the DB write
      // to fail in the narrow window after a successful send.
      await deps.sendSms({
        to: ownerPhone,
        body: composeWeeklyHfcrSms(result.hfcrCents, result.recoveredCallCount),
      });

      try {
        await deps.hfcrSendRepo.create({
          id: uuidv4(),
          tenantId,
          weekStartingDate,
          hfcrCents: result.hfcrCents,
          recoveredCallCount: result.recoveredCallCount,
          sentAt: now,
        });
      } catch (err) {
        // Already recorded (another instance won the week): the SMS went out,
        // so just move on without double-counting.
        if ((err as { code?: string }).code === '23505') continue;
        throw err;
      }
      sent++;
    } catch (err) {
      failed++;
      deps.logger.warn('HFCR weekly send: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info('HFCR weekly send completed', {
    tenants: tenantIds.length,
    sent,
    failed,
  });

  return { tenants: tenantIds.length, sent, failed };
}
