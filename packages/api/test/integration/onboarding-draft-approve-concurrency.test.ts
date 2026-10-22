/**
 * Approve races on real Postgres (U11).
 *
 * The S1 defect: approveDraft read the draft without a lock and markApproved had
 * no version check, so a PUT /choices could commit between building the
 * proposals and marking the draft approved (executed payload != draft), and two
 * concurrent approves each minted and approved a proposal pair.
 *
 * The scripted tests put two real request transactions on two pooled
 * connections (onboarding-draft-request-tx.ts) and interleave them
 * deterministically: the second statement is awaited until pg_blocking_pids
 * shows it parked on the first's row lock, then the first commits. The HTTP
 * tests drive the real router through the real withTenantTransaction middleware.
 *
 * Every field writer (choice PUT, timezone write, owner-phone PUT, ...) against
 * approve, and writer against writer, is the DRAFT_WRITERS table in
 * onboarding-draft-writers-vs-approve.test.ts; this file keeps approve against
 * approve, the HTTP stale-version cases and the rollback case.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { raceFirstThen } from './onboarding-draft-request-tx';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { createOnboardingDraftRouter } from '../../src/routes/onboarding-draft';
import {
  PgOnboardingDraftRepository,
  DraftVersionConflictError,
  type OnboardingDraft,
} from '../../src/onboarding/draft/repository';
import { approveDraft, type ApproveDraftDeps } from '../../src/onboarding/draft/approve';
import { assembleTypicalShop } from '../../src/onboarding/choices/assemble';
import { PgRegionalPriceTierRepository } from '../../src/onboarding/choices/price-tiers';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

describe('onboarding approve concurrency (real DB)', () => {
  let pool: Pool;
  let draftRepo: PgOnboardingDraftRepository;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let tierRepo: PgRegionalPriceTierRepository;
  let deps: ApproveDraftDeps;
  let tenant: { tenantId: string; userId: string };

  const actor = () => ({ userId: tenant.userId, role: 'owner' as const });

  beforeAll(async () => {
    pool = await getSharedTestDb();
    draftRepo = new PgOnboardingDraftRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tierRepo = new PgRegionalPriceTierRepository(pool);
    deps = { draftRepo, proposalRepo, auditRepo };
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedDraft(): Promise<OnboardingDraft> {
    const assembled = await assembleTypicalShop(tierRepo, {
      packId: 'plumbing',
      businessName: 'Walsh Plumbing',
      ownerFirstName: 'Jenna',
      metro: { kind: 'metro', metroCode: 'CLE', name: 'Cleveland' },
    });
    return draftRepo.create(tenant.tenantId, {
      packId: 'plumbing',
      trade: 'plumbing',
      metroCode: 'CLE',
      metroName: 'Cleveland',
      businessName: 'Walsh Plumbing',
      ownerFirstName: 'Jenna',
      clientTimezone: 'America/New_York',
      assembled,
    });
  }

  const proposalCount = async (tenantId = tenant.tenantId) =>
    (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM proposals WHERE tenant_id = $1', [tenantId])).rows[0].n;
  const approvedAuditCount = async (tenantId = tenant.tenantId) =>
    (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND event_type = 'onboarding.draft_approved'`, [tenantId])).rows[0].n;
  const rawDraft = async (tenantId = tenant.tenantId) =>
    (await pool.query<{ id: string; status: string; version: number; choices: Record<string, unknown>; proposal_ids: string[] }>(
      'SELECT id, status, version, choices, proposal_ids FROM onboarding_drafts WHERE tenant_id = $1',
      [tenantId],
    )).rows[0];

  describe('scripted request transactions', () => {
    it('approve vs approve: exactly one proposal pair, both callers get the same ids, one audit row', async () => {
      const d = await seedDraft();
      const { first, second } = await raceFirstThen(
        pool,
        tenant.tenantId,
        () => approveDraft(deps, tenant.tenantId, actor(), { expectedVersion: d.version }),
        () => approveDraft(deps, tenant.tenantId, actor(), { expectedVersion: d.version }),
      );
      expect(first.approvedNow).toBe(true);
      expect(second.status).toBe('fulfilled');
      const loser = (second as PromiseFulfilledResult<Awaited<ReturnType<typeof approveDraft>>>).value;
      expect(loser.approvedNow).toBe(false);
      expect(loser.proposalIds).toEqual(first.proposalIds);

      const pair = await pool.query(
        `SELECT proposal_type FROM proposals WHERE tenant_id = $1 AND source_context->>'draftId' = $2 ORDER BY proposal_type`,
        [tenant.tenantId, d.id],
      );
      expect(pair.rows.map((r) => r.proposal_type)).toEqual(['onboarding_tenant_settings', 'onboarding_voice_policy']);
      expect(await proposalCount()).toBe(2);
      const raw = await rawDraft();
      expect([...raw.proposal_ids].sort()).toEqual([...first.proposalIds].sort());
      expect(raw.version).toBe(d.version + 1);
      expect(await approvedAuditCount()).toBe(1);
    });

    it('approve vs approve with a stale expectedVersion: the loser gets DraftVersionConflictError, not the winner\'s ids', async () => {
      const d = await seedDraft();
      const { first, second } = await raceFirstThen(
        pool,
        tenant.tenantId,
        () => approveDraft(deps, tenant.tenantId, actor(), { expectedVersion: d.version }),
        () => approveDraft(deps, tenant.tenantId, actor(), { expectedVersion: d.version - 1 }),
      );
      expect(first.approvedNow).toBe(true);
      expect(second.status).toBe('rejected');
      expect((second as PromiseRejectedResult).reason).toMatchObject({ expected: d.version - 1, actual: d.version });
      expect((second as PromiseRejectedResult).reason).toBeInstanceOf(DraftVersionConflictError);
      expect(await proposalCount()).toBe(2);
      expect(await approvedAuditCount()).toBe(1);
    });
  });

  describe('over HTTP through withTenantTransaction', () => {
    let app: express.Express;
    let failChecks = false;

    beforeAll(() => {
      app = express();
      app.use(express.json());
      app.use((req: Request, _res: Response, next: NextFunction) => {
        (req as AuthenticatedRequest).auth = { userId: tenant.userId, sessionId: 's', tenantId: tenant.tenantId, role: 'owner' };
        next();
      });
      app.use('/api', withTenantTransaction(pool));
      app.use(
        '/api/onboarding/draft',
        createOnboardingDraftRouter({
          draftRepo,
          tierRepo,
          proposalRepo,
          auditRepo,
          approvalReferenceChecks: [async () => (failChecks ? ['forced reference failure'] : [])],
        }),
      );
    });

    beforeEach(() => {
      failChecks = false;
    });

    it('two simultaneous approvals (10 fresh tenants): one approvedNow, one idempotent, one pair, one audit row', async () => {
      for (let i = 0; i < 10; i++) {
        tenant = await createTestTenant(pool);
        const d = await seedDraft();
        const post = () => request(app).post('/api/onboarding/draft/approve').send({ expectedVersion: d.version });
        const [a, b] = await Promise.all([post(), post()]);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect([a.body.approvedNow, b.body.approvedNow].sort()).toEqual([false, true]);
        expect(a.body.proposalIds).toHaveLength(2);
        expect([...a.body.proposalIds].sort()).toEqual([...b.body.proposalIds].sort());
        expect(await proposalCount()).toBe(2);
        expect(await approvedAuditCount()).toBe(1);
      }
    });

    it('a stale expectedVersion is 409 VERSION_CONFLICT with zero proposals; the current version then succeeds', async () => {
      const d = await seedDraft();
      const put = await request(app).put('/api/onboarding/draft/choices/greeting').send({ choice: { option: 'b' }, version: d.version });
      expect(put.status).toBe(200);

      const stale = await request(app).post('/api/onboarding/draft/approve').send({ expectedVersion: d.version });
      expect(stale.status).toBe(409);
      expect(JSON.stringify(stale.body)).toMatch(/VERSION_CONFLICT/);
      expect(await proposalCount()).toBe(0);
      const raw = await rawDraft();
      expect(raw.status).toBe('draft');
      expect(raw.version).toBe(d.version + 1);
      expect(await approvedAuditCount()).toBe(0);

      const ok = await request(app).post('/api/onboarding/draft/approve').send({ expectedVersion: d.version + 1 });
      expect(ok.status).toBe(200);
      expect(ok.body.approvedNow).toBe(true);
    });

    it('a stale tab confirming after the draft was approved is 409 VERSION_CONFLICT; the same version re-tapping, or none, stays 200', async () => {
      const d = await seedDraft();
      const put = await request(app).put('/api/onboarding/draft/choices/greeting').send({ choice: { option: 'b' }, version: d.version });
      expect(put.status).toBe(200);
      const approvedFrom = d.version + 1;
      const won = await request(app).post('/api/onboarding/draft/approve').send({ expectedVersion: approvedFrom });
      expect(won.status).toBe(200);
      expect(won.body.approvedNow).toBe(true);

      // Tab A still shows the read-back from before tab B's choice.
      const stale = await request(app).post('/api/onboarding/draft/approve').send({ expectedVersion: d.version });
      expect(stale.status).toBe(409);
      expect(JSON.stringify(stale.body)).toMatch(/VERSION_CONFLICT/);

      for (const body of [{ expectedVersion: approvedFrom }, {}]) {
        const again = await request(app).post('/api/onboarding/draft/approve').send(body);
        expect(again.status).toBe(200);
        expect(again.body.approvedNow).toBe(false);
        expect([...again.body.proposalIds].sort()).toEqual([...won.body.proposalIds].sort());
      }
      expect(await proposalCount()).toBe(2);
      expect(await approvedAuditCount()).toBe(1);
    });

    it('an expectedVersion ahead of the row is 409 VERSION_CONFLICT with zero proposals', async () => {
      const d = await seedDraft();
      const res = await request(app).post('/api/onboarding/draft/approve').send({ expectedVersion: d.version + 4 });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/VERSION_CONFLICT/);
      expect(await proposalCount()).toBe(0);
    });

    it('a failed approval rolls everything back and releases the row lock: zero proposals, draft still draft, next PUT is immediate', async () => {
      const d = await seedDraft();
      failChecks = true;
      const res = await request(app).post('/api/onboarding/draft/approve').send({});
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/DRAFT_APPROVAL_FAILED/);
      expect(await proposalCount()).toBe(0);
      expect((await rawDraft()).status).toBe('draft');
      expect(await approvedAuditCount()).toBe(0);

      failChecks = false;
      const put = await request(app).put('/api/onboarding/draft/choices/greeting').send({ choice: { option: 'b' }, version: d.version });
      expect(put.status).toBe(200);
      const raw = await rawDraft();
      expect(raw.version).toBe(d.version + 1);
    });
  });
});
