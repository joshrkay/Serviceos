import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgEstimateTemplateRepository } from '../../src/templates/pg-estimate-template';
import {
  OnboardingTenantSettingsExecutionHandler,
  OnboardingScheduleExecutionHandler,
} from '../../src/proposals/execution/onboarding-handlers';
import { loadOnboardingFacts } from '../../src/onboarding/load-facts';
import { deriveOnboardingStatus } from '../../src/onboarding/derive-status';
import { createProposal } from '../../src/proposals/proposal';
import { createMockLLMGateway } from '../../src/ai/gateway/factory';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

// Full-pipeline mock LLM response — every extractor reads the fields it needs.
const FULL_RESPONSE = JSON.stringify({
  business_name: "Bob's HVAC",
  city: 'Austin',
  state: 'TX',
  verticals: [{ type: 'hvac', confidence: 0.95, source_text: 'HVAC' }],
  service_descriptions: ['AC repair'],
  categories: [
    { vertical_type: 'hvac', category_id: 'repair', name: 'AC Repair', confidence: 0.9, source_text: 'AC repair' },
  ],
  prices: [
    { service_ref: 'AC Repair', amount_cents: 8900, price_type: 'exact', confidence: 0.9, source_text: '$89' },
  ],
  members: [{ name: 'Marcus', inferred_role: 'technician', confidence: 0.9, source_text: 'Marcus' }],
  working_hours: [
    { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start_time: '08:00', end_time: '17:00' },
  ],
  sla: null,
  confidence_score: 0.88,
});

