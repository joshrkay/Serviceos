/**
 * Derived execution state on the status and POST /draft/retry (U9x) against real Postgres.
 *
 * After "That's right" the shell can only wait for the two proposals to execute.
 * The status `draft.execution` fact is derived from the approved draft's
 * proposal rows on every read (never stored), so a failure is visible and the
 * shell can offer a retry. These tests move REAL proposal rows through their
 * statuses and read the fact back through loadOnboardingFacts +
 * deriveOnboardingStatus, pinning the real columns the query reads
 * (onboarding_drafts.proposal_ids, proposals.status).
 *
 * Retry runs through the production `withTenantTransaction` middleware so the
 * draft row lock, the rollback on a refused re-approval, and the commit before the
 * response are all real.
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
import { UNDO_WINDOW_MS, isInUndoWindow } from '../../src/proposals/lifecycle';

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

    it('is stopped (not failed) when the owner undid one half, and when a listed proposal row is gone', async () => {
      const [a] = await approvedDraft();
      await setStatus(a, 'undone');
      expect((await status()).status.draft?.execution).toBe('stopped');

      await setStatus(a, 'approved');
      expect((await status()).status.draft?.execution).toBe('pending');

      await pool.query(
        `UPDATE onboarding_drafts SET proposal_ids = proposal_ids || to_jsonb($2::text) WHERE tenant_id = $1`,
        [tenant.tenantId, crypto.randomUUID()],
      );
      expect((await status()).status.draft?.execution).toBe('stopped');
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
      expect((await status()).status.draft?.execution).toBe('stopped');
    });
  });

  describe('POST /retry', () => {
    const PROPOSAL_COLS = `id, status, approved_at, execution_error, claimed_by, claimed_at, execution_retry_count,
                           executed_by, executed_by_role, updated_at, payload, summary`;

    async function row(id: string) {
      const r = await pool.query(`SELECT ${PROPOSAL_COLS} FROM proposals WHERE tenant_id = $1 AND id = $2`, [tenant.tenantId, id]);
      return r.rows[0];
    }
    async function draftRow() {
      const r = await pool.query(`SELECT status, version, updated_at, proposal_ids FROM onboarding_drafts WHERE tenant_id = $1`, [tenant.tenantId]);
      return r.rows[0];
    }
    async function failProposal(id: string) {
      await pool.query(
        `UPDATE proposals SET status = 'execution_failed', execution_error = 'handler exploded', execution_retry_count = 3,
                claimed_by = 'worker-1', claimed_at = NOW() - interval '1 hour', approved_at = NOW() - interval '1 hour'
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, id],
      );
    }
    async function auditCounts(tenantId = tenant.tenantId) {
      const r = await pool.query<{ event_type: string; n: number }>(
        `SELECT event_type, count(*)::int AS n FROM audit_events
          WHERE tenant_id = $1 AND (event_type LIKE 'proposal.%' OR event_type LIKE 'onboarding.%')
          GROUP BY event_type ORDER BY event_type`,
        [tenantId],
      );
      return Object.fromEntries(r.rows.map((x) => [x.event_type, x.n]));
    }
    const retry = (a: express.Express = app) => request(a).post('/api/onboarding/draft/retry').send();

    it('re-queues only the failed proposal with a fresh undo window and returns the fact to its in-flight state', async () => {
      const [a, b] = await approvedDraft();
      await failProposal(a);
      await pool.query(`UPDATE proposals SET status = 'executed', executed_at = NOW() WHERE tenant_id = $1 AND id = $2`, [tenant.tenantId, b]);
      expect((await status()).status.draft?.execution).toBe('failed');

      const beforeB = await row(b);
      const draftBefore = await draftRow();
      const startedAt = new Date();

      const res = await retry();
      expect(res.status).toBe(200);
      expect(res.body.retriedProposalIds).toEqual([a]);
      expect(res.body.draft.status).toBe('approved');

      const afterA = await row(a);
      expect(afterA.status).toBe('approved');
      expect(afterA.approved_at.getTime()).toBeGreaterThanOrEqual(startedAt.getTime() - 1000);
      expect(afterA.execution_error).toBeNull();
      expect(afterA.claimed_by).toBeNull();
      expect(afterA.claimed_at).toBeNull();
      expect(afterA.execution_retry_count).toBe(0);
      expect(afterA.executed_by).toBe(tenant.userId);
      expect(afterA.executed_by_role).toBe('owner');
      expect(isInUndoWindow((await proposalRepo.findById(tenant.tenantId, a))!)).toBe(true);

      // The other proposal and the draft row are byte-identical.
      expect(await row(b)).toEqual(beforeB);
      expect(await draftRow()).toEqual(draftBefore);

      // [approved, executed]: work is in flight (the worker has one left to run).
      expect((await status()).status.draft?.execution).toBe('executing');

      // The worker does not see it until the fresh window has passed.
      expect((await proposalRepo.findReadyForExecution(UNDO_WINDOW_MS)).map((p) => p.id)).not.toContain(a);
      expect((await proposalRepo.findReadyForExecution(0)).map((p) => p.id)).toContain(a);

      const audit = await pool.query(
        `SELECT event_type, entity_type, entity_id, actor_id, metadata FROM audit_events
          WHERE tenant_id = $1 AND event_type IN ('proposal.retried', 'onboarding.draft_retry') ORDER BY event_type, entity_id`,
        [tenant.tenantId],
      );
      expect(audit.rows.map((r) => [r.event_type, r.entity_type])).toEqual([
        ['onboarding.draft_retry', 'onboarding_draft'],
        ['proposal.retried', 'proposal'],
      ]);
      const retried = audit.rows.find((r) => r.event_type === 'proposal.retried');
      expect(retried).toMatchObject({ entity_id: a, actor_id: tenant.userId });
      expect(retried.metadata).toMatchObject({ draftId: (await pool.query(`SELECT id FROM onboarding_drafts WHERE tenant_id = $1`, [tenant.tenantId])).rows[0].id, previousExecutionError: 'handler exploded' });
      const drafted = audit.rows.find((r) => r.event_type === 'onboarding.draft_retry');
      expect(drafted.metadata).toMatchObject({ proposalIds: [a], draftVersion: draftBefore.version });
      expect(drafted.entity_id).toBe((await pool.query(`SELECT id FROM onboarding_drafts WHERE tenant_id = $1`, [tenant.tenantId])).rows[0].id);
      // The second approval of A was audited by the approval helper; B has only its original one.
      const approvals = await pool.query(
        `SELECT entity_id, count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND event_type = 'proposal.approved' GROUP BY entity_id`,
        [tenant.tenantId],
      );
      expect(Object.fromEntries(approvals.rows.map((r) => [r.entity_id, r.n]))).toEqual({ [a]: 2, [b]: 1 });
    });

    it('both failed: both are re-queued and the fact is pending', async () => {
      const ids = await approvedDraft();
      for (const id of ids) await failProposal(id);
      expect((await status()).status.draft?.execution).toBe('failed');

      const res = await retry();
      expect(res.status).toBe(200);
      expect([...res.body.retriedProposalIds].sort()).toEqual(ids);
      for (const id of ids) expect((await row(id)).status).toBe('approved');
      expect((await status()).status.draft?.execution).toBe('pending');
      expect((await auditCounts())['proposal.retried']).toBe(2);
    });

    it('nothing failed: 409 DRAFT_RETRY_NOTHING_FAILED and nothing changes', async () => {
      const ids = await approvedDraft();
      const before = await Promise.all(ids.map(row));
      const auditBefore = await auditCounts();

      const res = await retry();
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('DRAFT_RETRY_NOTHING_FAILED');
      expect(await Promise.all(ids.map(row))).toEqual(before);
      expect(await auditCounts()).toEqual(auditBefore);
    });

    it('an undone proposal cannot be retried: 409, and it stays undone', async () => {
      const [a] = await approvedDraft();
      await setStatus(a, 'undone');
      // The status says so too: `stopped`, which the shell renders without a Retry
      // button (retry only leaves `execution_failed`).
      expect((await status()).status.draft?.execution).toBe('stopped');
      const res = await retry();
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('DRAFT_RETRY_NOTHING_FAILED');
      expect((await row(a)).status).toBe('undone');
    });

    it('a draft that was never approved is a 409 DRAFT_NOT_APPROVED', async () => {
      await request(app).post('/api/onboarding/draft').send(CREATE);
      const res = await retry();
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('DRAFT_NOT_APPROVED');
    });

    it('a refused re-approval rolls the whole request back: the row is still execution_failed with its original state', async () => {
      const blocked = new Set<string>();
      const guarded = buildApp([async (_t, p) => (blocked.has(p.id) ? ['dangling'] : [])]);
      await approvedDraft();
      const ids = (await pool.query(`SELECT proposal_ids FROM onboarding_drafts WHERE tenant_id = $1`, [tenant.tenantId])).rows[0].proposal_ids as string[];
      const [a] = [...ids].sort();
      await failProposal(a);
      const before = await row(a);
      const auditBefore = await auditCounts();
      blocked.add(a);

      const res = await retry(guarded);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('DRAFT_RETRY_FAILED');

      // The reset to draft was rolled back, not just the approval.
      expect(await row(a)).toEqual(before);
      expect((await row(a)).status).toBe('execution_failed');
      expect(await auditCounts()).toEqual(auditBefore);
    });

    it('two simultaneous retries of the same failed proposal: exactly one wins, the other sees nothing failed', async () => {
      for (let i = 0; i < 5; i++) {
        tenant = await createTestTenant(pool);
        const [a] = await approvedDraft();
        await failProposal(a);

        const [r1, r2] = await Promise.all([retry(), retry()]);
        const statuses = [r1.status, r2.status].sort();
        expect(statuses, `round ${i}`).toEqual([200, 409]);
        const loser = r1.status === 409 ? r1 : r2;
        expect(JSON.stringify(loser.body)).toContain('DRAFT_RETRY_NOTHING_FAILED');
        expect((await row(a)).status).toBe('approved');
        expect((await auditCounts())['proposal.retried']).toBe(1);
        expect((await auditCounts())['onboarding.draft_retry']).toBe(1);
      }
    });

    it("another tenant's failed proposal is untouched, and a non-owner is refused with no writes", async () => {
      const mine = await approvedDraft();
      await failProposal(mine[0]);

      const mineTenant = tenant;
      const theirTenant = await createTestTenant(pool);
      tenant = theirTenant;
      const theirs = await approvedDraft();
      await failProposal(theirs[0]);
      const theirsBefore = await row(theirs[0]);
      const theirAuditBefore = await auditCounts();

      tenant = mineTenant;
      role = 'dispatcher';
      const denied = await retry();
      expect(denied.status).toBe(403);
      expect((await row(mine[0])).status).toBe('execution_failed');

      role = 'owner';
      expect((await retry()).status).toBe(200);
      expect((await row(mine[0])).status).toBe('approved');

      tenant = theirTenant;
      expect(await row(theirs[0])).toEqual(theirsBefore);
      expect(await auditCounts()).toEqual(theirAuditBefore);
    });
  });
});
