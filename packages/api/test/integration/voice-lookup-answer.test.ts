/**
 * U3 (iOS blueprint) — E-lane answer persistence on REAL columns.
 *
 * Pins migration 259 (voice_recordings.answer_status + answer) and the
 * PgVoiceRepository answer paths against a real Postgres:
 *   - the two-phase poll contract (status='completed' coexists with
 *     answerStatus='pending' until the router stamps an outcome),
 *   - write-once semantics (a terminal outcome can't be clobbered by a
 *     redelivered stamp; 'failed' stays writable for the retry path),
 *   - tenant isolation on the new columns,
 *   - the answer_status CHECK constraint.
 *
 * CLAUDE.md: tests that mock the DB are never the only proof a query
 * works — the worker-level tests use InMemoryVoiceRepository, so the
 * real column names/JSONB round-trip are pinned here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import type { VoiceLookupAnswer } from '@ai-service-os/shared';
import { getSharedTestDb, createTestTenant, createTestFile, closeSharedTestDb } from './shared';
import { PgVoiceRepository } from '../../src/voice/pg-voice';
import { createVoiceRecording } from '../../src/voice/voice-service';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { createJob } from '../../src/jobs/job';
import { createInvoice } from '../../src/invoices/invoice';
import { buildLineItem } from '../../src/shared/billing-engine';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { executeLookupAnswer } from '../../src/workers/voice-lookup-answer';

const ANSWER: VoiceLookupAnswer = {
  version: 1,
  intent: 'lookup_balance',
  result: 'found',
  summary: 'Your current balance is $123.00 across 2 open invoices.',
  rows: [
    { kind: 'money', label: 'Outstanding balance', amountCents: 12300 },
    { kind: 'count', label: 'Open invoices', count: 2 },
  ],
  entityRef: { kind: 'customer', id: '3b6cbf1a-bd8a-45f7-8b84-ce6b43a231d1' },
};

describe('Postgres integration — voice lookup answers (U3)', () => {
  let pool: Pool;
  let voiceRepo: PgVoiceRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    voiceRepo = new PgVoiceRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedRecording() {
    const fileId = await createTestFile(pool, tenant.tenantId, tenant.userId);
    return voiceRepo.create(
      createVoiceRecording({
        tenantId: tenant.tenantId,
        fileId,
        createdBy: tenant.userId,
      }),
    );
  }

  it('creates the in-app memo with answerStatus=pending on the real column', async () => {
    const recording = await seedRecording();
    expect(recording.answerStatus).toBe('pending');
    expect(recording.answer).toBeUndefined();

    const found = await voiceRepo.findById(tenant.tenantId, recording.id);
    expect(found?.answerStatus).toBe('pending');
  });

  it('holds the two-phase contract: completed + answerStatus=pending, then answered', async () => {
    const recording = await seedRecording();

    // Phase 1 — transcription completes BEFORE the router job even runs.
    const completed = await voiceRepo.updateStatus(tenant.tenantId, recording.id, 'completed', {
      transcript: 'what is my balance',
    });
    expect(completed?.status).toBe('completed');
    expect(completed?.answerStatus).toBe('pending');

    // Phase 2 — the router stamps the routed outcome + JSONB answer.
    const answered = await voiceRepo.recordAnswer(tenant.tenantId, recording.id, {
      answerStatus: 'answered',
      answer: ANSWER,
    });
    expect(answered?.answerStatus).toBe('answered');
    expect(answered?.answer).toEqual(ANSWER);

    // Round-trip through a fresh read: JSONB shape (incl. integer cents)
    // survives the real column.
    const reread = await voiceRepo.findById(tenant.tenantId, recording.id);
    expect(reread?.status).toBe('completed');
    expect(reread?.answerStatus).toBe('answered');
    expect(reread?.answer).toEqual(ANSWER);
  });

  it('is write-once: a redelivered stamp cannot clobber a terminal outcome', async () => {
    const recording = await seedRecording();

    const first = await voiceRepo.recordAnswer(tenant.tenantId, recording.id, {
      answerStatus: 'proposal',
    });
    expect(first?.answerStatus).toBe('proposal');

    // Redelivery races land on the guard and match zero rows.
    const second = await voiceRepo.recordAnswer(tenant.tenantId, recording.id, {
      answerStatus: 'answered',
      answer: ANSWER,
    });
    expect(second).toBeNull();

    const reread = await voiceRepo.findById(tenant.tenantId, recording.id);
    expect(reread?.answerStatus).toBe('proposal');
    expect(reread?.answer).toBeUndefined();
  });

  it("keeps 'failed' writable so a transcription retry can land a fresh outcome", async () => {
    const recording = await seedRecording();

    await voiceRepo.recordAnswer(tenant.tenantId, recording.id, { answerStatus: 'failed' });
    const retried = await voiceRepo.recordAnswer(tenant.tenantId, recording.id, {
      answerStatus: 'answered',
      answer: ANSWER,
    });
    expect(retried?.answerStatus).toBe('answered');
    expect(retried?.answer).toEqual(ANSWER);
  });

  it('tenant-isolates the answer write and read', async () => {
    const recording = await seedRecording();
    const otherTenant = await createTestTenant(pool);

    // Cross-tenant write: no row matched, nothing persisted.
    const crossWrite = await new PgVoiceRepository(pool).recordAnswer(
      otherTenant.tenantId,
      recording.id,
      { answerStatus: 'answered', answer: ANSWER },
    );
    expect(crossWrite).toBeNull();

    // Cross-tenant read: invisible.
    const crossRead = await voiceRepo.findById(otherTenant.tenantId, recording.id);
    expect(crossRead).toBeNull();

    // Same-tenant state untouched by the failed cross-tenant write.
    const sameRead = await voiceRepo.findById(tenant.tenantId, recording.id);
    expect(sameRead?.answerStatus).toBe('pending');
    expect(sameRead?.answer).toBeUndefined();
  });

  it('rejects an out-of-enum answer_status at the DB (CHECK constraint)', async () => {
    const recording = await seedRecording();
    await expect(
      pool.query(
        `UPDATE voice_recordings SET answer_status = 'bogus'
          WHERE id = $1 AND tenant_id = $2`,
        [recording.id, tenant.tenantId],
      ),
    ).rejects.toThrow(/check constraint/i);
  });
});

/**
 * #1019 6.7 (G1 4, T1 → T2) — "As M, I want to ask for my numbers out loud
 * and hear them." Every test above round-trips a HAND-BUILT `ANSWER`
 * literal — real for the JSONB column, but never a real COMPUTED number.
 * This suite drives `executeLookupAnswer` (the production entry point the
 * router calls) against REAL invoice data for TWO tenants with DIFFERENT
 * outstanding balances, in ONE run, and persists each through the same
 * two-phase `recordAnswer` contract above — proving neither tenant ever
 * hears the other's figure, not merely that each hears "a" figure.
 *
 * T2, NOT T3 (review follow-up, chatgpt-codex-connector on PR #1048): the
 * PRD's own tenant-grade legend (docs/PRD-v5-as-built.md, "The tenant grade
 * — the second half of the definition of done") defines T2 as "a second
 * tenant's data does not change the first's answer — aggregates,
 * availability, selection, counters" and reserves T3 for two tenants with
 * DIFFERENT SETTINGS each producing their own correct result (the Phoenix
 * timezone case is the canonical example). The two tenants below differ
 * only in DATA (their invoice balances) — an aggregate non-interference
 * proof, textbook T2 — not in any per-tenant CONFIGURATION, so this is not
 * a T3 claim. A genuine T3 upgrade here would need a per-tenant setting
 * that changes the ANSWER's shape (e.g. two different tenant timezones
 * changing `oldestDueDate`'s rendered day), which this suite does not add.
 */
