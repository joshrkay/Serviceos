/**
 * U7 (S6-2) — the one platform transaction every demo call starts with
 * (plan "Daily budget", "The visitor's allowance is spent inside that same
 * transaction").
 *
 * On a pooled client as the connection principal, with the hidden platform
 * tenant's GUC set transaction-locally and no tenant role:
 *   (1) the visitor's one-call-a-day allowance (`tryConsumeOn` under the
 *       platform tenant, keyed by the number's hash); refused → ROLLBACK, 429;
 *   (2) the lease (injected: S6-3's `demo/lease.ts`); no free tenant →
 *       ROLLBACK, 503 `DEMO_BUSY`;
 *   (3) the budget reservation (`reserve`); a cap reached → ROLLBACK, 503
 *       `DEMO_BUSY`; then the visitor's lead and the `demo_calls` row that
 *       records the reservation and the allowance bucket.
 * COMMIT spends all three together; any refusal or failure before it rolls
 * all three back, so a refused visitor keeps the allowance. The allowance
 * goes first: its advisory lock serializes two requests for one number
 * before either holds a tenant row or the day's budget row, and no other
 * path takes that key lock while holding one, so it adds no wait cycle.
 * The commit happens before any `Calls` request is built: no call can exist
 * without a committed reservation.
 */
import type { Pool, PoolClient } from 'pg';
import { PgAuditRepository } from '../audit/pg-audit';
import { PgLeadRepository } from '../leads/pg-lead';
import { captureLead } from '../leads/lead-service';
import { tenantContextStore } from '../middleware/tenant-context';
import type { AlertOperatorFn } from '../monitoring/alert-operator';
import { tryConsumeOn } from '../shared/rate-limit/phone-rate-limit';
import {
  DEMO_CALL_ALLOWANCE_LIMIT,
  DEMO_CALL_ALLOWANCE_SCOPE,
  DEMO_CALL_ALLOWANCE_WINDOW_MS,
  budgetDayFor,
  pageBudgetCrossings,
  reserve,
  type BudgetCrossing,
  type BudgetRow,
} from './call-budget';
import { isDemoCallsEnabled, type DemoConfig } from './config';
import { DEMO_PLATFORM_ACTOR_ID, setPlatformTenantContext, writePlatformAudit } from './platform-audit';
import { DEMO_PLATFORM_TENANT_ID } from './platform-tenant';

export const DEMO_CALL_STARTED_EVENT = 'demo_call_started';

export interface DemoStartRequest {
  /** The visitor's number, hashed (the allowance key and `demo_calls.phone_hash`). */
  phoneHash: string;
  /** The visitor's number, E.164 (the marketing lead's phone only). */
  e164: string;
  trade: string;
  businessName: string;
  metroCode?: string | null;
  metroName?: string | null;
  /** Unique per request; the public result is read by it (D4). */
  correlationId: string;
}

export interface TakenLease {
  leaseId: string;
  tenantId: string;
  /** The lease's fencing generation (the lease token's `gen`). */
  generation: number;
}

export interface StartTransactionSteps {
  /**
   * Step (2): insert the lease on `client`, inside this transaction, or
   * return null when the trade has no free demo tenant. Production passes
   * `demo/lease.ts#demoLeaseStep`; nothing else may run here.
   */
  takeLease(client: PoolClient, req: DemoStartRequest, at: Date): Promise<TakenLease | null>;
}

export interface StartTransactionDeps {
  /** Loaded once at boot (`loadDemoConfig`). */
  config: DemoConfig;
  /** The kill switch, read per request (default `isDemoCallsEnabled`). */
  isEnabled?: () => boolean;
  /** The operator page for a budget crossing, sent after COMMIT. */
  alert: AlertOperatorFn;
  now?: () => Date;
}

export interface StartedDemoCall {
  demoCallId: string;
  leaseId: string;
  tenantId: string;
  leaseGeneration: number;
  leadId: string;
  budgetDay: string;
  reservedCents: number;
  allowanceWindowStart: Date;
  callbackDeadlineAt: Date;
  budget: BudgetRow;
}

export type StartOutcome =
  | { kind: 'disabled'; reason: string }
  | { kind: 'rate_limited' }
  | { kind: 'busy'; cause: 'pool' | 'budget' }
  | { kind: 'started'; call: StartedDemoCall };

/**
 * Run the start transaction. Returns the refusal, or the committed call the
 * `Calls` request (S6-3) is then built for. Throws (after ROLLBACK) on any
 * failure: nothing is spent.
 */
