/**
 * Postgres integration — HFCR weekly owner-summary worker.
 *
 * The compute math (computeHfcrForTenant — payment/proposal/audit fan-in)
 * is fully covered by unit tests. This file drives runHfcrWeeklySendSweep
 * against the production PgHfcrWeeklySendRepository to pin the durable
 * pieces only that path owns:
 *
 *   1. hfcr_weekly_sends UNIQUE (tenant_id, week_starting_date) — the
 *      idempotency source of truth. A re-run finds an existing row via
 *      findByWeek and short-circuits before any SMS.
 *   2. RLS on hfcr_weekly_sends — cross-tenant findByWeek reads return
 *      null even when a sibling tenant already has a row for the week.
 *   3. The "send first, then record" ordering: a transient SMS failure
 *      never leaves a ledger row behind (next sweep retries the week).
 *
 * The compute deps are stubbed with synthetic Payment/Proposal arrays so
 * the test is deterministic without seeding payments/proposals/audit
 * events the way the real money-loop tests do.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import {
  runHfcrWeeklySendSweep,
  startOfWeekUTC,
} from '../../src/workers/hfcr-weekly-send-worker';
import { PgHfcrWeeklySendRepository } from '../../src/metrics/hfcr-weekly-send';
import { createLogger } from '../../src/logging/logger';
import type { Payment, PaymentRepository } from '../../src/invoices/payment';
import type { Proposal, ProposalRepository } from '../../src/proposals/proposal';
import type { AuditRepository } from '../../src/audit/audit';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

// Fixed clock: a Wednesday inside week [2026-06-08 (Mon) .. 2026-06-15 (Mon)).
const NOW = new Date('2026-06-17T10:00:00.000Z');
const SUMMARIZED_WEEK_START = startOfWeekUTC(new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000));
const SUMMARIZED_WEEK_KEY = SUMMARIZED_WEEK_START.toISOString().slice(0, 10);

interface CapturedSms {
  to: string;
  body: string;
}

/**
 * Build the smallest synthetic set of compute deps that makes
 * computeHfcrForTenant return hfcrCents > 0:
 *   - one completed payment for invoice "inv-A"
 *   - one proposal whose resultEntityId points at "inv-A" (so the invoice
 *     is "gating") and whose audit chain is empty (auto-approved =
 *     hands-free).
 * The full proposal-approval classification is covered by the unit tests.
 */
function makeHandsFreeComputeDeps(
  paymentCents: number,
  invoiceId = 'inv-hf-A',
): {
  paymentRepo: PaymentRepository;
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
} {
  const payment: Payment = {
    id: uuidv4(),
    tenantId: 'IGNORED-by-stub',
    invoiceId,
    amountCents: paymentCents,
    refundedAmountCents: 0,
    status: 'completed',
    receivedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
  } as unknown as Payment;
  const proposal: Proposal = {
    id: uuidv4(),
    tenantId: 'IGNORED-by-stub',
    resultEntityId: invoiceId,
  } as unknown as Proposal;
  return {
    paymentRepo: {
      findByTenant: async () => [payment],
    } as unknown as PaymentRepository,
    proposalRepo: {
      findByTenant: async () => [proposal],
    } as unknown as ProposalRepository,
    auditRepo: {
      // Empty audit trail for the proposal = auto-approved = hands-free.
      findByEntity: async () => [],
    } as unknown as AuditRepository,
  };
}

function makeNoActivityComputeDeps(): {
  paymentRepo: PaymentRepository;
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
} {
  return {
    paymentRepo: { findByTenant: async () => [] } as unknown as PaymentRepository,
    proposalRepo: { findByTenant: async () => [] } as unknown as ProposalRepository,
    auditRepo: { findByEntity: async () => [] } as unknown as AuditRepository,
  };
}

function makeCapturingSendSms(): {
  sendSms: (args: { to: string; body: string }) => Promise<unknown>;
  calls: CapturedSms[];
} {
  const calls: CapturedSms[] = [];
  return {
    calls,
    sendSms: async ({ to, body }) => {
      calls.push({ to, body });
      return { sid: `sms_${calls.length}` };
    },
  };
}