describe('Postgres integration — lookup_balance speaks each tenant\'s OWN numbers (#1019 6.7, T2)', () => {
  let pool: Pool;
  let voiceRepo: PgVoiceRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    voiceRepo = new PgVoiceRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** Seeds a tenant with one customer, one job, and one OPEN invoice for `amountDueCents`. */
  async function seedTenantWithBalance(amountDueCents: number) {
    const t = await createTestTenant(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const invoiceRepo = new PgInvoiceRepository(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Balance',
      lastName: 'Customer',
      displayName: 'Balance Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '1 Balance Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const job = await createJob(
      {
        tenantId: t.tenantId,
        customerId,
        locationId,
        summary: 'Balance test job',
        priority: 'normal',
        createdBy: t.userId,
      },
      jobRepo,
    );

    const invoice = await createInvoice(
      {
        tenantId: t.tenantId,
        jobId: job.id,
        invoiceNumber: `INV-${crypto.randomUUID().slice(0, 8)}`,
        lineItems: [buildLineItem('li-1', 'Labor', 1, amountDueCents, 0, false, 'labor')],
        createdBy: t.userId,
      },
      invoiceRepo,
    );
    await invoiceRepo.update(t.tenantId, invoice.id, {
      status: 'open',
      issuedAt: new Date(),
      dueDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      amountDueCents,
    });

    return { ...t, customerId, jobRepo, invoiceRepo };
  }

  it('two tenants with different balances each hear their own figure, in one run', async () => {
    // Deliberately far apart so a cross-tenant mix-up (e.g. an un-scoped
    // query aggregating BOTH tenants' invoices) fails loudly rather than
    // by a rounding coincidence.
    const tenantA = await seedTenantWithBalance(45_00);
    const tenantB = await seedTenantWithBalance(9_999_00);

    const [answerA, answerB] = await Promise.all([
      executeLookupAnswer(
        { tenantId: tenantA.tenantId, sessionId: crypto.randomUUID(), intent: 'lookup_balance', customerId: tenantA.customerId },
        { invoiceRepo: tenantA.invoiceRepo },
        { jobRepo: tenantA.jobRepo, proposalRepo: new InMemoryProposalRepository() },
      ),
      executeLookupAnswer(
        { tenantId: tenantB.tenantId, sessionId: crypto.randomUUID(), intent: 'lookup_balance', customerId: tenantB.customerId },
        { invoiceRepo: tenantB.invoiceRepo },
        { jobRepo: tenantB.jobRepo, proposalRepo: new InMemoryProposalRepository() },
      ),
    ]);

    expect(answerA.kind).toBe('answer');
    expect(answerB.kind).toBe('answer');
    if (answerA.kind !== 'answer' || answerB.kind !== 'answer') return;

    const moneyRow = (a: typeof answerA.answer) =>
      a.rows.find((r): r is Extract<typeof r, { kind: 'money' }> => r.kind === 'money');

    expect(moneyRow(answerA.answer)?.amountCents).toBe(45_00);
    expect(moneyRow(answerB.answer)?.amountCents).toBe(9_999_00);
    // The sharpest form of the claim: NEITHER tenant's figure equals the
    // other's — a swapped-tenant bug would otherwise still pass two
    // independent "some number came back" assertions.
    expect(moneyRow(answerA.answer)?.amountCents).not.toBe(moneyRow(answerB.answer)?.amountCents);

    // Persist through the SAME real column + two-phase contract the rest
    // of this file pins, then re-read: each tenant's stored JSONB answer
    // still carries only its own figure.
    const recA = await voiceRepo.create(
      createVoiceRecording({
        tenantId: tenantA.tenantId,
        fileId: await createTestFile(pool, tenantA.tenantId, tenantA.userId),
        createdBy: tenantA.userId,
      }),
    );
    const recB = await voiceRepo.create(
      createVoiceRecording({
        tenantId: tenantB.tenantId,
        fileId: await createTestFile(pool, tenantB.tenantId, tenantB.userId),
        createdBy: tenantB.userId,
      }),
    );
    await voiceRepo.recordAnswer(tenantA.tenantId, recA.id, {
      answerStatus: 'answered',
      answer: answerA.answer,
    });
    await voiceRepo.recordAnswer(tenantB.tenantId, recB.id, {
      answerStatus: 'answered',
      answer: answerB.answer,
    });

    const rereadA = await voiceRepo.findById(tenantA.tenantId, recA.id);
    const rereadB = await voiceRepo.findById(tenantB.tenantId, recB.id);
    expect(moneyRow(rereadA!.answer as typeof answerA.answer)?.amountCents).toBe(45_00);
    expect(moneyRow(rereadB!.answer as typeof answerB.answer)?.amountCents).toBe(9_999_00);

    // And, per the sibling suite's own convention above: cross-tenant read
    // of the OTHER tenant's recording is invisible outright.
    expect(await voiceRepo.findById(tenantB.tenantId, recA.id)).toBeNull();
    expect(await voiceRepo.findById(tenantA.tenantId, recB.id)).toBeNull();
  });
});
