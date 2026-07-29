/**
 * B7 (feat: voice-transcript-and-agent-paths) — voice/assistant `update_job`
 * end-to-end against real Postgres.
 *
 * SCOPE OF THIS SUITE — an EXECUTION-SHAPE proof, deliberately. Every case
 * below hands `executeUpdateJob` a HAND-BUILT payload literal, so what it
 * certifies is that UpdateJobExecutionHandler + the production execution
 * registry do the right thing GIVEN an already-resolved jobId: the real
 * jobs.status / jobs.priority / jobs.summary / jobs.problem_description
 * columns, the governed lifecycle transition, the completed_at stamp, the
 * completion effects, the job.updated audit event, and the cross-tenant
 * refusal — the same regression class create-job-execution.test.ts guards for
 * create_job.
 *
 * What a hand-built payload can NEVER show is that a SPOKEN SENTENCE produces
 * that jobId (docs/solutions/test-failures/a-fixture-arranged-to-pass-proves-
 * nothing.md, Rule 3). That is the DRAFTING leg, and it is proven separately
 * in the second describe at the bottom of this file — which drives
 * "Mark the Garcia job complete" through the REAL PgEntityResolver and the
 * REAL UpdateJobTaskHandler. The two suites are complements, not substitutes:
 * neither one alone certifies B7.7.
 *
 * Runs only under `npm run test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgJobTimelineRepository } from '../../src/jobs/pg-job-lifecycle';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import {
  createProposal,
  CreateProposalInput,
  InMemoryProposalRepository,
  missingFieldsFor,
  Proposal,
} from '../../src/proposals/proposal';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { approveProposal } from '../../src/proposals/actions';
import { PgEntityResolver } from '../../src/ai/resolution/pg-entity-resolver';
import { resolveVoiceEntityReferences } from '../../src/ai/agents/customer-calling/entity-resolution';
import { buildTaskHandlers } from '../../src/ai/orchestration/handler-registry';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';
import type { LLMGateway, LLMResponse } from '../../src/ai/gateway/gateway';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionContext,
} from '../../src/proposals/execution/handlers';
import { createJob } from '../../src/jobs/job';
import { transitionJobStatus } from '../../src/jobs/job-lifecycle';
import { createEstimate } from '../../src/estimates/estimate';
import { buildLineItem } from '../../src/shared/billing-engine';

describe('Postgres integration — voice update_job → approve → execute → persist + audit', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;
  let timelineRepo: PgJobTimelineRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let locationId: string;
  let jobId: string;

  async function executeUpdateJob(
    payload: Record<string, unknown>,
    extraDeps: Record<string, unknown> = {},
    who: { tenantId: string; userId: string } = tenant,
  ): Promise<string> {
    // Production registry — proves the registry wires jobRepo + timelineRepo
    // (+ auditRepo) into UpdateJobExecutionHandler so a status change routes
    // through the governed transition (the B7 money-loss fix under test).
    const registry = createExecutionHandlerRegistry({ jobRepo, timelineRepo, auditRepo, ...extraDeps });
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    const input: CreateProposalInput = {
      tenantId: who.tenantId,
      proposalType: 'update_job',
      payload,
      summary: 'Update job from voice',
      createdBy: who.userId,
    };
    let proposal: Proposal = createProposal(input);
    proposal = transitionProposal(proposal, 'ready_for_review', who.userId);
    proposal = transitionProposal(proposal, 'approved', who.userId);
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await proposalRepo.create(proposal);

    const context: ExecutionContext = { tenantId: who.tenantId, executedBy: who.userId };
    const { result } = await executor.execute(proposal, context);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBeDefined();
    return result.resultEntityId as string;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    jobRepo = new PgJobRepository(pool);
    timelineRepo = new PgJobTimelineRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Job',
      lastName: 'Customer',
      displayName: 'Job Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '12 Lakeshore',
      city: 'Cleveland',
      state: 'OH',
      postalCode: '44113',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const job = await createJob(
      {
        tenantId: tenant.tenantId,
        customerId,
        locationId,
        summary: 'No AC, not cooling',
        priority: 'normal',
        createdBy: tenant.userId,
      },
      jobRepo,
    );
    jobId = job.id;

    // Move the job onto the lifecycle (new → scheduled) so the update_job
    // status changes below are VALID governed transitions (new → in_progress
    // is not a legal move once status routes through transitionJobStatus).
    await transitionJobStatus(
      tenant.tenantId,
      jobId,
      'scheduled',
      tenant.userId,
      'owner',
      jobRepo,
      timelineRepo,
      auditRepo,
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('changes the real job row status + priority via the production registry', async () => {
    await executeUpdateJob({ jobId, status: 'in_progress', priority: 'urgent' });

    const { rows } = await pool.query(
      `SELECT status, priority, summary, problem_description FROM jobs WHERE id = $1`,
      [jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('in_progress');
    expect(rows[0].priority).toBe('urgent');
    // Untouched fields survive the partial update.
    expect(rows[0].summary).toBe('No AC, not cooling');
  });

  it('changes the real job row title + description', async () => {
    await executeUpdateJob({
      jobId,
      title: 'No AC, not cooling — 2nd visit',
      description: 'Compressor replaced, monitoring for a week',
    });

    const { rows } = await pool.query(
      `SELECT summary, problem_description FROM jobs WHERE id = $1`,
      [jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe('No AC, not cooling — 2nd visit');
    expect(rows[0].problem_description).toBe('Compressor replaced, monitoring for a week');
  });

  it('emits a job.updated audit event (regression guard for handler+registry audit wiring)', async () => {
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE entity_type = 'job' AND entity_id = $1 AND event_type = 'job.updated'`,
      [jobId],
    );
    const countBefore = before.rows[0].n as number;

    await executeUpdateJob({ jobId, status: 'completed' });

    const after = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE entity_type = 'job' AND entity_id = $1 AND event_type = 'job.updated'`,
      [jobId],
    );
    expect(after.rows[0].n as number).toBe(countBefore + 1);
  });

  it('does not expose the job to another tenant (scoped read) and a cross-tenant jobId fails cleanly', async () => {
    const other = await createTestTenant(pool);
    const found = await jobRepo.findById(other.tenantId, jobId);
    expect(found).toBeNull();

    const registry = createExecutionHandlerRegistry({ jobRepo, auditRepo });
    const handler = registry.get('update_job')!;
    const result = await handler.execute(
      {
        id: crypto.randomUUID(),
        tenantId: other.tenantId,
        proposalType: 'update_job',
        status: 'approved',
        payload: { jobId, status: 'canceled' },
        summary: 'cross-tenant attempt',
        createdBy: other.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Proposal,
      { tenantId: other.tenantId, executedBy: other.userId },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);

    // The row is untouched — no cross-tenant write leaked through.
    const { rows } = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
    expect(rows[0].status).not.toBe('canceled');
  });

  it('a completed transition stamps completed_at AND runs completion effects (auto-drafts an invoice proposal)', async () => {
    // Isolated tenant so its settings + money-state don't touch the shared job.
    const t = await createTestTenant(pool);
    const custId = crypto.randomUUID();
    await new PgCustomerRepository(pool).create({
      id: custId,
      tenantId: t.tenantId,
      firstName: 'Furnace',
      lastName: 'Owner',
      displayName: 'Furnace Owner',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locId = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: locId,
      tenantId: t.tenantId,
      customerId: custId,
      street1: '9 Furnace Ln',
      city: 'Akron',
      state: 'OH',
      postalCode: '44301',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Opt the tenant into auto-invoice-on-completion. The create INSERT does
    // not carry the toggle column, so set it via update (which does).
    const settingsRepo = new PgSettingsRepository(pool);
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: t.tenantId,
      businessName: 'Akron Heating',
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await settingsRepo.update(t.tenantId, { autoInvoiceOnCompletion: true });

    const estimateRepo = new PgEstimateRepository(pool);
    const invoiceRepo = new PgInvoiceRepository(pool);
    // The auto-invoice effect raises a draft_invoice PROPOSAL (never an
    // auto-approved invoice); capture it in a repo we can assert on.
    const completionProposalRepo = new InMemoryProposalRepository();

    const job = await createJob(
      {
        tenantId: t.tenantId,
        customerId: custId,
        locationId: locId,
        summary: 'Furnace swap',
        priority: 'normal',
        createdBy: t.userId,
      },
      jobRepo,
    );

    // Accepted estimate + eligible money-state → the job is billable.
    const est = await createEstimate(
      {
        tenantId: t.tenantId,
        jobId: job.id,
        estimateNumber: 'EST-1',
        lineItems: [buildLineItem('l1', 'Furnace', 1, 250000, 0, true)],
        createdBy: t.userId,
      },
      estimateRepo,
    );
    await estimateRepo.update(t.tenantId, est.id, { status: 'accepted' });
    await jobRepo.update(t.tenantId, job.id, { moneyState: 'estimate_accepted', updatedAt: new Date() });

    // Advance to in_progress via governed transitions so completion is a legal move.
    await transitionJobStatus(t.tenantId, job.id, 'scheduled', t.userId, 'owner', jobRepo, timelineRepo, auditRepo);
    await transitionJobStatus(t.tenantId, job.id, 'in_progress', t.userId, 'owner', jobRepo, timelineRepo, auditRepo);

    // Approve + execute the completion through the PRODUCTION registry with the
    // completion deps wired — the money-loss fix's happy path.
    await executeUpdateJob(
      { jobId: job.id, status: 'completed' },
      { estimateRepo, invoiceRepo, settingsRepo, proposalRepo: completionProposalRepo },
      t,
    );

    // 1. completed_at stamped by the governed transition (drives the sweeps).
    const { rows } = await pool.query(
      `SELECT status, completed_at FROM jobs WHERE id = $1`,
      [job.id],
    );
    expect(rows[0].status).toBe('completed');
    expect(rows[0].completed_at).not.toBeNull();

    // 2. Completion effect auto-drafted the invoice proposal (mirrors
    //    maybeAutoInvoiceOnCompletion coverage — the voice path now invoices
    //    just like the route).
    const drafted = await completionProposalRepo.findByTenant(t.tenantId);
    expect(drafted.some((p) => p.proposalType === 'draft_invoice')).toBe(true);
  });
});

/**
 * B7.7 — "Mark the Garcia job complete" — the DRAFTING leg, against real
 * Postgres.
 *
 * The suite above proves EXECUTION given a resolved jobId. It cannot prove
 * that a spoken sentence produces one, because it hands the handler a
 * hand-built payload literal. Before this file existed, NO integration test
 * anywhere imported UpdateJobTaskHandler at all, and the only way its gate
 * could lift was `buildUserMessage` pasting `existingEntities` into the LLM
 * prompt as a "Classifier hints" blob and the model choosing to echo the UUID
 * back inside its JSON. A drafting leg that depends on a model repeating an id
 * is not resolution.
 *
 * This certifies the real chain against real rows:
 *   the SPOKEN reference "the Garcia job"
 *     → REAL PgEntityResolver via resolveVoiceEntityReferences (update_job is
 *       in JOB_REF_INTENTS), which reaches the job through
 *       jobs.customer_id → customers.display_name — the job's own summary is
 *       ordinary work text ("AC repair") and contains no name at all
 *     → REAL UpdateJobTaskHandler, built by the PRODUCTION `buildTaskHandlers`
 *       registry (the same one the voice worker and assistant chat use), whose
 *       resolveJobIdGate VERIFIES the resolved id against PgJobRepository
 *       before trusting it
 *     → production approveProposal (proposals/actions.ts)
 *     → production execution registry + ProposalExecutor
 *     → the persisted jobs.status / completed_at, plus the job.updated and
 *       job.status_changed audit events.
 *
 * NON-VACUITY, three ways (Rule 3 of docs/solutions/test-failures/
 * a-fixture-arranged-to-pass-proves-nothing.md):
 *  1. The scripted drafting reply carries a HALLUCINATED jobId. The assertion
 *     `payload.jobId === the seeded job` can therefore only pass if resolution
 *     BEAT the model — echoing would fail it.
 *  2. Nothing in jobs.summary / jobs.job_number contains the customer's name,
 *     so `findByTenant({ search })` — the ILIKE path resolveTargetJob falls
 *     back to — cannot reach this row at all. Pinned by its own test.
 *  3. A prefix-decoy customer ("Marco Garcialopez", with his own job) is
 *     seeded, so a resolver that matched loosely would go ambiguous, not
 *     green.
 *
 * Runs only under `npm run test:integration`.
 */

