/**
 * #1143 (row 8.10) — an owner can set the tenant's late-fee policy, and the
 * REAL overdue sweep then charges it. Real Postgres throughout.
 *
 * THE DEFECT: `DunningConfigRepository.upsert` had no caller in the product.
 * No REST route, voice intent or web control wrote `invoice_dunning_configs`,
 * so every tenant ran `defaultDunningConfig()` (`lateFeeType: 'none'`) forever
 * and `apply_late_fee` (workers/overdue-invoice-worker.ts) was unreachable.
 * The only proofs of the late-fee leg wrote the config row from the test
 * itself (test/integration/late-fee-idempotency.test.ts) — the state the
 * product could not produce.
 *
 * This file writes the policy ONLY through `PUT /api/settings/dunning` (the
 * real settings router, behind `settings:update`), then:
 *   - the real `runOverdueInvoiceSweep` over PgDunningConfigRepository reads
 *     it and raises an `apply_late_fee` proposal CLAMPED at the owner's cap;
 *   - approving it through the real `ApplyLateFeeExecutionHandler` lands the
 *     clamped fee line on the persisted invoice.
 *
 * Tenant grade: tenant B writes its OWN, divergent policy (percent, long
 * grace) and has its own overdue invoice; tenant A's write and sweep leave B's
 * config row, invoice and proposals untouched (T2), and B's own policy is what
 * the sweep applies to B (no fee inside B's grace window — T3 on the config the
 * worker reads). A technician is refused the write (403) and nothing moves.
 *
 * Identity is stubbed the way every settings integration test here stubs it
 * (req.auth set before the real requireAuth/requireTenant/requirePermission
 * chain); everything below that line is production code.
 *
 * Run:
 *   cd packages/api && RLS_RUNTIME_ROLE=true npx vitest run \
 *     --config vitest.integration.config.ts --reporter=verbose \
 *     test/integration/dunning-config-owner-write.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import type { TestTenant } from './shared';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { createSettingsRouter } from '../../src/routes/settings';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import {
  PgDunningConfigRepository,
  PgDunningEventRepository,
} from '../../src/invoices/pg-dunning-config';
import { runOverdueInvoiceSweep } from '../../src/workers/overdue-invoice-worker';
import { ApplyLateFeeExecutionHandler } from '../../src/proposals/execution/apply-late-fee-handler';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { Proposal } from '../../src/proposals/proposal';
import { createLogger } from '../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const DAY_MS = 24 * 60 * 60 * 1000;

type Actor = { tenantId: string; userId: string; role: 'owner' | 'technician' };

describe('Postgres integration — #1143 owner writes the dunning late-fee policy and the real sweep charges it', () => {
  let pool: Pool;
  let app: express.Express;
  let auditRepo: PgAuditRepository;
  let invoiceRepo: PgInvoiceRepository;
  let jobRepo: PgJobRepository;
  let proposalRepo: PgProposalRepository;
  let dunningConfigRepo: PgDunningConfigRepository;
  let dunningEventRepo: PgDunningEventRepository;

  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let current: Actor;

  // ───────────────────────── helpers ─────────────────────────

  async function seedOverdueInvoice(t: TestTenant, amountCents: number, dueDate: Date): Promise<string> {
    const customerId = uuidv4();
    await new PgCustomerRepository(pool).create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Late',
      lastName: 'Payer',
      displayName: 'Late Payer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = uuidv4();
    await new PgLocationRepository(pool).create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '1143 Dunning Rd',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = uuidv4();
    await jobRepo.create({
      id: jobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-1143-${jobId.slice(0, 8)}`,
      summary: '#1143 late-fee proof',
      status: 'completed',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const invoiceId = uuidv4();
    const lineItems = [buildLineItem(uuidv4(), 'Labor', 1, amountCents, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: t.tenantId,
      jobId,
      invoiceNumber: `INV-1143-${invoiceId.slice(0, 8)}`,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      dueDate,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return invoiceId;
  }

  /** The raw `invoice_dunning_configs` row — what the sweep's repository reads. */
  async function configRow(tenantId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await pool.query(
      `SELECT enabled, reminder_steps, late_fee_type,
              late_fee_value_cents::int AS late_fee_value_cents,
              late_fee_grace_days,
              late_fee_max_cents::int AS late_fee_max_cents,
              updated_at
         FROM invoice_dunning_configs WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows[0] ?? null;
  }

  async function dunningAudit(tenantId: string): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query(
      `SELECT actor_id, actor_role, entity_type, entity_id, metadata
         FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'settings.dunning.updated'
        ORDER BY created_at`,
      [tenantId],
    );
    return rows;
  }

  async function lateFeeProposals(tenantId: string): Promise<Proposal[]> {
    return (await proposalRepo.findByTenant(tenantId)).filter((p) => p.proposalType === 'apply_late_fee');
  }

  function as(actor: Actor) {
    current = actor;
  }

  // ───────────────────────── wiring ─────────────────────────

  beforeAll(async () => {
    pool = await getSharedTestDb();
    auditRepo = new PgAuditRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    jobRepo = new PgJobRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    dunningConfigRepo = new PgDunningConfigRepository(pool);
    dunningEventRepo = new PgDunningEventRepository(pool);

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: current.userId,
        sessionId: 'sess-1143',
        tenantId: current.tenantId,
        role: current.role,
      };
      next();
    });
    app.use(
      '/api/settings',
      createSettingsRouter(
        new PgSettingsRepository(pool),
        undefined,
        auditRepo,
        undefined,
        { dunningConfigRepo },
      ),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  // ───────────────────────── tests ─────────────────────────

  it('GET /api/settings/dunning shows the owner the policy the sweep would use today (the default: no late fee)', async () => {
    as({ tenantId: tenantA.tenantId, userId: tenantA.userId, role: 'owner' });
    const res = await request(app).get('/api/settings/dunning');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: false,
      enabled: true,
      lateFeeType: 'none',
      lateFeeValueCents: 0,
      lateFeeGraceDays: 0,
      lateFeeMaxCents: null,
    });
    expect(res.body.reminderSteps).toEqual([
      { offsetDays: 3, channel: 'sms' },
      { offsetDays: 7, channel: 'sms' },
      { offsetDays: 14, channel: 'sms' },
    ]);
  });

  it('owner PUT persists a capped flat fee; the REAL sweep proposes it clamped at the cap; approval lands the clamped fee line; tenant B keeps its own divergent policy and invoice', async () => {
    const now = new Date();

    // ── Tenant B sets its OWN, divergent policy first (percent, 60-day grace).
    as({ tenantId: tenantB.tenantId, userId: tenantB.userId, role: 'owner' });
    const bPut = await request(app)
      .put('/api/settings/dunning')
      .send({ lateFeeType: 'percent', lateFeeValueCents: 150, lateFeeGraceDays: 60, lateFeeMaxCents: null });
    expect.soft(bPut.status, 'tenant B owner write').toBe(200);
    const bConfigBefore = await configRow(tenantB.tenantId);

    // ── Tenant A's owner writes a 50.00 flat fee, 5-day grace, capped at 20.00.
    as({ tenantId: tenantA.tenantId, userId: tenantA.userId, role: 'owner' });
    const put = await request(app)
      .put('/api/settings/dunning')
      .send({ lateFeeType: 'flat', lateFeeValueCents: 5000, lateFeeGraceDays: 5, lateFeeMaxCents: 2000 });
    expect.soft(put.status, 'PUT /api/settings/dunning as owner').toBe(200);
    expect.soft(put.body).toMatchObject({
      configured: true,
      lateFeeType: 'flat',
      lateFeeValueCents: 5000,
      lateFeeGraceDays: 5,
      lateFeeMaxCents: 2000,
    });

    // The row the sweep reads — written by the route, never by this test.
    expect.soft(await configRow(tenantA.tenantId)).toMatchObject({
      enabled: true,
      late_fee_type: 'flat',
      late_fee_value_cents: 5000,
      late_fee_grace_days: 5,
      late_fee_max_cents: 2000,
      // The cadence the owner did not touch is preserved, not wiped.
      reminder_steps: [
        { offsetDays: 3, channel: 'sms' },
        { offsetDays: 7, channel: 'sms' },
        { offsetDays: 14, channel: 'sms' },
      ],
    });
    const audit = await dunningAudit(tenantA.tenantId);
    expect.soft(audit).toHaveLength(1);
    expect.soft(audit[0]).toMatchObject({
      actor_id: tenantA.userId,
      actor_role: 'owner',
      entity_type: 'invoice_dunning_config',
      metadata: {
        previous: { lateFeeType: 'none', lateFeeValueCents: 0, lateFeeGraceDays: 0, lateFeeMaxCents: null },
        next: { lateFeeType: 'flat', lateFeeValueCents: 5000, lateFeeGraceDays: 5, lateFeeMaxCents: 2000 },
      },
    });

    // A's reads GET back what it wrote.
    const got = await request(app).get('/api/settings/dunning');
    expect.soft(got.body).toMatchObject({ configured: true, lateFeeType: 'flat', lateFeeMaxCents: 2000 });

    // T2 — A's write did not touch B's row.
    expect(await configRow(tenantB.tenantId)).toEqual(bConfigBefore);

    // ── Overdue invoices: A is 10 days past due (past its 5-day grace);
    //    B is 30 days past due (inside its own 60-day grace).
    const aInvoiceId = await seedOverdueInvoice(tenantA, 100_000, new Date(now.getTime() - 10 * DAY_MS));
    const bInvoiceId = await seedOverdueInvoice(tenantB, 80_000, new Date(now.getTime() - 30 * DAY_MS));

    // ── The REAL sweep, over the real Pg dunning-config repository.
    const result = await runOverdueInvoiceSweep({
      jobRepo,
      estimateRepo: new PgEstimateRepository(pool),
      invoiceRepo,
      auditRepo,
      proposalRepo,
      dunningEventRepo,
      dunningConfigRepo,
      listTenantIds: async () => [tenantA.tenantId, tenantB.tenantId],
      now: () => now,
      logger,
    });
    expect(result.failed).toBe(0);

    // A: one late_fee ledger row and one apply_late_fee proposal, CLAMPED to 20.00.
    const aFeeEvents = (await dunningEventRepo.findByInvoice(tenantA.tenantId, aInvoiceId)).filter(
      (e) => e.kind === 'late_fee',
    );
    expect(aFeeEvents, 'a late_fee ledger row for tenant A').toHaveLength(1);
    expect(aFeeEvents[0].amountCents).toBe(2000);
    const aProposals = await lateFeeProposals(tenantA.tenantId);
    expect(aProposals).toHaveLength(1);
    expect(aProposals[0].status).toBe('ready_for_review');
    expect(aProposals[0].payload).toMatchObject({ invoiceId: aInvoiceId, feeCents: 2000, stepKey: 'initial' });

    // The owner approves → the real execution handler appends the fee line.
    const applied = await new ApplyLateFeeExecutionHandler(invoiceRepo, auditRepo).execute(
      { ...aProposals[0], status: 'approved' } as Proposal,
      { tenantId: tenantA.tenantId, executedBy: tenantA.userId },
    );
    expect(applied.success).toBe(true);
    const aInvoice = await invoiceRepo.findById(tenantA.tenantId, aInvoiceId);
    const feeLines = aInvoice!.lineItems.filter((li) => li.description === 'Late fee');
    expect(feeLines).toHaveLength(1);
    expect(feeLines[0].totalCents).toBe(2000);
    expect(aInvoice!.amountDueCents).toBe(102_000);

    // B: its own policy applied — inside its 60-day grace, so no fee was
    // proposed, no ledger row, no fee line, balance unchanged.
    expect(
      (await dunningEventRepo.findByInvoice(tenantB.tenantId, bInvoiceId)).filter((e) => e.kind === 'late_fee'),
    ).toHaveLength(0);
    expect(await lateFeeProposals(tenantB.tenantId)).toHaveLength(0);
    const bInvoice = await invoiceRepo.findById(tenantB.tenantId, bInvoiceId);
    expect(bInvoice!.lineItems).toHaveLength(1);
    expect(bInvoice!.amountDueCents).toBe(80_000);
    expect(await configRow(tenantB.tenantId)).toEqual(bConfigBefore);
  });

  it('a technician is refused the write (403): no config row moves and nothing is audited', async () => {
    const technicianId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role) VALUES ($1, $2, $3, $4, 'technician')`,
      [technicianId, tenantA.tenantId, technicianId, 'tech-1143@example.com'],
    );
    const before = await configRow(tenantA.tenantId);
    const auditBefore = await dunningAudit(tenantA.tenantId);

    as({ tenantId: tenantA.tenantId, userId: technicianId, role: 'technician' });
    const res = await request(app)
      .put('/api/settings/dunning')
      .send({ lateFeeType: 'flat', lateFeeValueCents: 99_900, lateFeeGraceDays: 0, lateFeeMaxCents: null });
    expect(res.status).toBe(403);

    expect(await configRow(tenantA.tenantId)).toEqual(before);
    expect(await dunningAudit(tenantA.tenantId)).toHaveLength(auditBefore.length);
  });
});
