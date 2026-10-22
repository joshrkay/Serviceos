/**
 * End-to-end slice S1 against real Postgres: create the draft, stage choices,
 * approve. Proves the proposals exist as approved rows, the draft is approved,
 * the status facts see it, and nothing in tenant_settings changed before the
 * execution worker runs (approval is not execution).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createOnboardingDraftRouter } from '../../src/routes/onboarding-draft';
import { PgOnboardingDraftRepository } from '../../src/onboarding/draft/repository';
import { ONBOARDING_READBACK_SURFACE } from '../../src/onboarding/draft/approve';
import { PgRegionalPriceTierRepository } from '../../src/onboarding/choices/price-tiers';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { loadOnboardingFacts } from '../../src/onboarding/load-facts';
import { deriveOnboardingStatus } from '../../src/onboarding/derive-status';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { withTenantTransaction } from '../../src/middleware/tenant-context';

describe('onboarding draft → approve (real DB)', () => {
  let pool: Pool;
  let app: express.Express;
  let proposalRepo: PgProposalRepository;
  let settingsRepo: PgSettingsRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    const tierRepo = new PgRegionalPriceTierRepository(pool);
    await tierRepo.upsert('plumbing', 'CLE', { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } }, 'test');
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: tenant.userId, sessionId: 's', tenantId: tenant.tenantId, role: 'owner' };
      next();
    });
    // The real request transaction, mounted exactly as app.ts does, so approve's
    // row lock is held for the whole request like in production.
    app.use('/api', withTenantTransaction(pool));
    app.use(
      '/api/onboarding/draft',
      createOnboardingDraftRouter({
        draftRepo: new PgOnboardingDraftRepository(pool),
        tierRepo,
        proposalRepo,
        auditRepo: new PgAuditRepository(pool),
      }),
    );
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM regional_price_tiers WHERE trade = 'plumbing' AND metro_code = 'CLE' AND source = 'test'`);
    await closeSharedTestDb();
  });

  it('creates, stages, approves; proposals are approved rows and the draft is approved', async () => {
    const created = await request(app).post('/api/onboarding/draft').send({
      packId: 'plumbing',
      businessName: 'Walsh Plumbing',
      ownerFirstName: 'Jenna',
      phone: '+12165550142',
      clientTimezone: 'America/New_York',
    });
    expect(created.status).toBe(201);
    expect(created.body.draft.metroCode).toBe('CLE');
    expect(created.body.draft.assembled.priceSource).toBe('metro');

    let version = created.body.draft.version;
    for (const [key, option] of [['greeting', 'b'], ['booking_posture', 'b'], ['payment_collection_mode', 'a']] as const) {
      const r = await request(app).put(`/api/onboarding/draft/choices/${key}`).send({ choice: { option }, version });
      expect(r.status, key).toBe(200);
      version = r.body.draft.version;
    }

    const factsBefore = await loadOnboardingFacts({ pool, settingsRepo }, tenant.tenantId);
    expect(factsBefore.draft).toEqual({ status: 'draft', choicesAnswered: 3, version });
    expect(deriveOnboardingStatus(factsBefore).draft).toEqual({ status: 'draft', choicesAnswered: 3, version, execution: null });

    const approved = await request(app).post('/api/onboarding/draft/approve').send({});
    expect(approved.status).toBe(200);
    expect(approved.body.proposalIds).toHaveLength(2);

    // A repeat tap is the idempotent success: the same ids, nothing new minted.
    const again = await request(app).post('/api/onboarding/draft/approve').send({});
    expect(again.status).toBe(200);
    expect(again.body.approvedNow).toBe(false);
    expect(again.body.proposalIds).toEqual(approved.body.proposalIds);
    const count = await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE tenant_id = $1`, [tenant.tenantId]);
    expect(count.rows[0].n).toBe(2);

    const rows = await pool.query(
      `SELECT proposal_type, status, source_context FROM proposals WHERE tenant_id = $1 ORDER BY proposal_type`,
      [tenant.tenantId],
    );
    expect(rows.rows.map((r) => [r.proposal_type, r.status])).toEqual([
      ['onboarding_tenant_settings', 'approved'],
      ['onboarding_voice_policy', 'approved'],
    ]);
    for (const r of rows.rows) expect(r.source_context).toMatchObject({ surface: ONBOARDING_READBACK_SURFACE });

    const draftRow = await pool.query(`SELECT status, proposal_ids FROM onboarding_drafts WHERE tenant_id = $1`, [tenant.tenantId]);
    expect(draftRow.rows[0].status).toBe('approved');
    expect([...draftRow.rows[0].proposal_ids].sort()).toEqual([...approved.body.proposalIds].sort());

    // Approval is not execution: settings are untouched until the worker runs after the undo window.
    const settings = await pool.query(`SELECT voice_greeting, autonomous_booking_enabled FROM tenant_settings WHERE tenant_id = $1`, [tenant.tenantId]);
    expect(settings.rows[0]?.voice_greeting ?? null).toBeNull();

    const factsAfter = await loadOnboardingFacts({ pool, settingsRepo }, tenant.tenantId);
    expect(factsAfter.draft?.status).toBe('approved');
    expect(deriveOnboardingStatus(factsAfter).steps).toHaveLength(7);
    expect(deriveOnboardingStatus(factsAfter).draft?.execution).toBe('pending');

    const audit = await pool.query(
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND event_type LIKE 'onboarding.%' ORDER BY event_type`,
      [tenant.tenantId],
    );
    expect(audit.rows.map((r) => r.event_type)).toEqual([
      'onboarding.choice_staged',
      'onboarding.choice_staged',
      'onboarding.choice_staged',
      'onboarding.draft_approved',
      'onboarding.draft_created',
    ]);
  });

  it('a draft without a timezone cannot be approved and leaves no proposal rows', async () => {
    await request(app).post('/api/onboarding/draft').send({ packId: 'hvac', businessName: 'M&R Mechanical' });
    const res = await request(app).post('/api/onboarding/draft/approve').send({});
    expect(res.status).toBe(400);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE tenant_id = $1`, [tenant.tenantId]);
    expect(rows.rows[0].n).toBe(0);
    const draft = await pool.query(`SELECT status FROM onboarding_drafts WHERE tenant_id = $1`, [tenant.tenantId]);
    expect(draft.rows[0].status).toBe('draft');
  });
});
