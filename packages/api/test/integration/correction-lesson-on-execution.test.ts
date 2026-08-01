import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgCorrectionLessonRepository } from '../../src/learning/corrections/pg-correction-lesson';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createProposal } from '../../src/proposals/proposal';
import type { ConfigPorts } from '../../src/learning/corrections/lesson-applicator';
import { recordCorrectionLessonsOnExecution } from '../../src/learning/corrections/record-on-execution';

/**
 * U7 integration — drives the NEW onExecuted call site against real Postgres.
 * Pins (a) correction_lessons columns through recordCorrectionLessonsOnExecution
 * and (b) the SETTINGS labor-rate cascade (tenant_settings.labor_rate_cents_per
 * _hour) — a DB path the existing correction-loop test (catalog cascade) didn't
 * cover. The digest reads findAppliedForDay, so a persisted applied lesson is
 * exactly what surfaces in "what I learned".
 */
describe('Postgres integration — correction lessons on execution (U7)', () => {
  let pool: Pool;
  let tenant: { tenantId: string; userId: string };
  let settingsRepo: PgSettingsRepository;
  let lessonRepo: PgCorrectionLessonRepository;
  let auditRepo: PgAuditRepository;
  let catalogRepo: PgCatalogItemRepository;
  let ports: ConfigPorts;
  const proposalId = crypto.randomUUID();
  const executedAt = new Date('2026-06-15T18:00:00Z');

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenant = await createTestTenant(pool);
    settingsRepo = new PgSettingsRepository(pool);
    lessonRepo = new PgCorrectionLessonRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    catalogRepo = new PgCatalogItemRepository(pool);
    const proposalRepo = new PgProposalRepository(pool);
    const executionRepo = new PgProposalExecutionRepository(pool);

    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      businessName: 'Acme',
      timezone: 'America/New_York',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      laborRateCentsPerHour: 11500,
      createdAt: executedAt,
      updatedAt: executedAt,
    });

    // Drafted: labor line at $115. Executed: owner edited it to $135.
    const draft = createProposal({
      tenantId: tenant.tenantId,
      proposalType: 'draft_estimate',
      payload: {
        lineItems: [
          {
            id: 'l1',
            description: 'Standard Labor',
            category: 'labor',
            quantity: 1,
            unitPriceCents: 11500,
            totalCents: 11500,
            sortOrder: 0,
            taxable: true,
          },
        ],
      },
      summary: 'Estimate',
      createdBy: tenant.userId,
    });
    // Pin the id so the execution + lesson link to a known proposal.
    const proposal = { ...draft, id: proposalId };
    await proposalRepo.create(proposal);

    await executionRepo.recordExecution({
      tenantId: tenant.tenantId,
      proposalId,
      executedBy: tenant.userId,
      status: 'succeeded',
      executedAt,
      executedPayload: {
        lineItems: [
          {
            id: 'l1',
            description: 'Standard Labor',
            category: 'labor',
            quantity: 1,
            unitPriceCents: 13500,
            totalCents: 13500,
            sortOrder: 0,
            taxable: true,
          },
        ],
      },
    });

    // Real ports mirroring app.ts: labor rate → tenant_settings.
    ports = {
      async setLaborRateCents(tid, cents) {
        await settingsRepo.update(tid, { laborRateCentsPerHour: cents });
      },
      async setSkuPriceCents(tid, catalogItemId, cents) {
        await catalogRepo.update(tid, catalogItemId, { unitPriceCents: cents });
      },
      async setBannedPhrases(tid, phrases) {
        const cur = await settingsRepo.findByTenant(tid);
        await settingsRepo.update(tid, {
          brandVoice: { ...(cur?.brandVoice ?? {}), banned_phrases: phrases },
        });
      },
      async setTemplateWeight() {
        /* no-op */
      },
    };
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('records an applied labor lesson and cascades the rate into tenant_settings', async () => {
    const proposalRepo = new PgProposalRepository(pool);
    const executionRepo = new PgProposalExecutionRepository(pool);

    const lessons = await recordCorrectionLessonsOnExecution(
      { tenantId: tenant.tenantId, proposalId },
      { proposalRepo, proposalExecutionRepo: executionRepo, settingsRepo, lessonRepo, catalogRepo, ports, auditRepo },
    );

    expect(lessons).toHaveLength(1);
    expect(lessons[0].lessonType).toBe('labor_rate_changed');

    // Persisted with real columns + surfaced for the digest "what I learned".
    const applied = await lessonRepo.findAppliedForDay(tenant.tenantId, '2026-06-15');
    expect(applied.map((l) => l.id)).toContain(lessons[0].id);
    expect(applied[0].payload).toMatchObject({ kind: 'labor_rate_changed', afterCents: 13500 });

    // Audit on apply.
    const audits = await auditRepo.findByEntity(tenant.tenantId, 'correction_lesson', lessons[0].id);
    expect(audits.some((a) => a.eventType === 'correction_lesson.applied')).toBe(true);

    // Forward cascade landed in tenant_settings (the NEW DB path).
    const settings = await settingsRepo.findByTenant(tenant.tenantId);
    expect(settings?.laborRateCentsPerHour).toBe(13500);
  });
});
