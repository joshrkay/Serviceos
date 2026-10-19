/**
 * Whole-draft reset (plan U9, S4-5) against real Postgres under RLS.
 *
 * POST /draft/reset ("Start over") is the locked way out of an approval that
 * can no longer finish as one unit: it reverts every member still `approved`
 * inside its window, expires every leftover still `draft` / `ready_for_review`
 * as `superseded_by_reset`, leaves every other member as it is, and returns the
 * draft to editing; or it refuses and writes nothing. Everything runs through
 * the production request transaction (`withTenantTransaction`) in front of the
 * real draft router and the real proposals router (the inbox), or, for the
 * scripted races, through `beginRequestTx` on two real connections. It pins the
 * real columns reset reads and writes (onboarding_drafts.status / proposal_ids
 * / approved_at / version / choices, proposals.status / approved_at /
 * undone_at / undone_by, audit_events.metadata) and the row locks that close
 * the races with the worker's claim and the inbox's undo and approve.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { beginRequestTx, raceFirstThen } from './onboarding-draft-request-tx';
import { createOnboardingDraftRouter } from '../../src/routes/onboarding-draft';
import { createProposalsRouter } from '../../src/routes/proposals';
import { PgOnboardingDraftRepository } from '../../src/onboarding/draft/repository';
import { resetApprovedDraft } from '../../src/onboarding/draft/reset';
import { PgRegionalPriceTierRepository } from '../../src/onboarding/choices/price-tiers';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { approveProposal, undoProposal } from '../../src/proposals/actions';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { loadOnboardingFacts } from '../../src/onboarding/load-facts';
import { deriveOnboardingStatus } from '../../src/onboarding/derive-status';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { PgIdempotencyLockProvider } from '../../src/proposals/execution/idempotency-lock';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import type { ExecutionHandler } from '../../src/proposals/execution/handlers';
import { runExecutionSweep } from '../../src/workers/execution-worker';
import type { Logger } from '../../src/logging/logger';

const BASE = '/api/onboarding/draft';
const CREATE = {
  packId: 'plumbing',
  businessName: 'Walsh Plumbing',
  ownerFirstName: 'Jenna',
  phone: '+12165550142',
  clientTimezone: 'America/New_York',
};
const OWNER_ROLE = 'owner' as const;
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

describe('POST /draft/reset (real DB)', () => {
  let pool: Pool;
  let draftRepo: PgOnboardingDraftRepository;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let settingsRepo: PgSettingsRepository;
  let tenant: { tenantId: string; userId: string };
  let app: express.Express;

  /** The production request transaction in front of the real draft router and the real inbox. */
  function buildApp(repo: PgProposalRepository): express.Express {
    const a = express();
    a.use(express.json());
    a.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: tenant.userId, sessionId: 's', tenantId: tenant.tenantId, role: OWNER_ROLE };
      next();
    });
    a.use('/api', withTenantTransaction(pool));
    a.use(BASE, createOnboardingDraftRouter({ draftRepo, tierRepo: new PgRegionalPriceTierRepository(pool), proposalRepo: repo, auditRepo }));
    a.use('/api/proposals', createProposalsRouter(repo, undefined, auditRepo));
    return a;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    draftRepo = new PgOnboardingDraftRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    await new PgRegionalPriceTierRepository(pool).upsert(
      'plumbing',
      'CLE',
      { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } },
      'test',
    );
    app = buildApp(proposalRepo);
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM regional_price_tiers WHERE trade = 'plumbing' AND metro_code = 'CLE' AND source = 'test'`);
    await closeSharedTestDb();
  });

  // ─── helpers ────────────────────────────────────────────────────────────

  const reset = (expectedVersion: number) => request(app).post(`${BASE}/reset`).send({ expectedVersion });
  const undo = (expectedVersion: number) => request(app).post(`${BASE}/undo`).send({ expectedVersion });
  const retry = (expectedVersion: number) => request(app).post(`${BASE}/retry`).send({ expectedVersion });
  const approve = () => request(app).post(`${BASE}/approve`).send({});
  const inboxUndo = (id: string) => request(app).post(`/api/proposals/${id}/undo`).send({});
  const inboxApprove = (id: string) => request(app).post(`/api/proposals/${id}/approve`).send({});

  /** Create, stage one choice, approve; returns the ids and the approve response's draft.version. */
  async function approvedDraft(): Promise<{ ids: string[]; version: number }> {
    const created = await request(app).post(BASE).send(CREATE);
    expect(created.status).toBe(201);
    const staged = await request(app).put(`${BASE}/choices/greeting`).send({ choice: { option: 'b' }, version: created.body.draft.version });
    expect(staged.status).toBe(200);
    const res = await approve();
    expect(res.status).toBe(200);
    return { ids: [...res.body.proposalIds].sort(), version: res.body.draft.version };
  }

  /** The finding's set: approve, then the owner undoes ONE member from the inbox (the real route). */
  async function splitDraft(): Promise<{ ids: string[]; version: number }> {
    const d = await approvedDraft();
    const res = await inboxUndo(d.ids[0]);
    expect(res.status).toBe(200);
    return d;
  }

  async function draftRow() {
    const r = await pool.query(
      `SELECT id, status, version, proposal_ids, approved_at, updated_at, choices, assembled, owner_phone, client_timezone, metro_code
         FROM onboarding_drafts WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    return r.rows[0];
  }
  async function proposalRows(ids: string[]) {
    const r = await pool.query(
      `SELECT id, status, approved_at, undone_at, undone_by, claimed_by, executed_at, updated_at
         FROM proposals WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`,
      [tenant.tenantId, ids],
    );
    return r.rows;
  }
  async function statusOf(id: string): Promise<string> {
    return (await pool.query<{ status: string }>(`SELECT status FROM proposals WHERE tenant_id = $1 AND id = $2`, [tenant.tenantId, id])).rows[0].status;
  }
  async function settingsRows() {
    return (await pool.query(`SELECT * FROM tenant_settings WHERE tenant_id = $1`, [tenant.tenantId])).rows;
  }
  async function catalogRows() {
    return (await pool.query(`SELECT * FROM catalog_items WHERE tenant_id = $1 ORDER BY id`, [tenant.tenantId])).rows;
  }
  async function executionRows(ids: string[]) {
    return (await pool.query(`SELECT * FROM proposal_executions WHERE tenant_id = $1 AND proposal_id = ANY($2::uuid[])`, [tenant.tenantId, ids])).rows;
  }
  async function auditCount(eventType: string): Promise<number> {
    const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND event_type = $2`, [
      tenant.tenantId,
      eventType,
    ]);
    return r.rows[0].n;
  }
  async function auditRows(eventType: string) {
    return (
      await pool.query(`SELECT entity_id, actor_id, actor_role, metadata FROM audit_events WHERE tenant_id = $1 AND event_type = $2 ORDER BY created_at`, [
        tenant.tenantId,
        eventType,
      ])
    ).rows;
  }
  async function setStatus(id: string, status: string): Promise<void> {
    await pool.query(`UPDATE proposals SET status = $3 WHERE tenant_id = $1 AND id = $2`, [tenant.tenantId, id, status]);
  }
  async function ageApproval(ids: string[], ms: number): Promise<void> {
    await pool.query(`UPDATE proposals SET approved_at = NOW() - make_interval(secs => $3) WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [
      tenant.tenantId,
      ids,
      ms / 1000,
    ]);
  }
  async function hint() {
    const facts = await loadOnboardingFacts({ pool, settingsRepo }, tenant.tenantId);
    return deriveOnboardingStatus(facts).draft;
  }
  /** Polls pg_stat_activity until a backend running `fragment` is parked on a lock. */
  async function waitForBlockedQuery(fragment: string): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const r = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`, [`%${fragment}%`]);
      if (r.rows.length > 0) return;
      if (Date.now() > deadline) throw new Error(`no backend running "${fragment}" blocked within 5s`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  const actor = () => ({ userId: tenant.userId, role: OWNER_ROLE });
  const resetIn = (expectedVersion: number) => () => resetApprovedDraft({ draftRepo, proposalRepo, auditRepo }, tenant.tenantId, actor(), { expectedVersion });

  /** The real executor and sweep with handlers that succeed and record each run. */
  function buildExecutor() {
    const runs: string[] = [];
    const handler = (proposalType: 'onboarding_tenant_settings' | 'onboarding_voice_policy'): ExecutionHandler => ({
      proposalType,
      async execute(p) {
        runs.push(p.id);
        return { success: true, resultEntityId: p.id };
      },
    });
    const executionRepo = new PgProposalExecutionRepository(pool);
    const executor = new ProposalExecutor(
      new Map<string, ExecutionHandler>([
        ['onboarding_tenant_settings', handler('onboarding_tenant_settings')],
        ['onboarding_voice_policy', handler('onboarding_voice_policy')],
      ]) as ConstructorParameters<typeof ProposalExecutor>[0],
      proposalRepo,
      new IdempotencyGuard(executionRepo, proposalRepo, new PgIdempotencyLockProvider(pool)),
      auditRepo,
      { executionRepo },
    );
    const sweep = () => runExecutionSweep({ proposalRepo, executor, logger: silentLogger, auditRepo });
    return { runs, sweep };
  }

  // ─── the finding ───────────────────────────────────────────────────────

  it('the finding: an inbox-split pair is stopped (reset), retry and undo refuse it, reset reverts the other half and the draft is editable; the next approval mints a fresh pair', async () => {
    const { ids, version } = await splitDraft();
    expect(await statusOf(ids[0])).toBe('undone');
    expect(await hint()).toMatchObject({ status: 'approved', execution: 'stopped', recovery: 'reset', undoable: false });
    expect((await retry(version)).body.message).toMatch(/^DRAFT_RETRY_UNSAFE: /);
    expect((await undo(version)).body.message).toMatch(/^DRAFT_UNDO_REFUSED: /);
    const settingsBefore = await settingsRows();
    const draftBefore = await draftRow();

    const res = await reset(version);

    expect(res.status).toBe(200);
    expect(res.body.draft).toMatchObject({ status: 'draft', proposalIds: [], approvedAt: null, version: version + 1, choices: { greeting: { option: 'b' } } });
    const after = await draftRow();
    expect(after).toEqual({ ...draftBefore, status: 'draft', proposal_ids: [], approved_at: null, version: version + 1, updated_at: after.updated_at });
    const [first, second] = await proposalRows(ids);
    expect(first.status).toBe('undone');
    expect(second).toMatchObject({ status: 'undone', undone_by: tenant.userId });
    expect(second.undone_at).toBeInstanceOf(Date);
    expect(await settingsRows()).toEqual(settingsBefore);
    // One proposal.undone from the inbox, one from the reset (tagged), one draft_reset.
    const undoneRows = await auditRows('proposal.undone');
    expect(undoneRows.map((r) => r.entity_id)).toEqual([ids[0], ids[1]]);
    expect(undoneRows[1].metadata).toMatchObject({ draftId: draftBefore.id, via: 'reset' });
    const resetRows = await auditRows('onboarding.draft_reset');
    expect(resetRows).toHaveLength(1);
    expect(resetRows[0]).toMatchObject({ entity_id: draftBefore.id, actor_id: tenant.userId, actor_role: 'owner' });
    expect(resetRows[0].metadata).toEqual({
      reverted: [ids[1]],
      superseded: [],
      others: [{ id: ids[0], status: 'undone' }],
      supersededReason: 'superseded_by_reset',
      draftVersionBefore: version,
      draftVersionAfter: version + 1,
    });
    expect(await auditCount('onboarding.draft_undone')).toBe(0);
    expect(await hint()).toMatchObject({ status: 'draft', version: version + 1 });
    expect(await hint()).not.toHaveProperty('recovery');

    // Editing again: a choice PUT at the new version, then a fresh approval beside the two old rows.
    const oldRows = await proposalRows(ids);
    const restage = await request(app).put(`${BASE}/choices/greeting`).send({ choice: { option: 'a' }, version: version + 1 });
    expect(restage.status).toBe(200);
    const again = await approve();
    expect(again.status).toBe(200);
    const fresh: string[] = [...again.body.proposalIds].sort();
    expect(fresh).toHaveLength(2);
    expect(fresh.some((id) => ids.includes(id))).toBe(false);
    const all = await pool.query(`SELECT count(*)::int AS n FROM proposals WHERE tenant_id = $1`, [tenant.tenantId]);
    expect(all.rows[0].n).toBe(4);
    expect(await proposalRows(ids)).toEqual(oldRows);
  });

  // ─── accepted sets ─────────────────────────────────────────────────────

  describe('accepted sets: each ends editable with exactly one onboarding.draft_reset', () => {
    type Member = 'approved' | 'undone' | 'rejected' | 'expired' | 'execution_failed' | 'draft' | 'ready_for_review' | 'missing';
    const table: Array<[string, Member, Member]> = [
      ['undone + undone', 'undone', 'undone'],
      ['rejected + approved in the window', 'rejected', 'approved'],
      ['expired + approved in the window', 'expired', 'approved'],
      ['execution_failed + undone', 'execution_failed', 'undone'],
      ['execution_failed + execution_failed', 'execution_failed', 'execution_failed'],
      ['a stray draft member + undone', 'draft', 'undone'],
      ['a stray ready_for_review member + undone', 'ready_for_review', 'undone'],
      ['a listed id with no row + approved in the window', 'missing', 'approved'],
      ['all approved in the window', 'approved', 'approved'],
    ];
    const ending: Record<Member, string> = {
      approved: 'undone',
      undone: 'undone',
      rejected: 'rejected',
      expired: 'expired',
      execution_failed: 'execution_failed',
      draft: 'expired',
      ready_for_review: 'expired',
      missing: 'missing',
    };

    it.each(table)('%s', async (_name, a, b) => {
      const { ids, version } = await approvedDraft();
      const members: Member[] = [a, b];
      let listed = ids;
      for (const [i, status] of members.entries()) {
        if (status === 'missing') {
          listed = ids.map((id, j) => (j === i ? crypto.randomUUID() : id));
          await pool.query(`UPDATE onboarding_drafts SET proposal_ids = $2::jsonb WHERE tenant_id = $1`, [tenant.tenantId, JSON.stringify(listed)]);
        } else if (status !== 'approved') {
          await setStatus(ids[i], status);
        }
      }
      const h = await hint();
      if (h?.execution === 'stopped' || h?.execution === 'failed') expect(h.recovery).toBe('reset');

      const res = await reset(version);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await draftRow()).toMatchObject({ status: 'draft', version: version + 1, proposal_ids: [], approved_at: null, choices: { greeting: { option: 'b' } } });
      for (const [i, status] of members.entries()) {
        if (status === 'missing') continue;
        expect(await statusOf(ids[i]), `member ${i} (${status})`).toBe(ending[status]);
      }
      expect(await auditCount('onboarding.draft_reset')).toBe(1);
      expect(await auditCount('proposal.undone')).toBe(members.filter((m) => m === 'approved').length);
      expect(await auditCount('proposal.expired')).toBe(members.filter((m) => m === 'draft' || m === 'ready_for_review').length);
      if (members.includes('missing')) {
        const meta = (await auditRows('onboarding.draft_reset'))[0].metadata;
        expect(meta.others).toEqual([{ id: listed[members.indexOf('missing')], status: 'missing' }]);
      }
    });
  });

  // ─── leftovers superseded ──────────────────────────────────────────────

  describe('leftovers still draft / ready_for_review are superseded, never left approvable', () => {
    it('both expired with one proposal.expired each; the inbox lists neither; approving either is the lifecycle 409 and nothing applies; a fresh pair then executes', async () => {
      const { ids, version } = await approvedDraft();
      await setStatus(ids[0], 'draft');
      await setStatus(ids[1], 'ready_for_review');
      const inboxBefore = await request(app).get('/api/proposals/inbox');
      expect(JSON.stringify(inboxBefore.body)).toContain(ids[0]);
      expect(JSON.stringify(inboxBefore.body)).toContain(ids[1]);
      const draftId = (await draftRow()).id;
      const settingsBefore = await settingsRows();
      const catalogBefore = await catalogRows();

      const res = await reset(version);

      expect(res.status).toBe(200);
      for (const id of ids) expect(await statusOf(id)).toBe('expired');
      const expiredRows = await auditRows('proposal.expired');
      expect(expiredRows.map((r) => r.entity_id).sort()).toEqual(ids);
      for (const r of expiredRows) {
        expect(r).toMatchObject({ actor_id: tenant.userId, actor_role: 'owner' });
        expect(r.metadata).toMatchObject({ reason: 'superseded_by_reset', draftId, status: 'expired' });
      }
      expect((await auditRows('onboarding.draft_reset'))[0].metadata).toMatchObject({ superseded: ids, reverted: [], others: [] });

      // Absent from the inbox: not in its open list, its expired list or its failed list.
      const inbox = await request(app).get('/api/proposals/inbox');
      expect(inbox.status).toBe(200);
      for (const id of ids) expect(JSON.stringify(inbox.body)).not.toContain(id);

      // A stale tap on either card: the lifecycle 409, nothing applied.
      for (const id of ids) {
        const tap = await inboxApprove(id);
        expect(tap.status).toBe(409);
        expect(tap.body.message).toBe("Cannot transition proposal from 'expired' to 'approved'");
        expect(await statusOf(id)).toBe('expired');
      }
      expect(await auditCount('proposal.approved')).toBe(2); // the original approval only
      expect(await executionRows(ids)).toEqual([]);
      expect(await settingsRows()).toEqual(settingsBefore);
      expect(await catalogRows()).toEqual(catalogBefore);

      // Edit and approve again: a new pair, the draft lists only it, and it executes; the old pair stays expired.
      const restage = await request(app).put(`${BASE}/choices/greeting`).send({ choice: { option: 'a' }, version: version + 1 });
      expect(restage.status).toBe(200);
      const again = await approve();
      expect(again.status).toBe(200);
      const fresh: string[] = [...again.body.proposalIds].sort();
      expect((await draftRow()).proposal_ids.sort()).toEqual(fresh);
      const { runs, sweep } = buildExecutor();
      await ageApproval(fresh, 60_000);
      await sweep();
      for (const id of fresh) expect(await statusOf(id)).toBe('executed');
      for (const id of ids) {
        expect(runs).not.toContain(id);
        expect(await statusOf(id)).toBe('expired');
        expect((await inboxApprove(id)).status).toBe(409);
      }
      expect((await hint())?.execution).toBe('executed');
    });

    it.each([
      ['executing + draft', 'executing', 'draft', /^DRAFT_RESET_REFUSED: /, 'executing'],
      ['executed + ready_for_review', 'executed', 'ready_for_review', /^DRAFT_RESET_REFUSED: /, 'applied'],
      ['approved past its window + draft', 'approved', 'draft', /^UNDO_WINDOW_CLOSED: /, undefined],
    ] as const)('%s: refused, and the leftover is not superseded (a refused reset writes nothing)', async (_name, a, b, code, reason) => {
      const { ids, version } = await approvedDraft();
      if (a === 'approved') await ageApproval([ids[0]], 5000);
      else await setStatus(ids[0], a);
      await setStatus(ids[1], b);
      const draftBefore = await draftRow();
      const rowsBefore = await proposalRows(ids);

      const res = await reset(version);

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(code);
      if (reason) expect(res.body.details.reason).toBe(reason);
      expect(await draftRow()).toEqual(draftBefore);
      expect(await proposalRows(ids)).toEqual(rowsBefore);
      expect(await statusOf(ids[1])).toBe(b);
      expect(await auditCount('proposal.expired')).toBe(0);
      expect(await auditCount('onboarding.draft_reset')).toBe(0);
    });

    it('atomicity: the second leftover\'s write throwing rolls the first back; neither has an audit row, the draft is still approved at the same version', async () => {
      const { ids, version } = await approvedDraft();
      await setStatus(ids[0], 'draft');
      await setStatus(ids[1], 'ready_for_review');
      /** The real repository on the real request connection, with the second member's write failing. */
      class SecondWriteFails extends PgProposalRepository {
        override async updateStatusIf(...args: Parameters<PgProposalRepository['updateStatusIf']>) {
          if (args[1] === ids[1]) throw new Error('connection lost');
          return super.updateStatusIf(...args);
        }
      }
      const failing = buildApp(new SecondWriteFails(pool));
      const draftBefore = await draftRow();
      const rowsBefore = await proposalRows(ids);

      const res = await request(failing).post(`${BASE}/reset`).send({ expectedVersion: version });

      expect(res.status).toBe(500);
      expect(await proposalRows(ids)).toEqual(rowsBefore);
      expect(await statusOf(ids[0])).toBe('draft');
      expect(await statusOf(ids[1])).toBe('ready_for_review');
      expect(await auditCount('proposal.expired')).toBe(0);
      expect(await auditCount('onboarding.draft_reset')).toBe(0);
      expect(await draftRow()).toEqual(draftBefore);
      expect(draftBefore).toMatchObject({ status: 'approved', version });
    });
  });

  // ─── refusals ──────────────────────────────────────────────────────────

  describe('refused: nothing written, and the status points where the endpoint will', () => {
    async function expectRefused(ids: string[], version: number, code: RegExp) {
      const draftBefore = await draftRow();
      const rowsBefore = await proposalRows(ids);
      const auditBefore = (await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1`, [tenant.tenantId])).rows[0].n;
      const res = await reset(version);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(code);
      expect(await draftRow()).toEqual(draftBefore);
      expect(await proposalRows(ids)).toEqual(rowsBefore);
      const auditAfter = (await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1`, [tenant.tenantId])).rows[0].n;
      expect(auditAfter).toBe(auditBefore);
      return res;
    }

    it('executed + undone (the sibling ran before the inbox undo): DRAFT_RESET_REFUSED applied; the status is stopped with recovery settings', async () => {
      const { ids, version } = await approvedDraft();
      await setStatus(ids[0], 'undone');
      await setStatus(ids[1], 'executed');
      const res = await expectRefused(ids, version, /^DRAFT_RESET_REFUSED: /);
      expect(res.body.details).toEqual({ reason: 'applied', statuses: ['undone', 'executed'], expected: 2 });
      expect(res.body.message).toMatch(/Settings/);
      // The same screen whether the 409 answered a tap made before the poll caught up or not.
      expect(await hint()).toMatchObject({ execution: 'stopped', recovery: 'settings' });
      // TODO(U6, S5): POST /draft/reopen must refuse this set too (not every member executed), so the
      // Settings pointer stays the one way forward. Reopen does not exist yet; it is not stubbed here.
    });

    it('executing + undone: DRAFT_RESET_REFUSED executing; once it executes the next try is applied, once it fails the next try is accepted', async () => {
      for (const outcome of ['executed', 'execution_failed'] as const) {
        tenant = await createTestTenant(pool);
        const { ids, version } = await approvedDraft();
        await setStatus(ids[0], 'undone');
        await setStatus(ids[1], 'executing');
        const res = await expectRefused(ids, version, /^DRAFT_RESET_REFUSED: /);
        expect(res.body.details.reason).toBe('executing');

        await setStatus(ids[1], outcome);
        const next = await reset(version);
        if (outcome === 'executed') {
          expect(next.status).toBe(409);
          expect(next.body.details.reason).toBe('applied');
        } else {
          expect(next.status).toBe(200);
          expect((await draftRow()).status).toBe('draft');
          expect(await statusOf(ids[1])).toBe('execution_failed');
        }
      }
    });

    it('approved past its window + undone: UNDO_WINDOW_CLOSED, and the status says settings', async () => {
      const { ids, version } = await splitDraft();
      await ageApproval([ids[1]], 5000);
      await expectRefused(ids, version, /^UNDO_WINDOW_CLOSED: /);
      expect(await hint()).toMatchObject({ execution: 'stopped', recovery: 'settings' });
    });

    it('a second reset, and a reset after undo, find the draft editing: DRAFT_NOT_APPROVED', async () => {
      const first = await splitDraft();
      expect((await reset(first.version)).status).toBe(200);
      const again = await reset(first.version);
      expect(again.status).toBe(409);
      expect(again.body.message).toMatch(/^DRAFT_NOT_APPROVED: /);
      expect(await auditCount('onboarding.draft_reset')).toBe(1);

      tenant = await createTestTenant(pool);
      const second = await approvedDraft();
      expect((await undo(second.version)).status).toBe(200);
      const afterUndo = await reset(second.version);
      expect(afterUndo.status).toBe(409);
      expect(afterUndo.body.message).toMatch(/^DRAFT_NOT_APPROVED: /);
      expect(await auditCount('onboarding.draft_reset')).toBe(0);
    });

    it('a stale expectedVersion after a reset and a fresh approval: VERSION_CONFLICT, the new pair untouched', async () => {
      const { version: v } = await splitDraft();
      expect((await reset(v)).status).toBe(200);
      const restage = await request(app).put(`${BASE}/choices/greeting`).send({ choice: { option: 'a' }, version: v + 1 });
      expect(restage.status).toBe(200);
      const again = await approve();
      expect(again.body.draft.version).toBe(v + 3);
      const fresh: string[] = [...again.body.proposalIds].sort();
      const freshBefore = await proposalRows(fresh);
      const draftBefore = await draftRow();

      const stale = await reset(v);

      expect(stale.status).toBe(409);
      expect(stale.body.message).toMatch(new RegExp(`^VERSION_CONFLICT: expected ${v}, found ${v + 3}`));
      expect(await proposalRows(fresh)).toEqual(freshBefore);
      expect(await draftRow()).toEqual(draftBefore);
      for (const p of freshBefore) expect(p.status).toBe('approved');
    });
  });

  // ─── the hint never outruns the window ─────────────────────────────────

  describe('the recovery hint never outruns the window', () => {
    it('undone + approved: reset at 3 s is 200; at 4.5 s and 5.2 s the hint is settings and a reset at 5.2 s is UNDO_WINDOW_CLOSED with nothing changed', async () => {
      const early = await splitDraft();
      await ageApproval([early.ids[1]], 3000);
      expect(await hint()).toMatchObject({ execution: 'stopped', recovery: 'reset' });
      expect((await reset(early.version)).status).toBe(200);

      tenant = await createTestTenant(pool);
      const late = await splitDraft();
      await ageApproval([late.ids[1]], 4500);
      expect(await hint()).toMatchObject({ execution: 'stopped', recovery: 'settings' });
      await ageApproval([late.ids[1]], 5200);
      expect(await hint()).toMatchObject({ execution: 'stopped', recovery: 'settings' });
      const draftBefore = await draftRow();
      const rowsBefore = await proposalRows(late.ids);
      const res = await reset(late.version);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/^UNDO_WINDOW_CLOSED: /);
      expect(await draftRow()).toEqual(draftBefore);
      expect(await proposalRows(late.ids)).toEqual(rowsBefore);
    });

    it('delayed worker: the sibling sits approved and unclaimed 30 s past its window: settings, reset refused; when the worker resumes it executes and the hint stays settings', async () => {
      const { ids, version } = await splitDraft();
      await ageApproval([ids[1]], 35_000);
      expect(await hint()).toMatchObject({ execution: 'stopped', recovery: 'settings' });
      expect((await reset(version)).body.message).toMatch(/^UNDO_WINDOW_CLOSED: /);

      const { runs, sweep } = buildExecutor();
      await sweep();
      expect(runs).toContain(ids[1]);
      expect(runs).not.toContain(ids[0]);
      expect(await statusOf(ids[1])).toBe('executed');
      expect(await hint()).toMatchObject({ execution: 'stopped', recovery: 'settings' });
      expect((await reset(version)).body.details.reason).toBe('applied');
    });

    it('execution_failed + approved past its window: failed with recovery settings (Retry offered, Start over not)', async () => {
      const { ids } = await approvedDraft();
      await setStatus(ids[0], 'execution_failed');
      await ageApproval([ids[1]], 6000);
      expect(await hint()).toMatchObject({ execution: 'failed', recovery: 'settings' });
    });

    it('sweep 0-8 s in 250 ms steps: whenever the status says recovery reset, a reset at that instant is not refused for the window', async () => {
      const seen = { reset: 0, settings: 0 };
      for (let offset = 0; offset <= 8000; offset += 250) {
        tenant = await createTestTenant(pool);
        const { ids, version } = await splitDraft();
        await ageApproval([ids[1]], offset);
        const block = await hint();
        const res = await reset(version);
        if (block?.recovery === 'reset') {
          seen.reset++;
          expect(res.status, `offset ${offset} ms: ${JSON.stringify(res.body)}`).toBe(200);
        } else {
          seen.settings++;
          expect(block?.recovery, `offset ${offset} ms`).toBe('settings');
          if (offset >= 5000) expect(res.body.message, `offset ${offset} ms`).toMatch(/^UNDO_WINDOW_CLOSED: /);
        }
        if (offset <= 3000) expect(block?.recovery, `offset ${offset} ms`).toBe('reset');
        if (offset >= 4000) expect(block?.recovery, `offset ${offset} ms`).toBe('settings');
      }
      expect(seen.reset).toBeGreaterThan(10);
      expect(seen.settings).toBeGreaterThan(10);
    });
  });

  // ─── races on two real connections ─────────────────────────────────────

  describe('races (looped on 5 tenants, both orders)', () => {
    it('(a) a worker claim that arrives while reset holds the set waits, then matches nothing: no handler, the draft is editing', async () => {
      for (let i = 0; i < 5; i++) {
        tenant = await createTestTenant(pool);
        const { ids, version } = await splitDraft();
        const tx = await beginRequestTx(pool, tenant.tenantId);
        try {
          const done = await tx.run(resetIn(version));
          expect(done.draft.status).toBe('draft');
          const claim = proposalRepo.claimForExecution(ids[1], 'execution-worker');
          await waitForBlockedQuery(`SET status = 'executing'`);
          await tx.commit();
          expect(await claim, `round ${i}`).toBeNull();
        } finally {
          await tx.rollback();
        }
        for (const p of await proposalRows(ids)) expect(p.status, `round ${i}`).toBe('undone');
        expect((await draftRow()).status, `round ${i}`).toBe('draft');
      }
    });

    it('(b) a claim that committed first reads as executing: reset refused, the draft stays approved, the claimed row untouched', async () => {
      for (let i = 0; i < 5; i++) {
        tenant = await createTestTenant(pool);
        const { ids, version } = await splitDraft();
        const claimed = await proposalRepo.claimForExecution(ids[1], 'execution-worker');
        expect(claimed?.status).toBe('executing');
        const before = await proposalRows(ids);
        const res = await reset(version);
        expect(res.status, `round ${i}`).toBe(409);
        expect(res.body.details.reason, `round ${i}`).toBe('executing');
        expect(await proposalRows(ids)).toEqual(before);
        expect((await draftRow()).status, `round ${i}`).toBe('approved');
      }
    });

    it('(c) the inbox undo of the surviving sibling vs reset, both orders: both end undone, the draft ends editing, never a half-written set', async () => {
      for (let i = 0; i < 5; i++) {
        for (const order of ['inbox-first', 'reset-first'] as const) {
          tenant = await createTestTenant(pool);
          const { ids, version } = await splitDraft();
          const inbox = () => undoProposal(proposalRepo, tenant.tenantId, ids[1], tenant.userId, OWNER_ROLE, auditRepo);
          if (order === 'inbox-first') {
            const { first, second } = await raceFirstThen(pool, tenant.tenantId, inbox, resetIn(version));
            expect(first.status).toBe('undone');
            // The reset waited on the row lock, then found nothing left to revert.
            expect(second.status, `round ${i} ${order}`).toBe('fulfilled');
            expect((second as PromiseFulfilledResult<Awaited<ReturnType<ReturnType<typeof resetIn>>>>).value.revertedProposalIds).toEqual([]);
          } else {
            const { first, second } = await raceFirstThen(pool, tenant.tenantId, resetIn(version), inbox);
            expect(first.revertedProposalIds).toEqual([ids[1]]);
            // The inbox undo waited on the row lock; it is a typed refusal or a status no-op on an undone row.
            if (second.status === 'fulfilled') expect(second.value.status).toBe('undone');
            else expect(String(second.reason?.message)).toMatch(/undone|Cannot/);
          }
          for (const p of await proposalRows(ids)) expect(p.status, `round ${i} ${order}`).toBe('undone');
          expect(await draftRow(), `round ${i} ${order}`).toMatchObject({ status: 'draft', version: version + 1, proposal_ids: [] });
          expect(await auditCount('onboarding.draft_reset')).toBe(1);
        }
      }
    });

    it('(d) an inbox approve of a draft member vs reset, both orders: approve first is then undone by the reset; reset first leaves it expired, never approved', async () => {
      for (let i = 0; i < 5; i++) {
        for (const order of ['approve-first', 'reset-first'] as const) {
          tenant = await createTestTenant(pool);
          const { ids, version } = await approvedDraft();
          await setStatus(ids[0], 'draft');
          await setStatus(ids[1], 'undone');
          const tap = () => approveProposal(proposalRepo, tenant.tenantId, ids[0], tenant.userId, OWNER_ROLE, auditRepo, 'ui');
          if (order === 'approve-first') {
            const { first, second } = await raceFirstThen(pool, tenant.tenantId, tap, resetIn(version));
            expect(first.status).toBe('approved');
            expect(second.status, `round ${i} ${order}`).toBe('fulfilled');
            expect(await statusOf(ids[0]), `round ${i} ${order}`).toBe('undone');
          } else {
            const { first, second } = await raceFirstThen(pool, tenant.tenantId, resetIn(version), tap);
            expect(first.supersededProposalIds).toEqual([ids[0]]);
            expect(second.status, `round ${i} ${order}`).toBe('rejected');
            expect(String((second as PromiseRejectedResult).reason?.message)).toBe("Cannot transition proposal from 'expired' to 'approved'");
            expect(await statusOf(ids[0]), `round ${i} ${order}`).toBe('expired');
          }
          expect((await draftRow()).status, `round ${i} ${order}`).toBe('draft');
          // Never: an editable draft beside a member that is approved, applying or applied.
          for (const p of await proposalRows(ids)) expect(['approved', 'executing', 'executed']).not.toContain(p.status);
        }
      }
    });
  });
});