/** The customer as the tenant has them on file. Nobody says this out loud. */
const B77_CUSTOMER_DISPLAY_NAME = 'Jamie Garcia';
/** What the operator actually SAYS — and all the classifier can extract. */
const B77_SPOKEN_REFERENCE = 'the Garcia job';
/**
 * The job's OWN text: what the work is, which is how operators title jobs.
 * The customer's name is deliberately absent — planting it here is exactly
 * the arrangement the solutions doc calls a defect report.
 */
const B77_JOB_SUMMARY = 'AC repair';
/**
 * A UUID the "model" invents. Never seeded, so if this ever reaches the
 * payload the gate has been lifted by an LLM echo rather than by resolution.
 */
const B77_HALLUCINATED_JOB_ID = '00000000-0000-4000-8000-0000b77fa11e';

describe('Postgres integration — B7.7 drafting leg: spoken "Mark the Garcia job complete" → resolve → draft → approve → execute', () => {
  let pool: Pool;
  let jobRepo: PgJobRepository;
  let timelineRepo: PgJobTimelineRepository;
  let auditRepo: PgAuditRepository;
  let proposalRepo: PgProposalRepository;
  let executor: ProposalExecutor;
  let tenant: { tenantId: string; userId: string };
  let garciaJobId: string;
  /** Seeded at 'scheduled' — completing it is an ILLEGAL lifecycle move. */
  let ramanJobId: string;
  let locationId: string;

  /**
   * A drafting reply shaped like the real model's: it names the job in FREE
   * TEXT and, deliberately, hallucinates a jobId. Resolution has to win.
   */
  function scriptedGateway(overrides: Record<string, unknown> = {}): LLMGateway {
    return {
      complete: vi.fn(
        async (): Promise<LLMResponse> => ({
          content: JSON.stringify({
            jobReference: B77_SPOKEN_REFERENCE,
            jobId: B77_HALLUCINATED_JOB_ID,
            status: 'completed',
            confidence_score: 0.93,
            ...overrides,
          }),
          model: 'scripted',
          provider: 'scripted',
          tokenUsage: { input: 120, output: 40, total: 160 },
          latencyMs: 12,
        }),
      ),
    } as unknown as LLMGateway;
  }

  async function seedCustomerWithJob(input: {
    firstName: string;
    lastName: string;
    displayName: string;
    summary: string;
    jobNumber: string;
    advanceTo: 'scheduled' | 'in_progress';
  }): Promise<string> {
    const custId = crypto.randomUUID();
    await new PgCustomerRepository(pool).create({
      id: custId,
      tenantId: tenant.tenantId,
      firstName: input.firstName,
      lastName: input.lastName,
      displayName: input.displayName,
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const job = await jobRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      customerId: custId,
      locationId,
      jobNumber: input.jobNumber,
      summary: input.summary,
      status: 'new',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Governed transitions only — the lifecycle is the same one the voice
    // path will have to satisfy at execution time.
    await transitionJobStatus(
      tenant.tenantId, job.id, 'scheduled', tenant.userId, 'owner', jobRepo, timelineRepo, auditRepo,
    );
    if (input.advanceTo === 'in_progress') {
      await transitionJobStatus(
        tenant.tenantId, job.id, 'in_progress', tenant.userId, 'owner', jobRepo, timelineRepo, auditRepo,
      );
    }
    return job.id;
  }

  /**
   * The production drafting path for one spoken sentence: REAL resolver, then
   * the REAL handler out of the production task registry.
   */
  async function draftFromSpeech(
    spoken: string,
    who: { tenantId: string; userId: string } = tenant,
  ): Promise<{ resolvedJobId: string | undefined; proposal: Proposal }> {
    const routed = await resolveVoiceEntityReferences(new PgEntityResolver(pool), {
      tenantId: who.tenantId,
      intent: 'update_job',
      entities: { jobReference: spoken },
    });
    const resolvedJobId = routed.kind === 'ok' ? routed.resolved.jobId : undefined;

    const handlers = buildTaskHandlers({ gateway: scriptedGateway(), jobRepo });
    const context: TaskContext = {
      tenantId: who.tenantId,
      userId: who.userId,
      message: `Mark ${spoken} complete`,
      existingEntities: { jobReference: spoken, ...(resolvedJobId ? { jobId: resolvedJobId } : {}) },
      // Unsupervised tenant — auto-approval is hard-blocked, so the proposal
      // waits for the human tap this test then performs through the
      // production approveProposal. Nothing here touches the jobId gate.
      supervisorPresent: false,
    };
    const { proposal } = await handlers.get('update_job')!.handle(context);
    return { resolvedJobId, proposal };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    jobRepo = new PgJobRepository(pool);
    timelineRepo = new PgJobTimelineRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    tenant = await createTestTenant(pool);

    const anchorCustomerId = crypto.randomUUID();
    await new PgCustomerRepository(pool).create({
      id: anchorCustomerId,
      tenantId: tenant.tenantId,
      firstName: 'Site',
      lastName: 'Anchor',
      displayName: 'Site Anchor',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    locationId = crypto.randomUUID();
    await new PgLocationRepository(pool).create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId: anchorCustomerId,
      street1: '84 Sycamore',
      city: 'Toledo',
      state: 'OH',
      postalCode: '43604',
      country: 'USA',
      addressType: 'service',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // The job the operator means. Summary is plain work text.
    garciaJobId = await seedCustomerWithJob({
      firstName: 'Jamie',
      lastName: 'Garcia',
      displayName: B77_CUSTOMER_DISPLAY_NAME,
      summary: B77_JOB_SUMMARY,
      jobNumber: 'JOB-B77-0001',
      advanceTo: 'in_progress',
    });

    // Prefix decoy — a real customer who merely SHARES A PREFIX. A loose
    // matcher would make the spoken surname ambiguous instead of resolved.
    await seedCustomerWithJob({
      firstName: 'Marco',
      lastName: 'Garcialopez',
      displayName: 'Marco Garcialopez',
      summary: 'Thermostat swap',
      jobNumber: 'JOB-B77-0002',
      advanceTo: 'in_progress',
    });

    // A second real job, left at 'scheduled' so "complete it" is an ILLEGAL
    // lifecycle move (scheduled → dispatched | in_progress | canceled).
    ramanJobId = await seedCustomerWithJob({
      firstName: 'Priya',
      lastName: 'Raman',
      displayName: 'Priya Raman',
      summary: 'Water heater flush',
      jobNumber: 'JOB-B77-0003',
      advanceTo: 'scheduled',
    });

    const registry = createExecutionHandlerRegistry({ jobRepo, timelineRepo, auditRepo });
    const guard = new IdempotencyGuard(new PgProposalExecutionRepository(pool), proposalRepo);
    executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('the ILIKE display-text search CANNOT reach this job from the spoken name — only the customer traversal can', async () => {
    // findByTenant's `search` reads (summary ILIKE … OR job_number ILIKE …)
    // only. Neither carries the customer's name, so the fallback path inside
    // resolveTargetJob is a dead end here. This is what makes the drafting
    // proof below non-vacuous.
    const bySurname = await jobRepo.findByTenant(tenant.tenantId, { search: 'Garcia', limit: 5 });
    expect(bySurname).toHaveLength(0);
    const bySpoken = await jobRepo.findByTenant(tenant.tenantId, {
      search: B77_SPOKEN_REFERENCE,
      limit: 5,
    });
    expect(bySpoken).toHaveLength(0);

    // …and the job really is stored with plain work text.
    const { rows } = await pool.query(`SELECT summary FROM jobs WHERE id = $1`, [garciaJobId]);
    expect(rows[0].summary).toBe(B77_JOB_SUMMARY);
  });

  it('the REAL resolver reaches the job from the spoken surname, past a prefix decoy', async () => {
    const routed = await resolveVoiceEntityReferences(new PgEntityResolver(pool), {
      tenantId: tenant.tenantId,
      intent: 'update_job',
      entities: { jobReference: B77_SPOKEN_REFERENCE },
    });
    expect(routed.kind).toBe('ok');
    expect(routed.kind === 'ok' ? routed.resolved.jobId : undefined).toBe(garciaJobId);
  });

  it('drafting: the RESOLVER id lands on the payload and lifts the gate — the model\'s hallucinated id loses', async () => {
    const { resolvedJobId, proposal } = await draftFromSpeech(B77_SPOKEN_REFERENCE);

    expect(resolvedJobId).toBe(garciaJobId);
    expect(proposal.proposalType).toBe('update_job');
    const payload = proposal.payload as Record<string, unknown>;
    // The load-bearing assertion: the id the test never handed the handler
    // directly, and could not have come from the scripted reply.
    expect(payload.jobId).toBe(garciaJobId);
    expect(payload.jobId).not.toBe(B77_HALLUCINATED_JOB_ID);
    expect(payload.status).toBe('completed');
    // Gate lifted, and the repo-verified id rides the B4 allowlist so
    // assistant.ts's dropUnverifiedIds can't scrub it back out.
    expect(missingFieldsFor(proposal)).toEqual([]);
    expect((proposal.sourceContext as Record<string, unknown>).verifiedIds).toEqual({
      jobId: garciaJobId,
    });
  });

  it('end to end: the drafted proposal approves and the REAL job row completes, with both audit events', async () => {
    const { proposal: drafted } = await draftFromSpeech(B77_SPOKEN_REFERENCE);
    await proposalRepo.create(drafted);

    // Production approval helper — the gate is what it would refuse.
    const approved = await approveProposal(
      proposalRepo,
      tenant.tenantId,
      drafted.id,
      tenant.userId,
      'owner',
      auditRepo,
      'ui',
    );
    expect(approved.status).toBe('approved');

    const backdated: Proposal = {
      ...approved,
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    };
    const context: ExecutionContext = {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
    };
    const { result } = await executor.execute(backdated, context);
    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(garciaJobId);

    // The persisted row — the whole point of the Docker gate.
    const { rows } = await pool.query(
      `SELECT status, completed_at FROM jobs WHERE id = $1`,
      [garciaJobId],
    );
    expect(rows[0].status).toBe('completed');
    expect(rows[0].completed_at).not.toBeNull();

    // Audit: the consolidated edit event…
    const updated = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE entity_type = 'job' AND entity_id = $1 AND event_type = 'job.updated'`,
      [garciaJobId],
    );
    expect(updated.rows[0].n as number).toBeGreaterThanOrEqual(1);
    // …and the governed transition's own event.
    const changed = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE entity_type = 'job' AND entity_id = $1 AND event_type = 'job.status_changed'`,
      [garciaJobId],
    );
    expect(changed.rows[0].n as number).toBeGreaterThanOrEqual(1);
  });

  it('an ILLEGAL lifecycle move is REFUSED end to end — a resolved job is not a licence to skip the state machine', async () => {
    // "Mark the Raman job complete" resolves and drafts exactly as above, but
    // that job is 'scheduled': JOB_STATUS_TRANSITIONS.scheduled has no
    // 'completed'. The refusal must survive drafting AND approval and land at
    // execution, with the row untouched.
    const { resolvedJobId, proposal: drafted } = await draftFromSpeech('the Raman job');
    expect(resolvedJobId).toBe(ramanJobId);
    expect((drafted.payload as Record<string, unknown>).jobId).toBe(ramanJobId);
    expect(missingFieldsFor(drafted)).toEqual([]);

    await proposalRepo.create(drafted);
    const approved = await approveProposal(
      proposalRepo,
      tenant.tenantId,
      drafted.id,
      tenant.userId,
      'owner',
      auditRepo,
      'ui',
    );
    const { result } = await executor.execute(
      { ...approved, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) },
      { tenantId: tenant.tenantId, executedBy: tenant.userId },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid transition from scheduled to completed/i);

    const { rows } = await pool.query(
      `SELECT status, completed_at FROM jobs WHERE id = $1`,
      [ramanJobId],
    );
    expect(rows[0].status).toBe('scheduled');
    expect(rows[0].completed_at).toBeNull();
  });

  it('cross-tenant: the same sentence resolves to nothing for another tenant, and a borrowed jobId stays GATED', async () => {
    const other = await createTestTenant(pool);

    // 1. Resolution is tenant-scoped — no Garcia exists over there.
    const routed = await resolveVoiceEntityReferences(new PgEntityResolver(pool), {
      tenantId: other.tenantId,
      intent: 'update_job',
      entities: { jobReference: B77_SPOKEN_REFERENCE },
    });
    expect(routed.kind).toBe('ok');
    expect(routed.kind === 'ok' ? routed.resolved.jobId : undefined).toBeUndefined();

    // 2. Drafting for that tenant leaves the proposal gated and un-approvable.
    const { resolvedJobId, proposal } = await draftFromSpeech(B77_SPOKEN_REFERENCE, other);
    expect(resolvedJobId).toBeUndefined();
    expect((proposal.payload as Record<string, unknown>).jobId).toBeUndefined();
    expect(missingFieldsFor(proposal)).toEqual(['jobId']);
    await proposalRepo.create(proposal);
    await expect(
      approveProposal(proposalRepo, other.tenantId, proposal.id, other.userId, 'owner'),
    ).rejects.toThrow(/unfilled required fields/);

    // 3. Even handed this tenant's real jobId, the OTHER tenant's draft is
    //    gated: verification runs inside the drafting tenant's scope, so a
    //    borrowed id can never be confirmed.
    const handlers = buildTaskHandlers({ gateway: scriptedGateway(), jobRepo });
    const { proposal: borrowed } = await handlers.get('update_job')!.handle({
      tenantId: other.tenantId,
      userId: other.userId,
      message: `Mark ${B77_SPOKEN_REFERENCE} complete`,
      existingEntities: { jobReference: B77_SPOKEN_REFERENCE, jobId: garciaJobId },
      supervisorPresent: false,
    });
    expect((borrowed.payload as Record<string, unknown>).jobId).toBeUndefined();
    expect(missingFieldsFor(borrowed)).toEqual(['jobId']);
    expect(borrowed.sourceContext ?? {}).not.toHaveProperty('verifiedIds');
  });
});