describe('voice-first onboarding (integration)', () => {
  let pool: Pool;
  let app: express.Express;
  let settingsRepo: PgSettingsRepository;
  let packActivationRepo: PgPackActivationRepository;
  let auditRepo: PgAuditRepository;
  let proposalRepo: PgProposalRepository;
  let catalogRepo: PgCatalogItemRepository;
  let templateRepo: PgEstimateTemplateRepository;
  let currentTenant: { tenantId: string; userId: string };
  const mock = createMockLLMGateway();

  beforeAll(async () => {
    pool = await getSharedTestDb();
    settingsRepo = new PgSettingsRepository(pool);
    packActivationRepo = new PgPackActivationRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    catalogRepo = new PgCatalogItemRepository(pool);
    templateRepo = new PgEstimateTemplateRepository(pool);

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: currentTenant.userId,
        sessionId: 'sess-test',
        tenantId: currentTenant.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use(
      '/api/onboarding',
      createOnboardingRouter({
        settingsRepo,
        packActivationRepo,
        auditRepo,
        pool,
        gateway: mock.gateway,
        proposalRepo,
      }),
    );
  });

  beforeEach(async () => {
    currentTenant = await createTestTenant(pool);
    mock.provider.setDefaultResponse(FULL_RESPONSE);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('POST /voice persists extracted onboarding_* proposals for approval', async () => {
    const res = await request(app)
      .post('/api/onboarding/voice')
      .send({ transcript: "I run Bob's HVAC, we do AC repair, open 8 to 5 weekdays." });

    expect(res.status).toBe(200);
    expect(res.body.proposalIds.length).toBeGreaterThan(0);

    const persisted = await proposalRepo.findByTenant(currentTenant.tenantId);
    const types = persisted.map((p) => p.proposalType);
    expect(types).toContain('onboarding_tenant_settings');
    // Config proposals are promoted to ready_for_review (approvable in inbox),
    // never auto-approved.
    const config = persisted.filter((p) => p.proposalType !== 'voice_clarification');
    expect(config.length).toBeGreaterThan(0);
    expect(config.every((p) => p.status === 'ready_for_review')).toBe(true);
    // Returned proposalIds count only approvable config items, not clarifications.
    expect([...res.body.proposalIds].sort()).toEqual(config.map((p) => p.id).sort());

    const ev = await pool.query(
      "SELECT 1 FROM audit_events WHERE tenant_id=$1 AND event_type='onboarding.voice_intake'",
      [currentTenant.tenantId],
    );
    expect(ev.rows.length).toBe(1);
  });

  it('is idempotent — re-submitting the same transcript does not duplicate proposals', async () => {
    const transcript = "I run Bob's HVAC, AC repair, open 8 to 5 weekdays.";
    const first = await request(app).post('/api/onboarding/voice').send({ transcript });
    expect(first.status).toBe(200);
    const countAfterFirst = (await proposalRepo.findByTenant(currentTenant.tenantId)).length;

    const second = await request(app).post('/api/onboarding/voice').send({ transcript });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const countAfterSecond = (await proposalRepo.findByTenant(currentTenant.tenantId)).length;
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('returns 400 on an empty transcript', async () => {
    const res = await request(app).post('/api/onboarding/voice').send({ transcript: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('approving onboarding_tenant_settings writes the name, activates + seeds the pack', async () => {
    const handler = new OnboardingTenantSettingsExecutionHandler(
      settingsRepo,
      packActivationRepo,
      { catalogRepo, templateRepo },
      auditRepo,
    );
    const proposal = createProposal({
      tenantId: currentTenant.tenantId,
      proposalType: 'onboarding_tenant_settings',
      payload: { businessName: "Bob's HVAC", verticalPacks: ['hvac'] },
      summary: 'Configure tenant',
      createdBy: currentTenant.userId,
    });

    const result = await handler.execute(proposal, {
      tenantId: currentTenant.tenantId,
      executedBy: currentTenant.userId,
    });
    expect(result.success).toBe(true);

    // Real columns — business_name set, pack active, catalog seeded.
    const row = await pool.query(
      'SELECT business_name, active_vertical_packs FROM tenant_settings WHERE tenant_id=$1',
      [currentTenant.tenantId],
    );
    expect(row.rows[0].business_name).toBe("Bob's HVAC");

    const packRow = await pool.query(
      "SELECT status FROM pack_activations WHERE tenant_id=$1 AND pack_id='hvac'",
      [currentTenant.tenantId],
    );
    expect(packRow.rows[0]?.status).toBe('active');

    const catalog = await catalogRepo.listByTenant(currentTenant.tenantId);
    expect(catalog.length).toBeGreaterThan(0);

    // Derived status: the pack step is now done.
    const facts = await loadOnboardingFacts({ pool, settingsRepo }, currentTenant.tenantId);
    const status = deriveOnboardingStatus(facts);
    expect(status.steps.find((s) => s.id === 'pack')?.status).toBe('done');
  });

  it('approving onboarding_schedule writes the business_hours column (real persistence)', async () => {
    // Settings row must exist first.
    await new OnboardingTenantSettingsExecutionHandler(
      settingsRepo,
      packActivationRepo,
      undefined,
      auditRepo,
    ).execute(
      createProposal({
        tenantId: currentTenant.tenantId,
        proposalType: 'onboarding_tenant_settings',
        payload: { businessName: "Bob's HVAC", verticalPacks: ['hvac'] },
        summary: 'Configure tenant',
        createdBy: currentTenant.userId,
      }),
      { tenantId: currentTenant.tenantId, executedBy: currentTenant.userId },
    );

    const handler = new OnboardingScheduleExecutionHandler(settingsRepo, auditRepo);
    const proposal = createProposal({
      tenantId: currentTenant.tenantId,
      proposalType: 'onboarding_schedule',
      payload: {
        workingHours: [
          { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], startTime: '08:00', endTime: '17:00' },
        ],
      },
      summary: 'Configure hours',
      createdBy: currentTenant.userId,
    });

    const result = await handler.execute(proposal, {
      tenantId: currentTenant.tenantId,
      executedBy: currentTenant.userId,
    });
    expect(result.success).toBe(true);

    // Pin the real column — this is the write PgSettings.update previously
    // dropped (business_hours was read-only-projected before this change).
    const row = await pool.query(
      'SELECT business_hours FROM tenant_settings WHERE tenant_id=$1',
      [currentTenant.tenantId],
    );
    const hours = row.rows[0].business_hours;
    expect(hours.mon).toEqual({ open: '08:00', close: '17:00' });
    expect(hours.fri).toEqual({ open: '08:00', close: '17:00' });
  });
});