export async function runStartTransaction(
  pool: Pool,
  req: DemoStartRequest,
  steps: StartTransactionSteps,
  deps: StartTransactionDeps,
): Promise<StartOutcome> {
  if (!deps.config.open) return { kind: 'disabled', reason: deps.config.reason };
  if (!(deps.isEnabled ?? isDemoCallsEnabled)()) {
    return { kind: 'disabled', reason: 'DEMO_CALLS_ENABLED is off' };
  }
  const settings = deps.config.settings;
  const at = (deps.now ?? (() => new Date()))();

  const client = await pool.connect();
  let broken: Error | undefined;
  // A backend that dies while this transaction sits between statements
  // emits 'error' on the checked-out client; without a listener that is an
  // uncaught exception. Record it: the next statement then rejects, the
  // transaction is gone (nothing spent) and the client is discarded below.
  const onClientError = (err: Error) => {
    broken = err;
  };
  client.on('error', onClientError);
  let crossings: BudgetCrossing[] = [];
  let outcome: StartOutcome;
  try {
    await client.query('BEGIN');
    await setPlatformTenantContext(client);
    outcome = await runSteps(pool, client, req, steps, settings, at, (c) => {
      crossings = c;
    });
    await client.query(outcome.kind === 'started' ? 'COMMIT' : 'ROLLBACK');
  } catch (err) {
    // A failed ROLLBACK means the connection itself is gone: discard it.
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
      broken ??= rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    });
    throw err;
  } finally {
    client.off('error', onClientError);
    // A client whose backend died is discarded, never returned to the pool.
    client.release(broken);
  }

  if (outcome.kind === 'started') await pageBudgetCrossings(deps.alert, crossings);
  return outcome;
}

async function runSteps(
  pool: Pool,
  client: PoolClient,
  req: DemoStartRequest,
  steps: StartTransactionSteps,
  settings: Extract<DemoConfig, { open: true }>['settings'],
  at: Date,
  onCrossings: (c: BudgetCrossing[]) => void,
): Promise<StartOutcome> {
  // (1) The allowance: the first lock this transaction takes.
  const allowance = await tryConsumeOn(
    client,
    DEMO_PLATFORM_TENANT_ID,
    DEMO_CALL_ALLOWANCE_SCOPE,
    req.phoneHash,
    DEMO_CALL_ALLOWANCE_LIMIT,
    DEMO_CALL_ALLOWANCE_WINDOW_MS,
    () => at,
  );
  if (!allowance.allowed || !allowance.windowStart) return { kind: 'rate_limited' };

  // (2) The lease.
  const lease = await steps.takeLease(client, req, at);
  if (!lease) return { kind: 'busy', cause: 'pool' };

  // (3) The reservation, then the rows that record it.
  const budgetDay = budgetDayFor(at);
  const unitCents = settings.callEstCostCents;
  const budget = await reserve(client, {
    day: budgetDay,
    unitCents,
    caps: { callsCap: settings.callsDailyCap, costCapCents: settings.costDailyCapCents },
  });
  if (!budget.reserved) return { kind: 'busy', cause: 'budget' };
  onCrossings(budget.crossings);

  const leadId = await captureVisitorLead(pool, client, req);
  const callbackDeadlineAt = new Date(at.getTime() + settings.statusTokenTtlHours * 60 * 60 * 1000);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO demo_calls (
       phone_hash, trade, business_name, metro_code, metro_name, lease_id, lead_id,
       callback_deadline_at, budget_day, reserved_cents, allowance_window_start, correlation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12)
     RETURNING id`,
    [
      req.phoneHash,
      req.trade,
      req.businessName,
      req.metroCode ?? null,
      req.metroName ?? null,
      lease.leaseId,
      leadId,
      callbackDeadlineAt,
      budgetDay,
      unitCents,
      allowance.windowStart,
      req.correlationId,
    ],
  );
  const demoCallId = rows[0].id;
  await writePlatformAudit(client, {
    eventType: DEMO_CALL_STARTED_EVENT,
    entityType: 'demo_call',
    entityId: demoCallId,
    correlationId: req.correlationId,
    metadata: { trade: req.trade, leaseId: lease.leaseId, budgetDay, reservedCents: unitCents },
  });

  return {
    kind: 'started',
    call: {
      demoCallId,
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      leaseGeneration: lease.generation,
      leadId,
      budgetDay,
      reservedCents: unitCents,
      allowanceWindowStart: allowance.windowStart,
      callbackDeadlineAt,
      budget: budget.row,
    },
  };
}

/**
 * The visitor's marketing lead on the platform tenant (D1, D2: nothing reads
 * facts from it), with `captureLead`'s semantics on this transaction's
 * client: a repeat number attaches to its open lead. `leads.source` has no
 * `demo_call` value, so `other` with `sourceDetail: 'demo_call'`. No owner
 * push: the platform tenant has no owner.
 */
async function captureVisitorLead(pool: Pool, client: PoolClient, req: DemoStartRequest): Promise<string> {
  const { lead } = await tenantContextStore.run({ client, tenantId: DEMO_PLATFORM_TENANT_ID }, () =>
    captureLead(
      {
        tenantId: DEMO_PLATFORM_TENANT_ID,
        companyName: req.businessName,
        primaryPhone: req.e164,
        source: 'other',
        sourceDetail: 'demo_call',
        createdBy: DEMO_PLATFORM_ACTOR_ID,
        actorRole: 'system',
      },
      new PgLeadRepository(pool),
      new PgAuditRepository(pool),
      { notifyOwner: false },
    ),
  );
  return lead.id;
}
