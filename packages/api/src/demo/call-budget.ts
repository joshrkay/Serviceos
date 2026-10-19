/**
 * U7 (S6-2) — the demo call's daily budget and the visitor's allowance
 * return (plan "Daily budget", D11).
 *
 * `demo_call_budget` is a platform table (no tenant_id, no RLS): one row per
 * UTC day holding the calls and estimated cents reserved so far and the caps
 * written when the row was created. `reserve` takes one call and one unit of
 * cents in a single statement, inside the start transaction, before any
 * `Calls` request exists; `releaseNoCall` gives the unit and the visitor's
 * one-call-a-day allowance back, once, for a call that provably never
 * existed. All money is integer cents.
 */
import type { PoolClient } from 'pg';
import type { AlertOperatorFn, OperatorAlert } from '../monitoring/alert-operator';
import { demoCallBudgetRefusalsTotal } from '../monitoring/metrics';
import { utcDayWindowStart } from '../proposals/supervisor/budget-counters-repo';
import { releaseOn } from '../shared/rate-limit/phone-rate-limit';
import { DEMO_PLATFORM_TENANT_ID } from './platform-tenant';
import { writePlatformAudit } from './platform-audit';

/** The visitor's allowance: one demo call per number per trailing 24 h, on the platform tenant. */
export const DEMO_CALL_ALLOWANCE_SCOPE = 'demo_call';
export const DEMO_CALL_ALLOWANCE_LIMIT = 1;
export const DEMO_CALL_ALLOWANCE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const DEMO_BUDGET_ALERT_EVENT = 'demo_budget_alert';
export const DEMO_CALL_BUDGET_RELEASED_EVENT = 'demo_call_budget_released';

/** The day's row as `reserve` returns it. */
export interface BudgetRow {
  callsReserved: number;
  callsCap: number;
  estCostCents: number;
  costCapCents: number;
}

export type BudgetCap = 'calls' | 'cost';
export type BudgetLevel = '80pct' | 'full';

export interface BudgetCrossing {
  cap: BudgetCap;
  level: BudgetLevel;
  /** The operator-alert rule; one per cap and level, so one page never mutes the other. */
  rule: string;
  row: BudgetRow;
}

/** The UTC date (`YYYY-MM-DD`) of `now`: the budget row a reservation lands on. */
export function budgetDayFor(now: Date): string {
  return utcDayWindowStart(now).toISOString().slice(0, 10);
}

const atEighty = (n: number, cap: number) => n * 5 >= cap * 4;

/**
 * Which thresholds this reservation crossed upward. `row` is the row the
 * reservation returned; the counts less this reservation (one call,
 * `unitCents`) are the "before". 80 %: `n * 5 >= cap * 4` (integer
 * arithmetic) after and not before. Full: the calls cap is reached, or the
 * next unit of cents no longer fits under the cost cap, after and not
 * before. Only the reservation that makes the crossing reports it.
 */
export function budgetCrossings(row: BudgetRow, unitCents: number): BudgetCrossing[] {
  const callsBefore = row.callsReserved - 1;
  const costBefore = row.estCostCents - unitCents;
  const out: BudgetCrossing[] = [];
  const add = (cap: BudgetCap, level: BudgetLevel) =>
    out.push({ cap, level, rule: `demo_budget_${cap}_${level}`, row });

  if (atEighty(row.callsReserved, row.callsCap) && !atEighty(callsBefore, row.callsCap)) add('calls', '80pct');
  if (row.callsReserved >= row.callsCap && callsBefore < row.callsCap) add('calls', 'full');
  if (atEighty(row.estCostCents, row.costCapCents) && !atEighty(costBefore, row.costCapCents)) add('cost', '80pct');
  if (
    row.estCostCents + unitCents > row.costCapCents &&
    costBefore + unitCents <= row.costCapCents
  ) {
    add('cost', 'full');
  }
  return out;
}

function toAlert(c: BudgetCrossing): OperatorAlert {
  const what = c.cap === 'calls' ? 'demo calls' : 'demo call cost';
  return {
    severity: c.level === 'full' ? 'critical' : 'warning',
    rule: c.rule,
    summary:
      c.level === 'full'
        ? `${what} reached today's cap; new demo calls answer busy until 00:00 UTC`
        : `${what} passed 80% of today's cap`,
    details: {
      calls_reserved: c.row.callsReserved,
      calls_cap: c.row.callsCap,
      est_cost_cents: c.row.estCostCents,
      cost_cap_cents: c.row.costCapCents,
    },
  };
}

/**
 * Page the operator once per crossing. Called after the start transaction
 * commits, so a reservation that rolled back never pages. The alert seam
 * never throws.
 */
export async function pageBudgetCrossings(
  alert: AlertOperatorFn,
  crossings: readonly BudgetCrossing[],
): Promise<void> {
  for (const c of crossings) {
    await alert(toAlert(c));
  }
}

/**
 * The reservation (plan text, verbatim). One row back: the call is inside
 * both caps and its slot and cents are taken. Zero rows: a cap is reached.
 * The conflict branch's WHERE runs under the row lock DO UPDATE takes, so
 * concurrent reservations serialize on the day's row; the insert branch's
 * own WHERE stops the first reservation of a day slipping past a zero or
 * sub-unit cap. Caps are written only when the day's row is created.
 * $1 day, $2 calls cap, $3 unit cents, $4 cost cap cents.
 */
