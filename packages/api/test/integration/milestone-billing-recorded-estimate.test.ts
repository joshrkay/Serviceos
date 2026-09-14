/**
 * #1203 (redesign) — a milestone plan bills ONE recorded estimate; that
 * estimate is never billed twice, and nothing a plan should bill is dropped
 * without an owner-visible artifact.
 *
 * Every plan here comes from the REAL voice on-ramp,
 * `CreateInvoiceScheduleTaskHandler` (its payload never carries an
 * estimateId), and is approved and run through the production
 * `createExecutionHandlerRegistry` + `ProposalExecutor`. Whole-estimate
 * invoices come from the real HTTP routes of `createApp()`
 * (`POST /api/estimates/:id/convert-to-invoice`, `POST /api/invoices`), the
 * auto-invoice draft raised at completion, or the `draft_invoice` handler.
 * Completion is `POST /api/jobs/:id/transition {status:'completed'}`, which
 * runs the real completion effects (auto-invoice first, then milestone
 * minting) inside the request transaction.
 *
 * Scenarios (letters match the PR):
 *   A convert → voice 50/50 plan: refused at approval, $1,000 billed
 *   B voice plan both on completion + auto-invoice on: only the milestones
 *   C change-order E2 invoiced + voice plan for E1: E1's plan mints fully
 *   D plan first → convert / approve a whole-estimate draft: refused
 *   E canceled converted invoice → plan mints fully
 *   F void converted invoice WITH a payment → plan refused, refund reason
 *   G milestone billing OFF + plan + auto-invoice on: whole draft still raised
 *   H hand-made invoice with no estimate → plan goes through, warning lists it
 *   I tenant B untouched (T1)
 *   J no single accepted estimate → voice plan refused with a reason
 *   K a whole invoice that appeared after approval holds the milestones at
 *     completion as a ready_for_review draft the owner can act on
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb, createTestTenant } from './shared';
import type { AppWithLifecycle } from '../../src/app';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgInvoiceScheduleRepository } from '../../src/invoices/pg-invoice-schedule';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgJobTimelineRepository } from '../../src/jobs/pg-job-lifecycle';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { transitionEstimateStatus } from '../../src/estimates/estimate';
import { CreateInvoiceScheduleTaskHandler } from '../../src/ai/tasks/voice-extended-tasks';
import { createProposal, Proposal } from '../../src/proposals/proposal';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { createExecutionHandlerRegistry, ExecutionResult } from '../../src/proposals/execution/handlers';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const DEPOSIT_THEN_BALANCE = '50% deposit, 50% on completion';
const BOTH_ON_COMPLETION = 'half on completion, the rest when done';

function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

function bearer(sub: string): string {
  return `Bearer ${unsignedJwt({ sub, sid: `sess-${sub}`, role: 'owner', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
}

interface Seeded {
  tag: string;
  tenantId: string;
  userId: string;
  customerId: string;
  locationId: string;
  jobId: string;
  estimateId: string;
}

interface InvoiceRow {
  invoice_number: string;
  status: string;
  estimate_id: string | null;
  schedule_id: string | null;
  milestone_index: number | null;
  total_cents: number;
  amount_paid_cents: number;
}

describe('#1203 — a milestone plan bills one recorded estimate (voice plan, real routes, real Postgres)', () => {
  let pool: Pool;
  let app: AppWithLifecycle;
  let prevEnv: Record<string, string | undefined>;
  let invoiceRepo: PgInvoiceRepository;
  let scheduleRepo: PgInvoiceScheduleRepository;
  let settingsRepo: PgSettingsRepository;
  let estimateRepo: PgEstimateRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let proposalRepo: PgProposalRepository;
  let executor: ProposalExecutor;

  // ── seeding ────────────────────────────────────────────────────────────

  async function seedTenant(
    tag: string,
    opts: { milestoneBillingEnabled?: boolean; autoInvoiceOnCompletion?: boolean } = {},
  ) {
    const { tenantId, userId } = await createTestTenant(pool);
    const now = new Date();
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId,
      businessName: `Milestone ${tag}`,
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: now,
      updatedAt: now,
    });
    // The owner's settings toggles (create() does not persist them; update() does).
    await settingsRepo.update(tenantId, {
      milestoneBillingEnabled: opts.milestoneBillingEnabled ?? true,
      autoInvoiceOnCompletion: opts.autoInvoiceOnCompletion ?? false,
    });
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId,
      firstName: 'Dee',
      lastName: tag,
      displayName: `Dee ${tag}`,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId,
      customerId,
      street1: '1203 Double Bill Ln',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      addressType: 'service',
      isPrimary: true,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    });
    return { tenantId, userId, customerId, locationId };
  }

  /** A job in progress, and (unless `estimate: false`) its estimate sent then ACCEPTED. */
  async function seed(
    tag: string,
    opts: { milestoneBillingEnabled?: boolean; autoInvoiceOnCompletion?: boolean; estimate?: false | 'sent' } = {},
  ): Promise<Seeded> {
    const base = await seedTenant(tag, opts);
    const now = new Date();
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: base.tenantId,
      customerId: base.customerId,
      locationId: base.locationId,
      jobNumber: `JOB-1203-${tag}`,
      summary: 'Water heater swap',
      status: 'in_progress',
      priority: 'normal',
      depositRequiredCents: 0,
      depositPaidCents: 0,
      depositStatus: 'not_required',
      createdBy: base.userId,
      createdAt: now,
      updatedAt: now,
    });
    let estimateId = '';
    if (opts.estimate !== false) {
      estimateId = await seedEstimate({ ...base, jobId }, `EST-1203-${tag}`, 100000, opts.estimate === 'sent' ? 'sent' : 'accepted');
    }
    return { tag, ...base, jobId, estimateId };
  }

  async function seedEstimate(
    s: { tenantId: string; userId: string; jobId: string },
    estimateNumber: string,
    amountCents: number,
    finalStatus: 'sent' | 'accepted',
  ): Promise<string> {
    const items = [buildLineItem(crypto.randomUUID(), 'Water heater', 1, amountCents, 0, true, 'labor')];
    const id = crypto.randomUUID();
    const now = new Date();
    await estimateRepo.create({
      id,
      tenantId: s.tenantId,
      jobId: s.jobId,
      estimateNumber,
      status: 'sent',
      lineItems: items,
      totals: calculateDocumentTotals(items, 0, 0),
      version: 1,
      createdBy: s.userId,
      createdAt: now,
      updatedAt: now,
    });
    if (finalStatus === 'accepted') {
      await transitionEstimateStatus(s.tenantId, id, 'accepted', estimateRepo);
    }
    return id;
  }

  // ── product paths ──────────────────────────────────────────────────────

  /** #1133 workaround — the request transaction commits on res.finish; poll until visible. */
  async function waitFor(sql: string, params: unknown[]): Promise<void> {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const { rowCount } = await pool.query(sql, params);
      if ((rowCount ?? 0) > 0 || Date.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** POST /api/estimates/:id/convert-to-invoice as the owner. */
  async function convert(s: Seeded, estimateId = s.estimateId) {
    const res = await request(app)
      .post(`/api/estimates/${estimateId}/convert-to-invoice`)
      .set('Authorization', bearer(s.userId))
      .send({});
    if (res.status === 201) await waitFor('SELECT 1 FROM invoices WHERE id = $1', [res.body.id]); // #1133
    return res;
  }

  async function invoicePost(s: Seeded, path: string, body: Record<string, unknown>) {
    const res = await request(app).post(path).set('Authorization', bearer(s.userId)).send(body);
    return res;
  }

  /** POST /api/jobs/:id/transition {status:'completed'} — the real completion effects run. */
  async function completeJob(s: Seeded) {
    const res = await request(app)
      .post(`/api/jobs/${s.jobId}/transition`)
      .set('Authorization', bearer(s.userId))
      .send({ status: 'completed' });
    expect(res.status).toBe(200);
    await waitFor(`SELECT 1 FROM jobs WHERE id = $1 AND status = 'completed'`, [s.jobId]); // #1133
  }

  /** "Set up <plan> for the <tag> job", through the REAL voice task handler. */
  async function voicePlan(s: Seeded, sentence: string, amountCents: number): Promise<Proposal> {
    const { proposal } = await new CreateInvoiceScheduleTaskHandler().handle({
      tenantId: s.tenantId,
      userId: s.userId,
      message: `Set up ${sentence} for the ${s.tag} job, ${amountCents / 100} dollars`,
      existingEntities: {
        jobReference: `the ${s.tag} job`,
        jobId: s.jobId, // router-resolved (P8 annotation seam)
        scheduleDescription: sentence,
        amount: amountCents,
      },
    });
    expect(proposal.proposalType).toBe('create_invoice_schedule');
    // The production payload shape: no estimate id anywhere.
    expect(proposal.payload).not.toHaveProperty('estimateId');
    return proposal;
  }

  /** The owner approves; the proposal runs through the production registry + executor. */
  async function approveAndExecute(s: Seeded, proposal: Proposal): Promise<ExecutionResult> {
    let approved = proposal;
    if (approved.status === 'draft') approved = transitionProposal(approved, 'ready_for_review', s.userId);
    approved = transitionProposal(approved, 'approved', s.userId);
    // Backdate past the 5-second undo window so the executor runs now.
    approved = { ...approved, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    if (await proposalRepo.findById(s.tenantId, approved.id)) {
      await proposalRepo.updateStatus(s.tenantId, approved.id, 'approved', { approvedAt: approved.approvedAt });
    } else {
      await proposalRepo.create(approved);
    }
    const { result } = await executor.execute(approved, { tenantId: s.tenantId, executedBy: s.userId });
    return result;
  }

  /** Every invoice draft proposal waiting in the owner's inbox for this job. */
  async function waitingInvoiceDrafts(s: Seeded): Promise<Proposal[]> {
    return [
      ...(await proposalRepo.findByStatus(s.tenantId, 'draft')),
      ...(await proposalRepo.findByStatus(s.tenantId, 'ready_for_review')),
    ].filter((p) => p.proposalType === 'draft_invoice' && p.payload.jobId === s.jobId);
  }

  // ── evidence ───────────────────────────────────────────────────────────

  async function invoiceRows(s: Pick<Seeded, 'tenantId' | 'jobId'>): Promise<InvoiceRow[]> {
    const { rows } = await pool.query<InvoiceRow>(
      `SELECT invoice_number, status, estimate_id, schedule_id, milestone_index,
              total_cents::int AS total_cents, amount_paid_cents::int AS amount_paid_cents
         FROM invoices WHERE tenant_id = $1 AND job_id = $2 ORDER BY invoice_number`,
      [s.tenantId, s.jobId],
    );
    return rows;
  }

  /** Σ of invoices that still bill (canceled never; void only when it holds a payment). */
  const billed = (rows: InvoiceRow[]) =>
    rows
      .filter((r) => r.status !== 'canceled' && !(r.status === 'void' && r.amount_paid_cents === 0))
      .reduce((sum, r) => sum + r.total_cents, 0);

  /** Row dump per job and estimate, printed into the test log for the PR. */
  async function dump(s: Pick<Seeded, 'tenantId'>, label: string): Promise<void> {
    const { rows } = await pool.query(
      `SELECT j.job_number, i.invoice_number, i.status, e.estimate_number AS invoice_estimate,
              pe.estimate_number AS plan_estimate, i.milestone_index,
              i.total_cents::int AS total_cents, i.amount_paid_cents::int AS paid_cents
         FROM invoices i
         JOIN jobs j ON j.id = i.job_id
         LEFT JOIN estimates e ON e.id = i.estimate_id
         LEFT JOIN invoice_schedules p ON p.id = i.schedule_id
         LEFT JOIN estimates pe ON pe.id = p.estimate_id
        WHERE i.tenant_id = $1
        ORDER BY j.job_number, i.invoice_number`,
      [s.tenantId],
    );
    const { rows: plans } = await pool.query(
      `SELECT j.job_number, e.estimate_number AS plan_estimate, p.total_amount_cents::int AS plan_total_cents
         FROM invoice_schedules p JOIN jobs j ON j.id = p.job_id LEFT JOIN estimates e ON e.id = p.estimate_id
        WHERE p.tenant_id = $1 ORDER BY j.job_number`,
      [s.tenantId],
    );
    // eslint-disable-next-line no-console
    console.log(`\n[#1203 dump] ${label}\n  invoices: ${JSON.stringify(rows)}\n  plans: ${JSON.stringify(plans)}`);
  }

  /** Owner-facing text (refusal reason / explanation), printed into the test log for the PR. */
  function say(label: string, text: string | undefined): void {
    // eslint-disable-next-line no-console
    console.log(`[#1203 owner text] ${label}: ${text}`);
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    scheduleRepo = new PgInvoiceScheduleRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    const auditRepo = new PgAuditRepository(pool);
    // The registry deps app.ts passes for these handlers.
    const registry = createExecutionHandlerRegistry({
      customerRepo,
      jobRepo,
      timelineRepo: new PgJobTimelineRepository(pool),
      locationRepo,
      invoiceRepo,
      estimateRepo,
      settingsRepo,
      scheduleRepo,
      proposalRepo,
      auditRepo,
      paymentRepo: new PgPaymentRepository(pool),
    });
    const guard = new IdempotencyGuard(new InMemoryProposalExecutionRepository(), proposalRepo);
    executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    prevEnv = {
      NODE_ENV: process.env.NODE_ENV,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
      PROCESS_ROLE: process.env.PROCESS_ROLE,
      DATABASE_URL: process.env.DATABASE_URL,
      DB_SSL: process.env.DB_SSL,
    };
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web'; // no background loops: nothing executes proposals behind the test
    process.env.DATABASE_URL = process.env.TEST_DB_URL;
    process.env.DB_SSL = 'false';
    const { resetConfig } = await import('../../src/shared/config');
    const { createApp } = await import('../../src/app');
    resetConfig();
    app = createApp();
  });

  afterAll(async () => {
    await app.gracefulDrain('test-cleanup');
    const { resetConfig } = await import('../../src/shared/config');
    resetConfig();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await closeSharedTestDb();
  });

  it('A — convert, then a voice 50/50 plan: refused at approval with the invoice number; $1,000 billed', async () => {
    const s = await seed('A');
    const converted = await convert(s);
    expect(converted.status).toBe(201);

    const plan = await voicePlan(s, DEPOSIT_THEN_BALANCE, 100000);
    const result = await approveAndExecute(s, plan);
    await completeJob(s);
    await dump(s, 'A convert then voice plan');
    say('A plan refusal', result.error);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already invoiced as INV-0001/);
    // Owner-visible: the failed plan sits in the inbox with its reason.
    const stored = await proposalRepo.findById(s.tenantId, plan.id);
    expect(stored?.status).toBe('execution_failed');
    expect(stored?.executionError).toMatch(/already invoiced as INV-0001/);

    expect(await scheduleRepo.findByJob(s.tenantId, s.jobId)).toEqual([]);
    const rows = await invoiceRows(s);
    expect(rows).toEqual([
      { invoice_number: 'INV-0001', status: 'draft', estimate_id: s.estimateId, schedule_id: null, milestone_index: null, total_cents: 100000, amount_paid_cents: 0 },
    ]);
    expect(billed(rows)).toBe(100000);
  });

  it('B — voice plan with both milestones on completion + auto-invoice on: exactly the milestones, $1,000', async () => {
    const s = await seed('B', { autoInvoiceOnCompletion: true });
    const approved = await approveAndExecute(s, await voicePlan(s, BOTH_ON_COMPLETION, 100000));
    expect(approved.success).toBe(true);
    expect(await invoiceRows(s)).toEqual([]);

    await completeJob(s);
    // The owner approves anything waiting in the inbox for this job.
    for (const draft of await waitingInvoiceDrafts(s)) await approveAndExecute(s, draft);
    await dump(s, 'B plan + auto-invoice on');

    const rows = await invoiceRows(s);
    expect(rows.map((r) => [r.estimate_id, r.schedule_id, r.milestone_index, r.total_cents])).toEqual([
      [s.estimateId, approved.resultEntityId, 0, 50000],
      [null, approved.resultEntityId, 1, 50000],
    ]);
    expect(billed(rows)).toBe(100000);
    expect(await proposalRepo.findByIdempotencyKey(s.tenantId, `auto_invoice:${s.jobId}`)).toBeNull();
    // The plan recorded the job's single accepted estimate.
    const [schedule] = await scheduleRepo.findByJob(s.tenantId, s.jobId);
    expect(schedule.estimateId).toBe(s.estimateId);
  });

  it('C — a change-order estimate E2 invoiced on the job does not block the voice plan for E1: E1 mints fully', async () => {
    const s = await seed('C');
    // E2: a change order drafted through the real create_change_order handler…
    const co = createProposal({
      tenantId: s.tenantId,
      proposalType: 'create_change_order',
      payload: { jobId: s.jobId, title: 'Change order — extra valve', lineItems: [{ description: 'Extra valve', quantity: 1, unitPriceCents: 25000 }] },
      summary: 'Change order',
      createdBy: s.userId,
    });
    const coResult = await approveAndExecute(s, co);
    expect(coResult.success).toBe(true);
    const e2 = coResult.resultEntityId!;
    // …and billed from the web invoice form (POST /api/invoices with that estimate).
    // (uq_estimates_accepted_per_job keeps E2 from being accepted while E1 is, so
    // it cannot go through convert-to-invoice; this is the estimate-linked path it can.)
    const inv = await invoicePost(s, '/api/invoices', {
      jobId: s.jobId,
      estimateId: e2,
      lineItems: [{ id: crypto.randomUUID(), description: 'Extra valve', quantity: 1, unitPriceCents: 25000, totalCents: 25000, sortOrder: 0, taxable: true }],
    });
    expect(inv.status).toBe(201);
    await waitFor('SELECT 1 FROM invoices WHERE id = $1', [inv.body.id]); // #1133

    const approved = await approveAndExecute(s, await voicePlan(s, DEPOSIT_THEN_BALANCE, 100000));
    expect(approved.success).toBe(true);
    await completeJob(s);
    await dump(s, 'C change order E2 + plan for E1');

    const rows = await invoiceRows(s);
    expect(rows.map((r) => [r.invoice_number, r.estimate_id, r.schedule_id, r.milestone_index, r.total_cents])).toEqual([
      ['INV-0001', e2, null, null, 25000],
      ['INV-0002', s.estimateId, approved.resultEntityId, 0, 50000],
      ['INV-0003', null, approved.resultEntityId, 1, 50000],
    ]);
    const planRows = rows.filter((r) => r.schedule_id === approved.resultEntityId);
    expect(billed(planRows)).toBe(100000);
    const [schedule] = await scheduleRepo.findByJob(s.tenantId, s.jobId);
    expect(schedule.estimateId).toBe(s.estimateId); // E1, never E2
  });

  it('D1 — plan first (deposit minted), then convert E: refused, no second whole invoice, $1,000', async () => {
    const s = await seed('D1');
    const approved = await approveAndExecute(s, await voicePlan(s, DEPOSIT_THEN_BALANCE, 100000));
    expect(approved.success).toBe(true);
    const res = await convert(s);
    await completeJob(s);
    await dump(s, 'D1 plan then convert');
    say('D1 convert refusal', res.body.message);
    const rows = await invoiceRows(s);
    expect(rows.map((r) => [r.invoice_number, r.schedule_id, r.milestone_index, r.total_cents])).toEqual([
      ['INV-0001', approved.resultEntityId, 0, 50000],
      ['INV-0002', approved.resultEntityId, 1, 50000],
    ]);
    expect(billed(rows)).toBe(100000);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/billed by a milestone plan/);
    expect(res.body.message).toMatch(/INV-0001/);
  });

  it('D2 — plan first (nothing minted yet, bills at completion), then convert E: refused, $1,000', async () => {
    const s2 = await seed('D2');
    const approved2 = await approveAndExecute(s2, await voicePlan(s2, BOTH_ON_COMPLETION, 100000));
    expect(approved2.success).toBe(true);
    const res2 = await convert(s2);
    await completeJob(s2);
    await dump(s2, 'D2 plan (nothing minted) then convert');
    say('D2 convert refusal', res2.body.message);
    const rows2 = await invoiceRows(s2);
    expect(rows2.map((r) => [r.schedule_id, r.milestone_index, r.total_cents])).toEqual([
      [approved2.resultEntityId, 0, 50000],
      [approved2.resultEntityId, 1, 50000],
    ]);
    expect(billed(rows2)).toBe(100000);
    expect(res2.status).toBe(409);
    expect(res2.body.message).toMatch(/billed by a milestone plan/);
  });

  it('D3 — a waiting whole-estimate auto-draft approved after a plan: the draft_invoice handler refuses it', async () => {
    // The auto-invoice draft raised at completion is still waiting when a plan is approved.
    const s3 = await seed('D3', { autoInvoiceOnCompletion: true });
    await completeJob(s3);
    const [autoDraft] = await waitingInvoiceDrafts(s3);
    expect(autoDraft.payload.estimateId).toBe(s3.estimateId);
    const approved3 = await approveAndExecute(s3, await voicePlan(s3, DEPOSIT_THEN_BALANCE, 100000));
    expect(approved3.success).toBe(true);
    const draftResult = await approveAndExecute(s3, autoDraft);
    await dump(s3, 'D3 waiting auto-draft, plan, then approve the draft');
    say('D3 draft_invoice refusal', draftResult.error);
    const rows3 = await invoiceRows(s3);
    expect(rows3.map((r) => [r.invoice_number, r.schedule_id, r.milestone_index, r.total_cents])).toEqual([
      ['INV-0001', approved3.resultEntityId, 0, 50000],
    ]);
    expect(draftResult.success).toBe(false);
    expect(draftResult.error).toMatch(/billed by a milestone plan/);
    // The job was already complete when the plan was set up, so its balance will never mint
    // (pre-existing: completion runs once). The refusal says so, with the amount.
    expect(draftResult.error).toMatch(/\$500\.00 .*not invoiced automatically/);
  });

  it('E — a canceled converted invoice does not block the plan: the plan mints fully', async () => {
    const s = await seed('E');
    const converted = await convert(s);
    expect(converted.status).toBe(201);
    const canceled = await invoicePost(s, `/api/invoices/${converted.body.id}/transition`, { status: 'canceled' });
    expect(canceled.status).toBe(200);
    await waitFor(`SELECT 1 FROM invoices WHERE id = $1 AND status = 'canceled'`, [converted.body.id]); // #1133

    const approved = await approveAndExecute(s, await voicePlan(s, DEPOSIT_THEN_BALANCE, 100000));
    expect(approved.success).toBe(true);
    await completeJob(s);
    await dump(s, 'E canceled conversion then plan');

    const rows = await invoiceRows(s);
    expect(rows.map((r) => [r.invoice_number, r.status, r.schedule_id, r.milestone_index, r.total_cents])).toEqual([
      ['INV-0001', 'canceled', null, null, 100000],
      ['INV-0002', 'draft', approved.resultEntityId, 0, 50000],
      ['INV-0003', 'draft', approved.resultEntityId, 1, 50000],
    ]);
    expect(billed(rows)).toBe(100000);
    const [schedule] = await scheduleRepo.findByJob(s.tenantId, s.jobId);
    expect(schedule.estimateId).toBe(s.estimateId);
  });

  it('F — a void converted invoice that holds a payment refuses the plan, telling the owner to refund or move it', async () => {
    const s = await seed('F');
    const converted = await convert(s);
    const id = converted.body.id;
    expect((await invoicePost(s, `/api/invoices/${id}/issue`, {})).status).toBe(200);
    await waitFor(`SELECT 1 FROM invoices WHERE id = $1 AND status = 'open'`, [id]); // #1133
    expect((await invoicePost(s, `/api/invoices/${id}/payment`, { amountCents: 20000, method: 'cash' })).status).toBe(201);
    await waitFor(`SELECT 1 FROM invoices WHERE id = $1 AND amount_paid_cents = 20000`, [id]); // #1133
    expect((await invoicePost(s, `/api/invoices/${id}/transition`, { status: 'void' })).status).toBe(200);
    await waitFor(`SELECT 1 FROM invoices WHERE id = $1 AND status = 'void'`, [id]); // #1133

    const result = await approveAndExecute(s, await voicePlan(s, DEPOSIT_THEN_BALANCE, 100000));
    await completeJob(s);
    await dump(s, 'F void conversion with a payment then plan');
    say('F plan refusal', result.error);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/INV-0001/);
    expect(result.error).toMatch(/\$200\.00/);
    expect(result.error).toMatch(/[Rr]efund or move that payment/);
    expect(await scheduleRepo.findByJob(s.tenantId, s.jobId)).toEqual([]);
    expect((await invoiceRows(s)).map((r) => [r.invoice_number, r.status, r.schedule_id, r.total_cents, r.amount_paid_cents])).toEqual([
      ['INV-0001', 'void', null, 100000, 20000],
    ]);
  });

  it('G — milestone billing OFF, a plan exists, auto-invoice on: the whole invoice is still drafted and billed (C4)', async () => {
    const s = await seed('G', { milestoneBillingEnabled: false, autoInvoiceOnCompletion: true });
    const approved = await approveAndExecute(s, await voicePlan(s, BOTH_ON_COMPLETION, 100000));
    expect(approved.success).toBe(true);
    await completeJob(s);

    const drafts = await waitingInvoiceDrafts(s);
    expect(drafts.map((d) => d.idempotencyKey)).toEqual([`auto_invoice:${s.jobId}`]);
    expect(drafts[0].payload.estimateId).toBe(s.estimateId);
    // The owner approves it: the draft_invoice handler lets it through (the plan will not bill).
    const result = await approveAndExecute(s, drafts[0]);
    expect(result.success).toBe(true);
    await dump(s, 'G milestone billing off + plan + auto-invoice');

    const rows = await invoiceRows(s);
    expect(rows.map((r) => [r.invoice_number, r.estimate_id, r.schedule_id, r.total_cents])).toEqual([
      ['INV-0001', s.estimateId, null, 100000],
    ]);
    expect(billed(rows)).toBe(100000);
  });

  it('H — a hand-made invoice with no estimate does not block the plan; the approved plan lists it as a warning', async () => {
    const s = await seed('H');
    const fee = await invoicePost(s, '/api/invoices', {
      jobId: s.jobId,
      lineItems: [{ id: crypto.randomUUID(), description: 'Diagnostic fee', quantity: 1, unitPriceCents: 15000, totalCents: 15000, sortOrder: 0, taxable: false }],
    });
    expect(fee.status).toBe(201);
    await waitFor('SELECT 1 FROM invoices WHERE id = $1', [fee.body.id]); // #1133

    const plan = await voicePlan(s, DEPOSIT_THEN_BALANCE, 100000);
    const approved = await approveAndExecute(s, plan);
    expect(approved.success).toBe(true);
    await completeJob(s);
    await dump(s, 'H hand-made invoice then plan');

    const stored = await proposalRepo.findById(s.tenantId, plan.id);
    say('H plan explanation', stored?.explanation);
    expect(stored?.status).toBe('executed');
    expect(stored?.explanation).toMatch(/INV-0001 \(\$150\.00\)/);
    expect(stored?.explanation).toMatch(/not tied to an estimate/);

    const rows = await invoiceRows(s);
    expect(rows.map((r) => [r.invoice_number, r.estimate_id, r.schedule_id, r.milestone_index, r.total_cents])).toEqual([
      ['INV-0001', null, null, null, 15000],
      ['INV-0002', s.estimateId, approved.resultEntityId, 0, 50000],
      ['INV-0003', null, approved.resultEntityId, 1, 50000],
    ]);
    expect(billed(rows.filter((r) => r.schedule_id === approved.resultEntityId))).toBe(100000);
    expect(billed(rows)).toBe(115000);
  });

  it("I — T1: tenant B's plan bills in the same run and is untouched by tenant A's refusal", async () => {
    const tenantB = await seed('I-B', { autoInvoiceOnCompletion: true });
    const b = await approveAndExecute(tenantB, await voicePlan(tenantB, DEPOSIT_THEN_BALANCE, 100000));
    expect(b.success).toBe(true);
    await completeJob(tenantB);
    const bBefore = await invoiceRows(tenantB);
    const bProposalsBefore = (await proposalRepo.findByTenant(tenantB.tenantId)).map((p) => [p.id, p.status]);

    const tenantA = await seed('I-A');
    expect((await convert(tenantA)).status).toBe(201);
    const a = await approveAndExecute(tenantA, await voicePlan(tenantA, DEPOSIT_THEN_BALANCE, 100000));
    await completeJob(tenantA);
    await dump(tenantA, 'I tenant A');
    await dump(tenantB, 'I tenant B');

    expect(a.success).toBe(false);
    expect(billed(await invoiceRows(tenantA))).toBe(100000);
    expect(bBefore.map((r) => [r.milestone_index, r.total_cents])).toEqual([[0, 50000], [1, 50000]]);
    expect(await invoiceRows(tenantB)).toEqual(bBefore);
    expect((await proposalRepo.findByTenant(tenantB.tenantId)).map((p) => [p.id, p.status])).toEqual(bProposalsBefore);
    // Neither tenant reads the other's rows.
    expect(await invoiceRepo.findByJob(tenantB.tenantId, tenantA.jobId)).toEqual([]);
    expect(await invoiceRepo.findByJob(tenantA.tenantId, tenantB.jobId)).toEqual([]);
    expect(await scheduleRepo.findByJob(tenantA.tenantId, tenantB.jobId)).toEqual([]);
  });

  it('J — a voice plan on a job with no single accepted estimate is refused with a reason (no guessing)', async () => {
    // The job's estimate was sent but never accepted; a change order is also drafted on it.
    const s = await seed('J', { estimate: 'sent' });
    await seedEstimate(s, 'EST-1203-J-CO', 30000, 'sent');
    const result = await approveAndExecute(s, await voicePlan(s, DEPOSIT_THEN_BALANCE, 100000));
    await dump(s, 'J no accepted estimate');
    say('J plan refusal', result.error);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no accepted estimate/i);
    expect(await scheduleRepo.findByJob(s.tenantId, s.jobId)).toEqual([]);
    expect(await invoiceRows(s)).toEqual([]);
  });

  it('K1 — a whole invoice that appeared after approval holds the milestones at completion as a ready_for_review draft', async () => {
    // Plan approved while milestone billing is OFF (the plan will not bill, so convert is
    // allowed); the owner then turns milestone billing ON and completes the job.
    const s = await seed('K1', { milestoneBillingEnabled: false });
    const approved = await approveAndExecute(s, await voicePlan(s, BOTH_ON_COMPLETION, 100000));
    expect(approved.success).toBe(true);
    expect((await convert(s)).status).toBe(201);
    await settingsRepo.update(s.tenantId, { milestoneBillingEnabled: true });
    await completeJob(s);
    await dump(s, 'K1 whole invoice then completion');

    // No milestone was minted on top of INV-0001 …
    const rows = await invoiceRows(s);
    expect(rows.map((r) => [r.invoice_number, r.schedule_id, r.total_cents])).toEqual([['INV-0001', null, 100000]]);
    expect(billed(rows)).toBe(100000);
    // … and they were not dropped: the owner has a ready_for_review draft naming what and why.
    const [held] = await waitingInvoiceDrafts(s);
    say('K1 held draft', `${held?.status} | ${held?.summary} | ${held?.explanation}`);
    expect(held.status).toBe('ready_for_review');
    expect(held.idempotencyKey).toBe(`milestone_mint_held:${approved.resultEntityId}`);
    expect(held.payload).not.toHaveProperty('estimateId');
    expect((held.payload.lineItems as Array<{ totalCents: number }>).map((l) => l.totalCents)).toEqual([50000, 50000]);
    expect(held.explanation).toMatch(/INV-0001 \(\$1,000\.00\) already bills that estimate/);
  });

  it('K2 — a void invoice holding a payment holds the milestones with the refund reason; approving the held draft bills exactly them', async () => {
    const s2 = await seed('K2', { milestoneBillingEnabled: false });
    const approved2 = await approveAndExecute(s2, await voicePlan(s2, BOTH_ON_COMPLETION, 100000));
    expect(approved2.success).toBe(true);
    const c2 = await convert(s2);
    expect(c2.status).toBe(201);
    expect((await invoicePost(s2, `/api/invoices/${c2.body.id}/issue`, {})).status).toBe(200);
    await waitFor(`SELECT 1 FROM invoices WHERE id = $1 AND status = 'open'`, [c2.body.id]); // #1133
    expect((await invoicePost(s2, `/api/invoices/${c2.body.id}/payment`, { amountCents: 20000, method: 'cash' })).status).toBe(201);
    await waitFor(`SELECT 1 FROM invoices WHERE id = $1 AND amount_paid_cents = 20000`, [c2.body.id]); // #1133
    expect((await invoicePost(s2, `/api/invoices/${c2.body.id}/transition`, { status: 'void' })).status).toBe(200);
    await waitFor(`SELECT 1 FROM invoices WHERE id = $1 AND status = 'void'`, [c2.body.id]); // #1133
    await settingsRepo.update(s2.tenantId, { milestoneBillingEnabled: true });
    await completeJob(s2);

    const [held2] = await waitingInvoiceDrafts(s2);
    say('K2 held draft', `${held2?.status} | ${held2?.summary} | ${held2?.explanation}`);
    expect(held2.explanation).toMatch(/INV-0001 is void and still holds \$200\.00/);
    expect(held2.explanation).toMatch(/[Rr]efund or move that payment/);
    const executed = await approveAndExecute(s2, held2);
    expect(executed.success).toBe(true);
    await dump(s2, 'K2 void-with-payment then completion, held draft approved');
    const rows2 = await invoiceRows(s2);
    expect(rows2.map((r) => [r.invoice_number, r.status, r.estimate_id, r.schedule_id, r.total_cents, r.amount_paid_cents])).toEqual([
      ['INV-0001', 'void', s2.estimateId, null, 100000, 20000],
      ['INV-0002', 'draft', null, null, 100000, 0],
    ]);
  });
});