/**
 * Unprivileged role + GUC pattern mirrored from rls-tenant-isolation.test.ts.
 * `hfcrSendRepo.findByWeek` includes `WHERE tenant_id = $1`, so the
 * cross-tenant null check below could pass with the policy dropped.
 * Querying through asTenant under the NOBYPASSRLS role without a tenant_id
 * predicate makes the policy itself the only thing gating cross-tenant reads.
 */
const APP_ROLE = 'rls_app_runtime';

async function ensureRlsAppRole(pool: Pool): Promise<void> {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
      CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS;
    END IF;
  END $$;`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
}

async function asTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('HFCR weekly send worker — integration', () => {
  let pool: Pool;
  let hfcrSendRepo: PgHfcrWeeklySendRepository;
  let tenantA: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    hfcrSendRepo = new PgHfcrWeeklySendRepository(pool);
    await ensureRlsAppRole(pool);
  });

  beforeEach(async () => {
    tenantA = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('happy path: tenant with hands-free revenue gets one SMS and one hfcr_weekly_sends row', async () => {
    const compute = makeHandsFreeComputeDeps(15000);
    const { sendSms, calls } = makeCapturingSendSms();

    const result = await runHfcrWeeklySendSweep({
      paymentRepo: compute.paymentRepo,
      proposalRepo: compute.proposalRepo,
      auditRepo: compute.auditRepo,
      hfcrSendRepo,
      resolveOwnerPhone: async () => '+15551237777',
      sendSms,
      listTenantIds: async () => [tenantA.tenantId],
      logger,
      now: () => NOW,
    });

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('+15551237777');
    expect(calls[0].body).toMatch(/collected \$150\.00 hands-free/);

    // Ledger row persisted via the production withTenant path.
    const row = await hfcrSendRepo.findByWeek(tenantA.tenantId, SUMMARIZED_WEEK_KEY);
    expect(row).not.toBeNull();
    expect(row!.hfcrCents).toBe(15000);
    expect(row!.weekStartingDate).toBe(SUMMARIZED_WEEK_KEY);
  });

  it('idempotent on re-sweep: the second sweep finds the ledger row and sends nothing', async () => {
    const compute = makeHandsFreeComputeDeps(20000);
    const sender1 = makeCapturingSendSms();
    const first = await runHfcrWeeklySendSweep({
      paymentRepo: compute.paymentRepo,
      proposalRepo: compute.proposalRepo,
      auditRepo: compute.auditRepo,
      hfcrSendRepo,
      resolveOwnerPhone: async () => '+15558888888',
      sendSms: sender1.sendSms,
      listTenantIds: async () => [tenantA.tenantId],
      logger,
      now: () => NOW,
    });
    expect(first.sent).toBe(1);
    expect(sender1.calls).toHaveLength(1);

    const sender2 = makeCapturingSendSms();
    const second = await runHfcrWeeklySendSweep({
      paymentRepo: compute.paymentRepo,
      proposalRepo: compute.proposalRepo,
      auditRepo: compute.auditRepo,
      hfcrSendRepo,
      resolveOwnerPhone: async () => '+15558888888',
      sendSms: sender2.sendSms,
      listTenantIds: async () => [tenantA.tenantId],
      logger,
      now: () => NOW,
    });
    expect(second.sent).toBe(0);
    expect(sender2.calls).toHaveLength(0);
  });

  it('skips a tenant with no hands-free activity (sent=0; no ledger row written)', async () => {
    const compute = makeNoActivityComputeDeps();
    const { sendSms, calls } = makeCapturingSendSms();

    const result = await runHfcrWeeklySendSweep({
      paymentRepo: compute.paymentRepo,
      proposalRepo: compute.proposalRepo,
      auditRepo: compute.auditRepo,
      hfcrSendRepo,
      resolveOwnerPhone: async () => '+15551111111',
      sendSms,
      listTenantIds: async () => [tenantA.tenantId],
      logger,
      now: () => NOW,
    });
    expect(result.sent).toBe(0);
    expect(calls).toHaveLength(0);

    const row = await hfcrSendRepo.findByWeek(tenantA.tenantId, SUMMARIZED_WEEK_KEY);
    expect(row).toBeNull();
  });

  it('skips a tenant with no owner phone configured (no SMS; no ledger row)', async () => {
    const compute = makeHandsFreeComputeDeps(10000);
    const { sendSms, calls } = makeCapturingSendSms();

    const result = await runHfcrWeeklySendSweep({
      paymentRepo: compute.paymentRepo,
      proposalRepo: compute.proposalRepo,
      auditRepo: compute.auditRepo,
      hfcrSendRepo,
      resolveOwnerPhone: async () => null,
      sendSms,
      listTenantIds: async () => [tenantA.tenantId],
      logger,
      now: () => NOW,
    });
    expect(result.sent).toBe(0);
    expect(calls).toHaveLength(0);

    const row = await hfcrSendRepo.findByWeek(tenantA.tenantId, SUMMARIZED_WEEK_KEY);
    expect(row).toBeNull();
  });

  it('send-then-record: a failing sendSms leaves NO ledger row behind so the next sweep retries the week', async () => {
    const compute = makeHandsFreeComputeDeps(7500);
    let attempts = 0;
    const sendSms = async () => {
      attempts++;
      throw new Error('SMS provider down');
    };

    const result = await runHfcrWeeklySendSweep({
      paymentRepo: compute.paymentRepo,
      proposalRepo: compute.proposalRepo,
      auditRepo: compute.auditRepo,
      hfcrSendRepo,
      resolveOwnerPhone: async () => '+15554444444',
      sendSms,
      listTenantIds: async () => [tenantA.tenantId],
      logger,
      now: () => NOW,
    });
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(attempts).toBe(1);

    // CRITICAL invariant: a failed send must NOT have created a ledger
    // row (otherwise the next sweep would skip the week and the SMS would
    // never go out).
    const row = await hfcrSendRepo.findByWeek(tenantA.tenantId, SUMMARIZED_WEEK_KEY);
    expect(row).toBeNull();
  });

  it('tenant isolation: a ledger row for tenant A is invisible via tenant B findByWeek (RLS)', async () => {
    const tenantB = await createTestTenant(pool);
    const compute = makeHandsFreeComputeDeps(12500);
    const { sendSms } = makeCapturingSendSms();

    await runHfcrWeeklySendSweep({
      paymentRepo: compute.paymentRepo,
      proposalRepo: compute.proposalRepo,
      auditRepo: compute.auditRepo,
      hfcrSendRepo,
      resolveOwnerPhone: async () => '+15557777777',
      sendSms,
      listTenantIds: async () => [tenantA.tenantId],
      logger,
      now: () => NOW,
    });

    const aRow = await hfcrSendRepo.findByWeek(tenantA.tenantId, SUMMARIZED_WEEK_KEY);
    expect(aRow).not.toBeNull();

    // RLS proof: under each tenant's GUC and the unprivileged role,
    // enumerate hfcr_weekly_sends rows for the summarized week WITHOUT
    // a tenant_id predicate. Only the policy gates this read.
    const tenantIdsUnderA = await asTenant(pool, tenantA.tenantId, (client) =>
      client.query(
        `SELECT tenant_id FROM hfcr_weekly_sends WHERE week_starting_date = $1`,
        [SUMMARIZED_WEEK_KEY],
      ).then((r) => r.rows.map((row: { tenant_id: string }) => row.tenant_id)),
    );
    const tenantIdsUnderB = await asTenant(pool, tenantB.tenantId, (client) =>
      client.query(
        `SELECT tenant_id FROM hfcr_weekly_sends WHERE week_starting_date = $1`,
        [SUMMARIZED_WEEK_KEY],
      ).then((r) => r.rows.map((row: { tenant_id: string }) => row.tenant_id)),
    );
    expect(tenantIdsUnderA).toContain(tenantA.tenantId);
    expect(tenantIdsUnderA).not.toContain(tenantB.tenantId);
    expect(tenantIdsUnderB).not.toContain(tenantA.tenantId);
  });
});
