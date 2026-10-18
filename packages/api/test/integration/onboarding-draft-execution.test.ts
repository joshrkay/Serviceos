/**
 * Derived execution state on the status (U9x) against real Postgres.
 *
 * After "That's right" the shell can only wait for the two proposals to execute.
 * The status `draft.execution` fact is derived from the approved draft's
 * proposal rows on every read (never stored), so a failure is visible and the
 * shell can offer a retry. These tests move REAL proposal rows through their
 * statuses and read the fact back through loadOnboardingFacts +
 * deriveOnboardingStatus, pinning the real columns the query reads
 * (onboarding_drafts.proposal_ids, proposals.status).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createOnboardingDraftRouter } from '../../src/routes/onboarding-draft';
import { PgOnboardingDraftRepository } from '../../src/onboarding/draft/repository';
import { PgRegionalPriceTierRepository } from '../../src/onboarding/choices/price-tiers';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { loadOnboardingFacts } from '../../src/onboarding/load-facts';
import { deriveOnboardingStatus } from '../../src/onboarding/derive-status';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import type { ApprovalReferenceCheck } from '../../src/proposals/approval-reference-checks';

const CREATE = {
  packId: 'plumbing',
  businessName: 'Walsh Plumbing',
  ownerFirstName: 'Jenna',
  phone: '+12165550142',
  clientTimezone: 'America/New_York',
};

describe('onboarding draft execution state (real DB)', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let settingsRepo: PgSettingsRepository;
  let tenant: { tenantId: string; userId: string };
  let role: 'owner' | 'dispatcher' = 'owner';

  /** The production request transaction in front of the real router. */
  function buildApp(approvalReferenceChecks?: ApprovalReferenceCheck[]) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: tenant.userId, sessionId: 's', tenantId: tenant.tenantId, role };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.use(
      '/api/onboarding/draft',
      createOnboardingDraftRouter({
        draftRepo: new PgOnboardingDraftRepository(pool),
        tierRepo: new PgRegionalPriceTierRepository(pool),
        proposalRepo,
        auditRepo: new PgAuditRepository(pool),
        ...(approvalReferenceChecks ? { approvalReferenceChecks } : {}),
      }),
    );
    return app;
  }

  let app: express.Express;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    await new PgRegionalPriceTierRepository(pool).upsert(
      'plumbing',
      'CLE',
      { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } },
      'test',
    );
    app = buildApp();
  });

  beforeEach(async () => {
    role = 'owner';
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM regional_price_tiers WHERE trade = 'plumbing' AND metro_code = 'CLE' AND source = 'test'`);
    await closeSharedTestDb();
  });

  async function approvedDraft(): Promise<string[]> {
    const created = await request(app).post('/api/onboarding/draft').send(CREATE);
    expect(created.status).toBe(201);
    const approved = await request(app).post('/api/onboarding/draft/approve').send({});
    expect(approved.status).toBe(200);
    const ids: string[] = [...approved.body.proposalIds].sort();
    expect(ids).toHaveLength(2);
    return ids;
  }

  async function setStatus(id: string, status: string): Promise<void> {
    await pool.query(`UPDATE proposals SET status = $3 WHERE tenant_id = $1 AND id = $2`, [tenant.tenantId, id, status]);
  }

  async function status() {
    const facts = await loadOnboardingFacts({ pool, settingsRepo }, tenant.tenantId);
    return { facts, status: deriveOnboardingStatus(facts) };
  }

  describe('the draft.execution fact', () => {
    it('is null while the draft is still being edited, and the facts carry no proposals', async () => {
      await request(app).post('/api/onboarding/draft').send(CREATE);
      const { facts, status: s } = await status();
      expect(facts.draft).not.toHaveProperty('proposals');
      expect(s.draft?.execution).toBeNull();
      expect(s.steps).toHaveLength(7);
    });

    it('follows the real proposal rows: pending, executing, failed, executed', async () => {
      const [a, b] = await approvedDraft();

      let s = (await status()).status;
      expect(s.draft).toMatchObject({ status: 'approved', execution: 'pending' });
      expect(s.draft).not.toHaveProperty('proposals');

      await pool.query(
        `UPDATE proposals SET status = 'executing', claimed_by = 'w', claimed_at = NOW() WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, a],
      );
      s = (await status()).status;
      expect(s.draft?.execution).toBe('executing');

      // One done, the other still in flight.
      await setStatus(a, 'executed');
      await setStatus(b, 'executing');
      expect((await status()).status.draft?.execution).toBe('executing');

      // One done, the other approved and waiting for the worker: still in flight.
      await setStatus(b, 'approved');
      expect((await status()).status.draft?.execution).toBe('executing');

      // A failure wins over the other still running.
      await pool.query(
        `UPDATE proposals SET status = 'execution_failed', execution_error = 'boom', execution_retry_count = 3,
                approved_at = NOW() - interval '1 hour' WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, a],
      );
      await setStatus(b, 'executing');
      s = (await status()).status;
      expect(s.draft?.execution).toBe('failed');
      expect(s.steps).toHaveLength(7);

      await setStatus(a, 'executed');
      await setStatus(b, 'executed');
      s = (await status()).status;
      expect(s.draft?.execution).toBe('executed');
      expect(s.steps).toHaveLength(7);
    });

    it('is failed when the owner undid one half, and when a listed proposal row is gone', async () => {
      const [a] = await approvedDraft();
      await setStatus(a, 'undone');
      expect((await status()).status.draft?.execution).toBe('failed');

      await setStatus(a, 'approved');
      expect((await status()).status.draft?.execution).toBe('pending');

      await pool.query(
        `UPDATE onboarding_drafts SET proposal_ids = proposal_ids || to_jsonb($2::text) WHERE tenant_id = $1`,
        [tenant.tenantId, crypto.randomUUID()],
      );
      expect((await status()).status.draft?.execution).toBe('failed');
    });

    it("never reads another tenant's proposals", async () => {
      const other = await createTestTenant(pool);
      const [a] = await approvedDraft();
      // A proposal of another tenant listed on this draft does not count as found.
      const foreign = await pool.query(
        `INSERT INTO proposals (id, tenant_id, proposal_type, status, payload, summary, created_by)
         VALUES (gen_random_uuid(), $1, 'onboarding_tenant_settings', 'executed', '{}'::jsonb, 'x', $2) RETURNING id`,
        [other.tenantId, other.userId],
      );
      await pool.query(`UPDATE onboarding_drafts SET proposal_ids = jsonb_build_array($2::text, $3::text) WHERE tenant_id = $1`, [
        tenant.tenantId,
        a,
        foreign.rows[0].id,
      ]);
      expect((await status()).status.draft?.execution).toBe('failed');
    });
  });
});
