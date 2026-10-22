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
import { approveProposal, undoProposal } from '../../src/proposals/actions';
import { retryFailedDraftProposals } from '../../src/onboarding/draft/retry';
import { undoApprovedDraft } from '../../src/onboarding/draft/undo';
import { raceFirstThen } from './onboarding-draft-request-tx';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { loadOnboardingFacts } from '../../src/onboarding/load-facts';
import { deriveOnboardingStatus } from '../../src/onboarding/derive-status';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import type { ApprovalReferenceCheck } from '../../src/proposals/approval-reference-checks';
import { UNDO_WINDOW_MS, isInUndoWindow } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { PgIdempotencyLockProvider } from '../../src/proposals/execution/idempotency-lock';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import type { ExecutionHandler } from '../../src/proposals/execution/handlers';
import { runExecutionSweep } from '../../src/workers/execution-worker';
import type { Logger } from '../../src/logging/logger';

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

    it('is stopped (not failed) when one half failed and the other is undone, rejected or expired, or its row is gone', async () => {
      const [a, b] = await approvedDraft();
      await pool.query(
        `UPDATE proposals SET status = 'execution_failed', execution_error = 'boom', execution_retry_count = 3,
                approved_at = NOW() - interval '1 hour' WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, a],
      );
      // Retry could only re-queue the failed half, so it would execute alone.
      for (const sibling of ['undone', 'rejected', 'expired']) {
        await setStatus(b, sibling);
        expect((await status()).status.draft?.execution, sibling).toBe('stopped');
      }
      // The same failure next to a half retry CAN complete the pair stays failed.
      for (const sibling of ['approved', 'executing', 'executed']) {
        await setStatus(b, sibling);
        expect((await status()).status.draft?.execution, sibling).toBe('failed');
      }

      await pool.query(
        `UPDATE onboarding_drafts SET proposal_ids = jsonb_build_array($2::text, $3::text) WHERE tenant_id = $1`,
        [tenant.tenantId, a, crypto.randomUUID()],
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

  describe('S4: the undoable and recovery hints, approved_at and the approver stamp', () => {
    async function ageApproval(ids: string[], seconds: number): Promise<void> {
      await pool.query(
        `UPDATE proposals SET approved_at = NOW() - make_interval(secs => $3) WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenant.tenantId, ids, seconds],
      );
    }

    it('loadOnboardingFacts carries each listed member with proposals.approved_at as a Date', async () => {
      const ids = await approvedDraft();
      const { facts } = await status();
      const members = facts.draft?.proposals?.members ?? [];
      expect(facts.draft?.proposals?.expected).toBe(2);
      expect(members).toHaveLength(2);
      const stored = await pool.query<{ approved_at: Date }>(
        `SELECT approved_at FROM proposals WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY approved_at`,
        [tenant.tenantId, ids],
      );
      for (const m of members) {
        expect(m.status).toBe('approved');
        expect(m.approvedAt).toBeInstanceOf(Date);
        expect(stored.rows.map((r) => r.approved_at.getTime())).toContain(m.approvedAt!.getTime());
      }
    });

    it('a fresh approval reads undoable with no recovery; six seconds later it is no longer undoable', async () => {
      const ids = await approvedDraft();
      let s = (await status()).status;
      expect(s.draft).toMatchObject({ status: 'approved', execution: 'pending', undoable: true });
      expect(s.draft).not.toHaveProperty('recovery');
      expect(s.steps).toHaveLength(7);

      await ageApproval(ids, 6);
      s = (await status()).status;
      expect(s.draft).toMatchObject({ execution: 'pending', undoable: false });
      expect(s.draft).not.toHaveProperty('recovery');
    });

    it('undone + approved is stopped with recovery reset inside the window and settings past it', async () => {
      const [a, b] = await approvedDraft();
      await setStatus(a, 'undone');
      let s = (await status()).status;
      expect(s.draft).toMatchObject({ execution: 'stopped', recovery: 'reset', undoable: false });

      await ageApproval([b], 6);
      s = (await status()).status;
      expect(s.draft).toMatchObject({ execution: 'stopped', recovery: 'settings', undoable: false });
    });

    it('a failed member beside an executed one is settings; beside an undone one is reset', async () => {
      const [a, b] = await approvedDraft();
      await setStatus(a, 'execution_failed');
      await setStatus(b, 'executed');
      expect((await status()).status.draft).toMatchObject({ execution: 'failed', recovery: 'settings' });
      await setStatus(b, 'undone');
      expect((await status()).status.draft).toMatchObject({ execution: 'stopped', recovery: 'reset' });
    });

    it('approve through the real router persists the approver: executed_by and executed_by_role on both rows', async () => {
      const ids = await approvedDraft();
      const r = await pool.query<{ executed_by: string; executed_by_role: string; approved_at: Date | null }>(
        `SELECT executed_by, executed_by_role, approved_at FROM proposals WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenant.tenantId, ids],
      );
      expect(r.rows).toHaveLength(2);
      for (const row of r.rows) {
        expect(row.executed_by).toBe(tenant.userId);
        expect(row.executed_by_role).toBe('owner');
        expect(row.approved_at).toBeInstanceOf(Date);
      }
    });

    it('the conditional approve write: a draft member a reset expired after the read is refused and stays expired', async () => {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO proposals (id, tenant_id, proposal_type, status, payload, summary, created_by)
         VALUES (gen_random_uuid(), $1, 'onboarding_tenant_settings', 'draft', $2::jsonb, 'x', $3) RETURNING id`,
        [tenant.tenantId, JSON.stringify({ businessName: 'Walsh Plumbing', verticalPacks: ['plumbing'] }), tenant.userId],
      );
      const id = inserted.rows[0].id;
      /** Another transaction (the reset) commits `expired` between approve's read and its write. */
      class ResetRacesApprove extends PgProposalRepository {
        override async updateStatusIf(...args: Parameters<PgProposalRepository['updateStatusIf']>) {
          await pool.query(`UPDATE proposals SET status = 'expired' WHERE tenant_id = $1 AND id = $2`, [args[0], args[1]]);
          return super.updateStatusIf(...args);
        }
      }
      const auditRepo = new PgAuditRepository(pool);

      await expect(
        approveProposal(new ResetRacesApprove(pool), tenant.tenantId, id, tenant.userId, 'owner', auditRepo, 'ui'),
      ).rejects.toThrow("Cannot transition proposal from 'expired' to 'approved'");

      const after = await pool.query(`SELECT status, approved_at, executed_by, executed_by_role FROM proposals WHERE id = $1`, [id]);
      expect(after.rows[0]).toEqual({ status: 'expired', approved_at: null, executed_by: null, executed_by_role: null });
      const approvals = await pool.query(
        `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = 'proposal.approved' AND entity_id = $2`,
        [tenant.tenantId, id],
      );
      expect(approvals.rows).toHaveLength(0);

      // Without the race the same row approves and carries the approver's role.
      const fresh = await pool.query<{ id: string }>(
        `INSERT INTO proposals (id, tenant_id, proposal_type, status, payload, summary, created_by)
         VALUES (gen_random_uuid(), $1, 'onboarding_tenant_settings', 'draft', $2::jsonb, 'x', $3) RETURNING id`,
        [tenant.tenantId, JSON.stringify({ businessName: 'Walsh Plumbing', verticalPacks: ['plumbing'] }), 'technician-7'],
      );
      const ok = await approveProposal(proposalRepo, tenant.tenantId, fresh.rows[0].id, tenant.userId, 'owner', auditRepo, 'ui');
      expect(ok).toMatchObject({ status: 'approved', executedBy: tenant.userId, executedByRole: 'owner' });
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
    const approve = (body: object = {}) => request(app).post('/api/onboarding/draft/approve').send(body);

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
      // A retry is a new approval attempt: the response carries the new version.
      expect(res.body.draft.version).toBe(draftBefore.version + 1);

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

      // The other proposal is byte-identical. The draft row moved on by exactly one
      // version (and updated_at); status and the proposal ids are untouched.
      expect(await row(b)).toEqual(beforeB);
      const draftAfter = await draftRow();
      expect(draftAfter.version).toBe(draftBefore.version + 1);
      expect(draftAfter.updated_at.getTime()).toBeGreaterThan(draftBefore.updated_at.getTime());
      expect(draftAfter).toEqual({ ...draftBefore, version: draftBefore.version + 1, updated_at: draftAfter.updated_at });

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
      expect(drafted.metadata).toMatchObject({
        proposalIds: [a],
        draftVersionBefore: draftBefore.version,
        draftVersionAfter: draftBefore.version + 1,
      });
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
      const versionBefore = (await draftRow()).version;

      const res = await retry();
      expect(res.status).toBe(200);
      expect([...res.body.retriedProposalIds].sort()).toEqual(ids);
      for (const id of ids) expect((await row(id)).status).toBe('approved');
      // One retry is one attempt, however many proposals it re-queues.
      expect((await draftRow()).version).toBe(versionBefore + 1);
      expect((await status()).status.draft?.execution).toBe('pending');
      expect((await auditCounts())['proposal.retried']).toBe(2);
    });

    it('nothing failed: 409 DRAFT_RETRY_NOTHING_FAILED and nothing changes', async () => {
      const ids = await approvedDraft();
      const before = await Promise.all(ids.map(row));
      const draftBefore = await draftRow();
      const auditBefore = await auditCounts();

      const res = await retry();
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('DRAFT_RETRY_NOTHING_FAILED');
      expect(await Promise.all(ids.map(row))).toEqual(before);
      expect(await draftRow()).toEqual(draftBefore);
      expect(await auditCounts()).toEqual(auditBefore);
    });

    it('a failed proposal next to an approved one is retried (the pair can still complete)', async () => {
      const [a, b] = await approvedDraft();
      await failProposal(a);
      const beforeB = await row(b);
      expect((await status()).status.draft?.execution).toBe('failed');

      const res = await retry();
      expect(res.status).toBe(200);
      expect(res.body.retriedProposalIds).toEqual([a]);
      expect((await row(a)).status).toBe('approved');
      expect(await row(b)).toEqual(beforeB);
      expect((await status()).status.draft?.execution).toBe('pending');
    });

    it('an undone proposal cannot be retried: 409 DRAFT_RETRY_UNSAFE, and it stays undone', async () => {
      const [a] = await approvedDraft();
      await setStatus(a, 'undone');
      // The status says so too: `stopped`, which the shell renders without a Retry
      // button (retry only leaves `execution_failed`).
      expect((await status()).status.draft?.execution).toBe('stopped');
      const before = await row(a);
      const draftBefore = await draftRow();
      const auditBefore = await auditCounts();
      const res = await retry();
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('DRAFT_RETRY_UNSAFE');
      // The refusal names the two ways out the shell offers: Start over (POST /draft/reset) or Settings.
      expect(JSON.stringify(res.body)).toContain('Start over to set it up again, or finish it from Settings.');
      expect(await row(a)).toEqual(before);
      expect(await draftRow()).toEqual(draftBefore);
      expect((await row(a)).status).toBe('undone');
      expect(await auditCounts()).toEqual(auditBefore);
    });

    it('S4-5: execution_failed + undone is refused by retry (unchanged) and its way out is the reset: 200, editable; the failed proposal never executes after the window it would have had', async () => {
      const [a, b] = await approvedDraft();
      await failProposal(a);
      await setStatus(b, 'undone');
      expect((await status()).status.draft).toMatchObject({ execution: 'stopped', recovery: 'reset' });
      const refused = await retry();
      expect(refused.status).toBe(409);
      expect(refused.body.message).toMatch(/^DRAFT_RETRY_UNSAFE: .*Start over to set it up again, or finish it from Settings\.$/);
      const version: number = (await draftRow()).version;

      const res = await request(app).post('/api/onboarding/draft/reset').send({ expectedVersion: version });

      expect(res.status).toBe(200);
      expect(res.body.draft).toMatchObject({ status: 'draft', proposalIds: [], version: version + 1 });
      expect(await draftRow()).toMatchObject({ status: 'draft', version: version + 1, proposal_ids: [] });
      // Nothing was re-queued: the failed half stays failed, the undone half undone.
      expect((await row(a)).status).toBe('execution_failed');
      expect((await row(b)).status).toBe('undone');
      expect((await auditCounts())['onboarding.draft_reset']).toBe(1);
      expect((await auditCounts())['proposal.retried'] ?? 0).toBe(0);

      // Wait out the fresh window a re-queue would have opened: the worker still never sees it.
      await pool.query(`UPDATE proposals SET approved_at = NOW() - interval '1 hour' WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [
        tenant.tenantId,
        [a, b],
      ]);
      expect((await proposalRepo.findReadyForExecution(0)).map((p) => p.id)).not.toContain(a);
      expect((await row(a)).status).toBe('execution_failed');
    });

    // The defect this pins: a failed proposal next to one that can never run used
    // to derive `failed` and offer a Retry that re-queued only the failed half.
    // After its fresh undo window that half executed alone ("executed + undone"),
    // half the approved configuration live and only Settings to fix it.
    it.each(['undone', 'rejected', 'expired'])(
      'one failed + one %s: status is stopped, retry is 409 DRAFT_RETRY_UNSAFE, both rows are unchanged and nothing is audited',
      async (sibling) => {
        const [a, b] = await approvedDraft();
        await failProposal(a);
        await setStatus(b, sibling);
        expect((await status()).status.draft?.execution).toBe('stopped');

        const beforeA = await row(a);
        const beforeB = await row(b);
        const draftBefore = await draftRow();
        const auditBefore = await auditCounts();

        const res = await retry();

        expect(res.status).toBe(409);
        expect(JSON.stringify(res.body)).toContain('DRAFT_RETRY_UNSAFE');
        expect(JSON.stringify(res.body)).toContain('Settings');
        expect(await row(a)).toEqual(beforeA);
        expect(await row(b)).toEqual(beforeB);
        expect((await row(a)).status).toBe('execution_failed');
        expect((await row(b)).status).toBe(sibling);
        expect(await draftRow()).toEqual(draftBefore);
        expect(await auditCounts()).toEqual(auditBefore);
        expect((await auditCounts())['proposal.retried'] ?? 0).toBe(0);
        expect((await auditCounts())['onboarding.draft_retry'] ?? 0).toBe(0);
        // The worker never sees the failed half either, so it cannot run alone.
        expect((await proposalRepo.findReadyForExecution(0)).map((p) => p.id)).not.toContain(a);
      },
    );

    it('one failed + one listed proposal whose row is gone: 409 DRAFT_RETRY_UNSAFE and the failed row is unchanged', async () => {
      const [a] = await approvedDraft();
      await failProposal(a);
      await pool.query(
        `UPDATE onboarding_drafts SET proposal_ids = jsonb_build_array($2::text, $3::text) WHERE tenant_id = $1`,
        [tenant.tenantId, a, crypto.randomUUID()],
      );
      expect((await status()).status.draft?.execution).toBe('stopped');
      const before = await row(a);
      const draftBefore = await draftRow();
      const auditBefore = await auditCounts();

      const res = await retry();

      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('DRAFT_RETRY_UNSAFE');
      expect(await row(a)).toEqual(before);
      expect(await draftRow()).toEqual(draftBefore);
      expect(await auditCounts()).toEqual(auditBefore);
    });

    it('a draft that was never approved is a 409 DRAFT_NOT_APPROVED', async () => {
      await request(app).post('/api/onboarding/draft').send(CREATE);
      const draftBefore = await draftRow();
      const res = await retry();
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('DRAFT_NOT_APPROVED');
      expect(await draftRow()).toEqual(draftBefore);
    });

    // The race this change closes (Codex P1): a retry opens a NEW undo window, so
    // the draft version must name the attempt. Tab A rendered the original approval
    // and still holds its version; after the retry lands it must not be able to
    // confirm (and later undo or reset) a retry it never rendered.
    it('tab A holds the original approval: once a retry has landed, approve with its expectedVersion is 409 VERSION_CONFLICT, and a bare approve is still the idempotent 200', async () => {
      const created = await request(app).post('/api/onboarding/draft').send(CREATE);
      const v: number = created.body.draft.version; // the version tab A rendered
      const approved = await approve({ expectedVersion: v });
      expect(approved.status).toBe(200);
      const ids: string[] = [...approved.body.proposalIds].sort();
      expect((await draftRow()).version).toBe(v + 1);

      // Before any retry, tab A's re-tap is the idempotent 200 and moves nothing.
      const retap = await approve({ expectedVersion: v });
      expect(retap.status).toBe(200);
      expect(retap.body.approvedNow).toBe(false);
      expect((await draftRow()).version).toBe(v + 1);

      await failProposal(ids[0]);
      const retried = await retry();
      expect(retried.status).toBe(200);
      expect(retried.body.draft.version).toBe(v + 2);
      expect((await draftRow()).version).toBe(v + 2);

      const draftAfterRetry = await draftRow();
      const stale = await approve({ expectedVersion: v });
      expect(stale.status).toBe(409);
      expect(JSON.stringify(stale.body)).toContain('VERSION_CONFLICT');
      // Refused: no proposal minted, no version moved, no second approval audited.
      expect(await draftRow()).toEqual(draftAfterRetry);
      expect((await proposalRepo.findByTenant(tenant.tenantId)).length).toBe(2);
      expect((await auditCounts())['onboarding.draft_approved']).toBe(1);

      const bare = await approve();
      expect(bare.status).toBe(200);
      expect(bare.body.approvedNow).toBe(false);
      expect([...bare.body.proposalIds].sort()).toEqual(ids);
      expect((await draftRow()).version).toBe(v + 2);
    });

    it('a refused re-approval rolls the whole request back: the row is still execution_failed with its original state', async () => {
      const blocked = new Set<string>();
      const guarded = buildApp([async (_t, p) => (blocked.has(p.id) ? ['dangling'] : [])]);
      await approvedDraft();
      const ids = (await pool.query(`SELECT proposal_ids FROM onboarding_drafts WHERE tenant_id = $1`, [tenant.tenantId])).rows[0].proposal_ids as string[];
      const [a] = [...ids].sort();
      await failProposal(a);
      const before = await row(a);
      const draftBefore = await draftRow();
      const auditBefore = await auditCounts();
      blocked.add(a);

      const res = await retry(guarded);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('DRAFT_RETRY_FAILED');

      // The reset to draft was rolled back, not just the approval, and the draft version never moved.
      expect(await row(a)).toEqual(before);
      expect(await draftRow()).toEqual(draftBefore);
      expect((await row(a)).status).toBe('execution_failed');
      expect(await auditCounts()).toEqual(auditBefore);
    });

    it('two simultaneous retries of the same failed proposal: exactly one wins, the other sees nothing failed', async () => {
      for (let i = 0; i < 5; i++) {
        tenant = await createTestTenant(pool);
        const [a] = await approvedDraft();
        await failProposal(a);
        const versionBefore = (await draftRow()).version;

        const [r1, r2] = await Promise.all([retry(), retry()]);
        const statuses = [r1.status, r2.status].sort();
        expect(statuses, `round ${i}`).toEqual([200, 409]);
        const loser = r1.status === 409 ? r1 : r2;
        expect(JSON.stringify(loser.body)).toContain('DRAFT_RETRY_NOTHING_FAILED');
        expect((await row(a)).status).toBe('approved');
        // Exactly one attempt was opened: the loser bumped nothing.
        expect((await draftRow()).version, `round ${i}`).toBe(versionBefore + 1);
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

    // ─── S4-4: retry's expectedVersion, undoable, and its races with undo ──

    describe('S4: expectedVersion, undoable and the locked set read', () => {
      const retryAt = (body?: object) => {
        const r = request(app).post('/api/onboarding/draft/retry');
        return body === undefined ? r.send() : r.send(body);
      };
      const undo = (expectedVersion: number) => request(app).post('/api/onboarding/draft/undo').send({ expectedVersion });
      const draftRepo = () => new PgOnboardingDraftRepository(pool);
      const owner = () => ({ userId: tenant.userId, role: 'owner' as const });
      const retryIn = (expectedVersion?: number) => () =>
        retryFailedDraftProposals({ draftRepo: draftRepo(), proposalRepo, auditRepo: new PgAuditRepository(pool) }, tenant.tenantId, owner(), { expectedVersion });
      const undoIn = (expectedVersion: number) => () =>
        undoApprovedDraft({ draftRepo: draftRepo(), proposalRepo, auditRepo: new PgAuditRepository(pool) }, tenant.tenantId, owner(), { expectedVersion });
      async function statusAt(now: Date) {
        return deriveOnboardingStatus(await loadOnboardingFacts({ pool, settingsRepo }, tenant.tenantId), now).draft;
      }
      async function approvedAt(id: string): Promise<Date> {
        return (await row(id)).approved_at as Date;
      }

      it.each([['with { expectedVersion: v }', true], ['with no body (as #1694 shipped)', false]])(
        'retry %s bumps to v + 1; the response, the row and the status block agree',
        async (_label, sendVersion) => {
          const ids = await approvedDraft();
          await failProposal(ids[0]);
          const v = (await draftRow()).version;
          const res = sendVersion ? await retryAt({ expectedVersion: v }) : await retryAt();
          expect(res.status).toBe(200);
          expect(res.body.draft.version).toBe(v + 1);
          expect((await draftRow()).version).toBe(v + 1);
          expect((await status()).status.draft?.version).toBe(v + 1);
          const audit = await pool.query(`SELECT metadata FROM audit_events WHERE tenant_id = $1 AND event_type = 'onboarding.draft_retry'`, [tenant.tenantId]);
          expect(audit.rows[0].metadata).toMatchObject({ draftVersionBefore: v, draftVersionAfter: v + 1 });

          // A second failure and a second retry move it by exactly one more.
          await failProposal(ids[0]);
          const again = sendVersion ? await retryAt({ expectedVersion: v + 1 }) : await retryAt();
          expect(again.body.draft.version).toBe(v + 2);
        },
      );

      it('a refused retry bumps nothing, whichever guard answers (table), and two guards at once answer the first', async () => {
        const cases: Array<{ name: string; arrange: (ids: string[], v: number) => Promise<object | undefined>; code: RegExp }> = [
          {
            name: 'DRAFT_NOT_APPROVED',
            arrange: async (_ids, v) => {
              await pool.query(`UPDATE onboarding_drafts SET status = 'draft' WHERE tenant_id = $1`, [tenant.tenantId]);
              return { expectedVersion: v + 9 };
            },
            code: /^DRAFT_NOT_APPROVED/,
          },
          { name: 'VERSION_CONFLICT', arrange: async (ids, v) => (await failProposal(ids[0]), { expectedVersion: v - 1 }), code: /^VERSION_CONFLICT/ },
          {
            name: 'DRAFT_RETRY_UNSAFE',
            arrange: async (ids, v) => (await failProposal(ids[0]), await setStatus(ids[1], 'undone'), { expectedVersion: v }),
            code: /^DRAFT_RETRY_UNSAFE/,
          },
          {
            name: 'DRAFT_RETRY_NOTHING_FAILED',
            arrange: async (ids, v) => (await setStatus(ids[1], 'executed'), { expectedVersion: v }),
            code: /^DRAFT_RETRY_NOTHING_FAILED/,
          },
          {
            name: 'stale version AND unsafe set -> VERSION_CONFLICT',
            arrange: async (ids, v) => (await failProposal(ids[0]), await setStatus(ids[1], 'undone'), { expectedVersion: v + 3 }),
            code: /^VERSION_CONFLICT/,
          },
        ];
        for (const c of cases) {
          tenant = await createTestTenant(pool);
          const ids = await approvedDraft();
          const body = await c.arrange(ids, (await draftRow()).version);
          const draftBefore = await draftRow();
          const proposalsBefore = await Promise.all(ids.map(row));
          const res = await retryAt(body);
          expect(res.status, c.name).toBe(409);
          expect(res.body.message, c.name).toMatch(c.code);
          expect(await draftRow(), c.name).toEqual(draftBefore);
          expect(await Promise.all(ids.map(row)), c.name).toEqual(proposalsBefore);
          const audit = await auditCounts();
          expect(audit['onboarding.draft_retry'] ?? 0, c.name).toBe(0);
          expect(audit['proposal.retried'] ?? 0, c.name).toBe(0);
        }
      });

      it('two retries at one version, 5 tenants: one 200, the loser waited and is VERSION_CONFLICT naming v and v + 1', async () => {
        for (let i = 0; i < 5; i++) {
          tenant = await createTestTenant(pool);
          const [a] = await approvedDraft();
          await failProposal(a);
          const v = (await draftRow()).version;
          const { first, second } = await raceFirstThen(pool, tenant.tenantId, retryIn(v), retryIn(v));
          expect(first.draft.version, `round ${i}`).toBe(v + 1);
          expect(second.status, `round ${i}`).toBe('rejected');
          expect((second as PromiseRejectedResult).reason, `round ${i}`).toMatchObject({ name: 'DraftVersionConflictError', expected: v, actual: v + 1 });
          expect((await draftRow()).version).toBe(v + 1);
          expect((await auditCounts())['proposal.retried']).toBe(1);
        }
      });

      it('a stale tab: A renders approval at v, B retries with v (v + 1), A undoes with v -> VERSION_CONFLICT naming v and v + 1; nothing changes; v + 1 then undoes to v + 2', async () => {
        const ids = await approvedDraft();
        const v = (await draftRow()).version;
        for (const id of ids) await failProposal(id);
        const b = await retryAt({ expectedVersion: v });
        expect(b.status).toBe(200);
        expect(b.body.undoable).toBe(true);
        const draftBefore = await draftRow();
        const proposalsBefore = await Promise.all(ids.map(row));
        const settingsBefore = (await pool.query(`SELECT * FROM tenant_settings WHERE tenant_id = $1`, [tenant.tenantId])).rows;

        const a = await undo(v);
        expect(a.status).toBe(409);
        expect(a.body.message).toMatch(new RegExp(`^VERSION_CONFLICT: expected ${v}, found ${v + 1}`));
        expect(await draftRow()).toEqual(draftBefore);
        expect(await Promise.all(ids.map(row))).toEqual(proposalsBefore);
        expect((await auditCounts())['onboarding.draft_undone'] ?? 0).toBe(0);
        expect((await pool.query(`SELECT * FROM tenant_settings WHERE tenant_id = $1`, [tenant.tenantId])).rows).toEqual(settingsBefore);

        const fresh = await undo(v + 1);
        expect(fresh.status).toBe(200);
        expect(fresh.body.draft).toMatchObject({ status: 'draft', version: v + 2 });
        for (const id of ids) expect((await row(id)).status).toBe('undone');
      });

      it('retry vs a stale undo, both orders, 5 tenants: never an undo of a retry its sender did not hold', async () => {
        for (let i = 0; i < 5; i++) {
          // Retry first (holding the lock), A's undo at v waits, then is VERSION_CONFLICT.
          tenant = await createTestTenant(pool);
          let ids = await approvedDraft();
          let v = (await draftRow()).version;
          for (const id of ids) await failProposal(id);
          const r1 = await raceFirstThen(pool, tenant.tenantId, retryIn(v), undoIn(v));
          expect(r1.first.draft.version).toBe(v + 1);
          expect(r1.second.status).toBe('rejected');
          expect((r1.second as PromiseRejectedResult).reason).toMatchObject({ name: 'DraftVersionConflictError', expected: v, actual: v + 1 });
          expect(await draftRow()).toMatchObject({ status: 'approved', version: v + 1 });
          for (const id of ids) expect((await row(id)).status).toBe('approved');

          // Undo first: it reads execution_failed members and refuses; the retry then succeeds.
          tenant = await createTestTenant(pool);
          ids = await approvedDraft();
          v = (await draftRow()).version;
          for (const id of ids) await failProposal(id);
          const refused = await undo(v);
          expect(refused.status).toBe(409);
          expect(refused.body.message).toMatch(/^DRAFT_UNDO_REFUSED: /);
          expect([...refused.body.details.statuses]).toEqual(['execution_failed', 'execution_failed']);
          const retried = await retryAt({ expectedVersion: v });
          expect(retried.status).toBe(200);
          expect((await draftRow()).version).toBe(v + 1);
          expect((await auditCounts())['onboarding.draft_undone'] ?? 0).toBe(0);
        }
      });

      describe('undo eligibility after a retry (fixed approved_at)', () => {
        it.each(['approved', 'executing', 'executed'])(
          '(a)/(e) partial retry beside a sibling %s: undoable false in the response and the status; the sibling row untouched',
          async (sibling) => {
            const [a, b] = await approvedDraft();
            await failProposal(a);
            // The sibling's first window is long over (the worker is behind, or ran it).
            await pool.query(`UPDATE proposals SET approved_at = NOW() - interval '30 seconds' WHERE tenant_id = $1 AND id = $2`, [tenant.tenantId, b]);
            if (sibling !== 'approved') await setStatus(b, sibling);
            const siblingBefore = await row(b);
            const v = (await draftRow()).version;

            const res = await retryAt({ expectedVersion: v });

            expect(res.status).toBe(200);
            expect(res.body.undoable).toBe(false);
            expect(await row(b)).toEqual(siblingBefore);
            expect((await row(a)).status).toBe('approved');
            const at = await approvedAt(a);
            expect((await statusAt(new Date(at.getTime() + 500)))?.undoable).toBe(false);
            expect(res.body.draft.version).toBe(v + 1);
          },
        );

        it('(b)-(d) full-set retry: undoable true until 4.0 s; a stale hint is still refused once the window closes or a member is claimed', async () => {
          let ids = await approvedDraft();
          for (const id of ids) await failProposal(id);
          const res = await retryAt({ expectedVersion: (await draftRow()).version });
          expect(res.body.undoable).toBe(true);
          const at = Math.max(...(await Promise.all(ids.map(approvedAt))).map((d) => d.getTime()));
          expect((await statusAt(new Date(at + 500)))?.undoable).toBe(true);
          expect((await statusAt(new Date(at + 3900)))?.undoable).toBe(true);
          // (c) the hint expires a second early, on the next read, with nothing else asked.
          expect((await statusAt(new Date(at + 4000)))?.undoable).toBe(false);

          // (b) an undo with the retry response's version inside the new window takes both back.
          const undone = await undo(res.body.draft.version);
          expect(undone.status).toBe(200);
          for (const id of ids) expect((await row(id)).status).toBe('undone');
          expect((await draftRow()).status).toBe('draft');

          // (d) the shell held undoable: true, but the window closed before the tap.
          tenant = await createTestTenant(pool);
          ids = await approvedDraft();
          for (const id of ids) await failProposal(id);
          const held = await retryAt({ expectedVersion: (await draftRow()).version });
          expect(held.body.undoable).toBe(true);
          await pool.query(`UPDATE proposals SET approved_at = NOW() - interval '6 seconds' WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenant.tenantId, ids]);
          let before = { draft: await draftRow(), proposals: await Promise.all(ids.map(row)) };
          const late = await undo(held.body.draft.version);
          expect(late.status).toBe(409);
          expect(late.body.message).toMatch(/^UNDO_WINDOW_CLOSED: /);
          expect({ draft: await draftRow(), proposals: await Promise.all(ids.map(row)) }).toEqual(before);

          // (d) and a worker claimed a member before the tap.
          tenant = await createTestTenant(pool);
          ids = await approvedDraft();
          for (const id of ids) await failProposal(id);
          const held2 = await retryAt({ expectedVersion: (await draftRow()).version });
          await proposalRepo.claimForExecution(ids[0], 'execution-worker');
          before = { draft: await draftRow(), proposals: await Promise.all(ids.map(row)) };
          const claimed = await undo(held2.body.draft.version);
          expect(claimed.status).toBe(409);
          expect(claimed.body.message).toMatch(/^DRAFT_UNDO_REFUSED: /);
          expect(claimed.body.details.statuses).toContain('executing');
          expect({ draft: await draftRow(), proposals: await Promise.all(ids.map(row)) }).toEqual(before);
          expect((await auditCounts())['onboarding.draft_undone'] ?? 0).toBe(0);
        });
      });

      it('an inbox undo of the approved sibling vs retry, both orders, 5 tenants: never a retry that passed its check on a stale read', async () => {
        const inboxUndo = (id: string) => () =>
          undoProposal(proposalRepo, tenant.tenantId, id, tenant.userId, 'owner', new PgAuditRepository(pool));
        for (let i = 0; i < 5; i++) {
          // Retry first: it re-queues; the inbox undo waited on the sibling's row lock, then lands on a plain split pair.
          tenant = await createTestTenant(pool);
          let [a, b] = await approvedDraft();
          await failProposal(a);
          const r1 = await raceFirstThen(pool, tenant.tenantId, retryIn(), inboxUndo(b));
          expect(r1.first.retriedProposalIds, `round ${i}`).toEqual([a]);
          expect(r1.second.status, `round ${i}`).toBe('fulfilled');
          expect([(await row(a)).status, (await row(b)).status]).toEqual(['approved', 'undone']);
          expect((await status()).status.draft?.execution).toBe('stopped');

          // Inbox undo first: the retry waits on the sibling's lock, reads `undone`, and is UNSAFE.
          tenant = await createTestTenant(pool);
          [a, b] = await approvedDraft();
          await failProposal(a);
          const v = (await draftRow()).version;
          const r2 = await raceFirstThen(pool, tenant.tenantId, inboxUndo(b), retryIn());
          expect(r2.second.status, `round ${i}`).toBe('rejected');
          expect(String((r2.second as PromiseRejectedResult).reason?.message), `round ${i}`).toMatch(/^DRAFT_RETRY_UNSAFE/);
          expect([(await row(a)).status, (await row(b)).status]).toEqual(['execution_failed', 'undone']);
          expect((await draftRow()).version).toBe(v);
        }
      });
    });
  });

  describe('fail, retry, succeed through the real executor and sweep', () => {
    const silentLogger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: () => silentLogger,
    };

    /** Records every run; the tenant-settings handler fails (returns success:false) until told otherwise. */
    function buildExecutor() {
      const runs: string[] = [];
      let settingsFails = true;
      const handler = (proposalType: 'onboarding_tenant_settings' | 'onboarding_voice_policy'): ExecutionHandler => ({
        proposalType,
        async execute(p) {
          runs.push(p.id);
          if (proposalType === 'onboarding_tenant_settings' && settingsFails) return { success: false, error: 'PACK_ACTIVATION_IN_PROGRESS' };
          return { success: true, resultEntityId: p.id };
        },
      });
      const executionRepo = new PgProposalExecutionRepository(pool);
      const guard = new IdempotencyGuard(executionRepo, proposalRepo, new PgIdempotencyLockProvider(pool));
      const executor = new ProposalExecutor(
        new Map<string, ExecutionHandler>([
          ['onboarding_tenant_settings', handler('onboarding_tenant_settings')],
          ['onboarding_voice_policy', handler('onboarding_voice_policy')],
        ]) as ConstructorParameters<typeof ProposalExecutor>[0],
        proposalRepo,
        guard,
        new PgAuditRepository(pool),
        { executionRepo },
      );
      return { executor, executionRepo, runs, healSettings: () => { settingsFails = false; } };
    }

    const sweep = (executor: ProposalExecutor) =>
      runExecutionSweep({ proposalRepo, executor, logger: silentLogger, auditRepo: new PgAuditRepository(pool) });
    const pastWindow = (id: string) =>
      pool.query(`UPDATE proposals SET approved_at = NOW() - interval '1 hour' WHERE tenant_id = $1 AND id = $2`, [tenant.tenantId, id]);
    const stored = async (id: string) =>
      (await pool.query<{ status: string }>(`SELECT status FROM proposals WHERE tenant_id = $1 AND id = $2`, [tenant.tenantId, id])).rows[0].status;

    it('a retried proposal executes once more, ends executed, and its execution history says succeeded (not the stale failed row)', async () => {
      const { executor, executionRepo, runs, healSettings } = buildExecutor();
      const ids = await approvedDraft();
      const settingsId = (await proposalRepo.findByTenant(tenant.tenantId)).find((p) => p.proposalType === 'onboarding_tenant_settings')!.id;
      const voiceId = ids.find((id) => id !== settingsId)!;
      for (const id of ids) await pastWindow(id);

      await sweep(executor);
      expect(await stored(settingsId)).toBe('execution_failed');
      expect(await stored(voiceId)).toBe('executed');
      expect((await status()).status.draft?.execution).toBe('failed');
      expect((await executionRepo.findLatestByProposal(tenant.tenantId, settingsId))?.status).toBe('failed');

      const retried = await request(app).post('/api/onboarding/draft/retry').send();
      expect(retried.status).toBe(200);
      expect(retried.body.retriedProposalIds).toEqual([settingsId]);
      // Inside the fresh undo window the worker leaves it alone.
      await sweep(executor);
      expect(await stored(settingsId)).toBe('approved');
      expect(runs.filter((id) => id === settingsId)).toHaveLength(1);

      healSettings();
      await pastWindow(settingsId);
      await sweep(executor);

      expect(await stored(settingsId)).toBe('executed');
      expect((await status()).status.draft?.execution).toBe('executed');
      // One handler run per attempt: two for the retried proposal, one for the other.
      expect(runs.filter((id) => id === settingsId)).toHaveLength(2);
      expect(runs.filter((id) => id === voiceId)).toHaveLength(1);

      const history = await executionRepo.listByProposal(tenant.tenantId, settingsId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ status: 'succeeded', errorMessage: undefined });
      expect((await executionRepo.findLatestByProposal(tenant.tenantId, settingsId))?.status).toBe('succeeded');
      // The idempotency marker exists, so a replay of the executed proposal short-circuits.
      expect(await executionRepo.findByIdempotencyKey(tenant.tenantId, `proposal-run:${tenant.tenantId}:${settingsId}`)).not.toBeNull();
    });
  });
});
