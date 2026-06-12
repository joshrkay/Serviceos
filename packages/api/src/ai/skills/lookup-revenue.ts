/**
 * `lookup_revenue` voice skill — owner asks how the business is doing
 * this month ("how much have we brought in?").
 *
 * Tenant-scoped, read-only. Reads the money dashboard for the current
 * month and speaks net revenue + outstanding receivables. Bypasses the
 * proposals pipeline.
 */
import type { MoneyDashboardRepository } from '../../reports/money-dashboard';
import type { LookupEventService } from '../../lookup-events/lookup-event-service';
import { formatCents } from './spoken-format';

export interface LookupRevenueInput {
  tenantId: string;
  sessionId?: string;
  /** Defaults to now — pinned by tests for determinism. */
  now?: Date;
}

export interface LookupRevenueDeps {
  moneyDashboardRepo: MoneyDashboardRepository;
  lookupEvents?: LookupEventService;
}

export type LookupRevenueResult =
  | {
      status: 'found';
      summary: string;
      data: { revenueCents: number; outstandingCents: number; month: string };
    }
  | { status: 'error'; summary: string; data: { error: string } };

function currentMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function lookupRevenue(
  input: LookupRevenueInput,
  deps: LookupRevenueDeps,
): Promise<LookupRevenueResult> {
  const start = Date.now();
  const now = input.now ?? new Date();
  const month = currentMonth(now);
  try {
    const summaryData = await deps.moneyDashboardRepo.query(input.tenantId, month, now);
    // Phrase the all-zero case in words (no "$") so it reads naturally —
    // "you haven't brought in any revenue yet" — rather than "$0.00".
    const revenuePhrase =
      summaryData.revenueCents > 0
        ? `you've brought in ${formatCents(summaryData.revenueCents)} this month`
        : `you haven't brought in any revenue yet this month`;
    const outstandingPhrase =
      summaryData.outstandingCents > 0
        ? `with ${formatCents(summaryData.outstandingCents)} still outstanding`
        : `and nothing is outstanding right now`;
    const summary = `${revenuePhrase.charAt(0).toUpperCase()}${revenuePhrase.slice(1)}, ${outstandingPhrase}.`;
    if (deps.lookupEvents) {
      await deps.lookupEvents
        .record({
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          intent: 'lookup_revenue',
          resultStatus: 'found',
          resultCount: 1,
          summary,
          latencyMs: Date.now() - start,
        })
        .catch(() => undefined);
    }
    return {
      status: 'found',
      summary,
      data: {
        revenueCents: summaryData.revenueCents,
        outstandingCents: summaryData.outstandingCents,
        month,
      },
    };
  } catch (err) {
    return {
      status: 'error',
      summary: "I'm having trouble pulling up the revenue numbers right now.",
      data: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}