const RESERVE_SQL = `INSERT INTO demo_call_budget (day, calls_reserved, calls_cap, est_cost_cents, cost_cap_cents)
SELECT $1::date, 1, $2::int, $3::int, $4::int WHERE $2::int >= 1 AND $3::int <= $4::int
ON CONFLICT (day) DO UPDATE SET calls_reserved = demo_call_budget.calls_reserved + 1,
  est_cost_cents = demo_call_budget.est_cost_cents + $3::int
WHERE demo_call_budget.calls_reserved < demo_call_budget.calls_cap
  AND demo_call_budget.est_cost_cents + $3::int <= demo_call_budget.cost_cap_cents
RETURNING calls_reserved, calls_cap, est_cost_cents, cost_cap_cents`;

export interface ReserveInput {
  /** `budgetDayFor(now)` of the request's clock. */
  day: string;
  unitCents: number;
  caps: { callsCap: number; costCapCents: number };
}

export type ReserveResult =
  | { reserved: true; row: BudgetRow; crossings: BudgetCrossing[] }
  | { reserved: false };

/**
 * Take one call and `unitCents` on `day` in the caller's open transaction.
 * A crossing writes its `demo_budget_alert` audit row on the platform tenant
 * in the same transaction (so it rolls back with the reservation); the page
 * itself is the caller's to send after COMMIT (`pageBudgetCrossings`). A
 * refusal only counts (`demo_call_budget_refusals_total`): the reservation
 * that filled the cap already paged.
 */
export async function reserve(client: PoolClient, input: ReserveInput): Promise<ReserveResult> {
  const { rows } = await client.query<{
    calls_reserved: number;
    calls_cap: number;
    est_cost_cents: number;
    cost_cap_cents: number;
  }>(RESERVE_SQL, [input.day, input.caps.callsCap, input.unitCents, input.caps.costCapCents]);
  if (rows.length === 0) {
    demoCallBudgetRefusalsTotal.inc();
    return { reserved: false };
  }
  const row: BudgetRow = {
    callsReserved: rows[0].calls_reserved,
    callsCap: rows[0].calls_cap,
    estCostCents: rows[0].est_cost_cents,
    costCapCents: rows[0].cost_cap_cents,
  };
  const crossings = budgetCrossings(row, input.unitCents);
  for (const c of crossings) {
    await writePlatformAudit(client, {
      eventType: DEMO_BUDGET_ALERT_EVENT,
      entityType: 'demo_call_budget',
      entityId: input.day,
      metadata: { cap: c.cap, level: c.level, rule: c.rule, ...row },
    });
  }
  return { reserved: true, row, crossings };
}

/**
 * The release guard (D11): the call row, while no release has run and no
 * CallSid is bound on it or on its lease. The lease is locked FOR UPDATE, so
 * a concurrent CallSid bind either commits first (the re-check then excludes
 * the row) or waits for this release; the demo_calls row lock makes a
 * concurrent replay wait and then find `budget_released_at` set.
 */
const RELEASE_NO_CALL_SQL = `WITH lease AS (
  SELECT l.id
    FROM demo_tenant_leases l
    JOIN demo_calls c ON c.lease_id = l.id
   WHERE c.id = $1 AND l.call_sid IS NULL
   FOR UPDATE OF l
)
UPDATE demo_calls dc
   SET budget_released_at = now(), allowance_released_at = now(), updated_at = now()
  FROM lease
 WHERE dc.id = $1
   AND dc.lease_id = lease.id
   AND dc.budget_released_at IS NULL
   AND dc.call_sid IS NULL
RETURNING dc.budget_day::text AS budget_day, dc.reserved_cents, dc.phone_hash, dc.allowance_window_start`;

export type ReleaseNoCallResult =
  | { released: true; budgetDay: string; reservedCents: number; allowanceReturned: boolean }
  | { released: false };

/**
 * Return a call's reservation and the visitor's allowance, once, in the
 * caller's open transaction. Only for a call that provably never existed:
 * the `Calls` request was never written or Twilio rejected it with a listed
 * answer (S6-3), or an unconfirmed call's callback window closed with no
 * CallSid ever bound (S6-6). Everything ambiguous (a timeout after the
 * request left, a 5xx, an unparsable body, a bound CallSid) keeps both, by
 * never calling this. The unit goes back to the row of `budget_day` (the
 * reservation's day, not today's). A replay returns `{ released: false }`
 * and touches nothing.
 */
export async function releaseNoCall(client: PoolClient, demoCallId: string): Promise<ReleaseNoCallResult> {
  const { rows } = await client.query<{
    budget_day: string;
    reserved_cents: number;
    phone_hash: string;
    allowance_window_start: Date;
  }>(RELEASE_NO_CALL_SQL, [demoCallId]);
  if (rows.length === 0) return { released: false };
  const r = rows[0];

  await client.query(
    `UPDATE demo_call_budget
        SET calls_reserved = GREATEST(calls_reserved - 1, 0),
            est_cost_cents = GREATEST(est_cost_cents - $2::int, 0)
      WHERE day = $1::date`,
    [r.budget_day, r.reserved_cents],
  );
  const allowanceReturned = await releaseOn(
    client,
    DEMO_PLATFORM_TENANT_ID,
    DEMO_CALL_ALLOWANCE_SCOPE,
    r.phone_hash,
    r.allowance_window_start,
  );
  await writePlatformAudit(client, {
    eventType: DEMO_CALL_BUDGET_RELEASED_EVENT,
    entityType: 'demo_call',
    entityId: demoCallId,
    metadata: { budgetDay: r.budget_day, reservedCents: r.reserved_cents, allowanceReturned },
  });
  return { released: true, budgetDay: r.budget_day, reservedCents: r.reserved_cents, allowanceReturned };
}
