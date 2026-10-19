/**
 * S6-2 (U7 "Configuration and alerts") — the pure half of the daily budget:
 * which reservation crosses 80 % or fills a cap (integer arithmetic, only the
 * upward crossing pages), and how a crossing becomes an operator page. The
 * reservation statement itself is proven on real Postgres in
 * test/integration/demo-call-budget.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  budgetCrossings,
  pageBudgetCrossings,
  type BudgetRow,
} from '../../src/demo/call-budget';
import { createAlertOperator } from '../../src/monitoring/alert-operator';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

/** The rows a run of successful reservations returns, one per reservation. */
function rowsFor(n: number, caps: { callsCap: number; costCapCents: number; unit: number }): BudgetRow[] {
  return Array.from({ length: n }, (_, i) => ({
    callsReserved: i + 1,
    callsCap: caps.callsCap,
    estCostCents: (i + 1) * caps.unit,
    costCapCents: caps.costCapCents,
  }));
}

function crossingsByReservation(rows: BudgetRow[], unit: number): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  rows.forEach((row, i) => {
    const c = budgetCrossings(row, unit);
    if (c.length > 0) out[i + 1] = c.map((x) => x.rule);
  });
  return out;
}

describe('budgetCrossings — the reservation that crosses a threshold, and only that one', () => {
  it('a calls cap of 50: the 40th reservation crosses 80 %, the 50th fills it', () => {
    const rows = rowsFor(50, { callsCap: 50, costCapCents: 2500, unit: 50 });
    expect(crossingsByReservation(rows, 50)).toEqual({
      40: ['demo_budget_calls_80pct', 'demo_budget_cost_80pct'],
      50: ['demo_budget_calls_full', 'demo_budget_cost_full'],
    });
  });

  it('a calls cap of 7 with cost room: the 6th crosses 80 %, the 7th fills it, nothing else pages', () => {
    const rows = rowsFor(7, { callsCap: 7, costCapCents: 2500, unit: 50 });
    expect(crossingsByReservation(rows, 50)).toEqual({
      6: ['demo_budget_calls_80pct'],
      7: ['demo_budget_calls_full'],
    });
  });

  it('a cost cap of 175 at 50 a call binds first: the 3rd reservation crosses 80 % and fills it', () => {
    const rows = rowsFor(3, { callsCap: 1000, costCapCents: 175, unit: 50 });
    expect(crossingsByReservation(rows, 50)).toEqual({
      3: ['demo_budget_cost_80pct', 'demo_budget_cost_full'],
    });
  });

  it('a cap of 1: the one reservation is both the 80 % crossing and the fill', () => {
    const rows = rowsFor(1, { callsCap: 1, costCapCents: 2500, unit: 50 });
    expect(crossingsByReservation(rows, 50)).toEqual({
      1: ['demo_budget_calls_80pct', 'demo_budget_calls_full'],
    });
  });

  it('carries the cap, the level and the row it was computed on', () => {
    const row: BudgetRow = { callsReserved: 6, callsCap: 7, estCostCents: 300, costCapCents: 2500 };
    expect(budgetCrossings(row, 50)).toEqual([
      { cap: 'calls', level: '80pct', rule: 'demo_budget_calls_80pct', row },
    ]);
  });
});

describe('pageBudgetCrossings — one operator page per crossing, through the alert seam', () => {
  function sentryRecorder() {
    const messages: string[] = [];
    return {
      messages,
      sentry: {
        captureMessage: (m: string) => {
          messages.push(m);
        },
      } as unknown as Parameters<typeof createAlertOperator>[0]['sentry'],
    };
  }

  it('pages the 80 % and the full crossings separately (distinct rules, so the cooldown keeps both)', async () => {
    const rec = sentryRecorder();
    const alert = createAlertOperator({ sentry: rec.sentry, delivery: null, cooldownMs: 60 * 60_000, logger });
    const row6: BudgetRow = { callsReserved: 6, callsCap: 7, estCostCents: 300, costCapCents: 2500 };
    const row7: BudgetRow = { callsReserved: 7, callsCap: 7, estCostCents: 350, costCapCents: 2500 };
    await pageBudgetCrossings(alert, budgetCrossings(row6, 50));
    await pageBudgetCrossings(alert, budgetCrossings(row7, 50));
    expect(rec.messages).toHaveLength(2);
    expect(rec.messages[0]).toMatch(/demo_budget_calls_80pct/);
    expect(rec.messages[0]).toMatch(/calls_reserved=6/);
    expect(rec.messages[1]).toMatch(/demo_budget_calls_full/);
    expect(rec.messages[1]).toMatch(/\[SLO:critical\]/);
  });

  it('pages nobody when there is no crossing', async () => {
    const alert = vi.fn(async () => undefined);
    await pageBudgetCrossings(alert, []);
    expect(alert).not.toHaveBeenCalled();
  });
});
