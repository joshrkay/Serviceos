/**
 * Whole-draft undo (plan U9, S4-4) against real Postgres under RLS.
 *
 * POST /draft/undo takes back EVERY proposal an approval made, or none, and
 * returns the draft to editing. Everything here runs through the production
 * request transaction (`withTenantTransaction`) in front of the real router, or,
 * for the scripted races, through `beginRequestTx` (the same BEGIN + tenant
 * context on two real connections). It pins the real columns undo reads and
 * writes (onboarding_drafts.status / proposal_ids / approved_at / version,
 * proposals.status / approved_at / undone_at / undone_by) and the row locks that
 * close the race with the worker's claim at the five-second boundary.
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
import { undoApprovedDraft } from '../../src/onboarding/draft/undo';
import { PgRegionalPriceTierRepository } from '../../src/onboarding/choices/price-tiers';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { loadOnboardingFacts } from '../../src/onboarding/load-facts';
import { deriveOnboardingStatus } from '../../src/onboarding/derive-status';
import type { AuthenticatedRequest } from '../../src/auth/clerk';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { PgTenantTransactionRunner } from '../../src/db/tenant-transaction';

const BASE = '/api/onboarding/draft';
const CREATE = {
  packId: 'plumbing',
  businessName: 'Walsh Plumbing',
  ownerFirstName: 'Jenna',
  phone: '+12165550142',
  clientTimezone: 'America/New_York',
};
const OWNER_ROLE = 'owner' as const;

describe('POST /draft/undo (real DB)', () => {
  let pool: Pool;
  let draftRepo: PgOnboardingDraftRepository;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let settingsRepo: PgSettingsRepository;
  let tenant: { tenantId: string; userId: string };
  let app: express.Express;

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
    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: tenant.userId, sessionId: 's', tenantId: tenant.tenantId, role: OWNER_ROLE };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.use(BASE, createOnboardingDraftRouter({ draftRepo, tierRepo: new PgRegionalPriceTierRepository(pool), proposalRepo, auditRepo }));
    // The inbox, for the split-pair case (one member undone from it).
    app.use('/api/proposals', createProposalsRouter(proposalRepo, new PgTenantTransactionRunner(pool), undefined, auditRepo));
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM regional_price_tiers WHERE trade = 'plumbing' AND metro_code = 'CLE' AND source = 'test'`);
    await closeSharedTestDb();
  });

  // ─── helpers ────────────────────────────────────────────────────────────

  const undo = (expectedVersion: number) => request(app).post(`${BASE}/undo`).send({ expectedVersion });
  const approve = () => request(app).post(`${BASE}/approve`).send({});

  /** Create and approve; returns the ids and the approve response's draft.version (what the saving screen holds). */
  async function approvedDraft(): Promise<{ ids: string[]; version: number }> {
    const created = await request(app).post(BASE).send(CREATE);
    expect(created.status).toBe(201);
    const res = await approve();
    expect(res.status).toBe(200);
    return { ids: [...res.body.proposalIds].sort(), version: res.body.draft.version };
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
  async function settingsRows() {
    return (await pool.query(`SELECT * FROM tenant_settings WHERE tenant_id = $1`, [tenant.tenantId])).rows;
  }
  async function auditCount(eventType: string): Promise<number> {
    const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND event_type = $2`, [
      tenant.tenantId,
      eventType,
    ]);
    return r.rows[0].n;
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
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  const actor = () => ({ userId: tenant.userId, role: OWNER_ROLE });
  const undoIn = (expectedVersion: number) => () => undoApprovedDraft({ draftRepo, proposalRepo, auditRepo }, tenant.tenantId, actor(), { expectedVersion });

  // ─── happy path ─────────────────────────────────────────────────────────

  it('inside the window: both proposals undone, the draft editable again at version + 1, settings untouched, audited', async () => {
    const { ids, version } = await approvedDraft();
    const settingsBefore = await settingsRows();
    const draftBefore = await draftRow();
    expect(draftBefore).toMatchObject({ status: 'approved', version });
    expect(draftBefore.approved_at).toBeInstanceOf(Date);

    const res = await undo(version);

    expect(res.status).toBe(200);
    expect(res.body.draft).toMatchObject({ status: 'draft', proposalIds: [], approvedAt: null, version: version + 1 });
    const after = await draftRow();
    expect(after).toEqual({ ...draftBefore, status: 'draft', proposal_ids: [], approved_at: null, version: version + 1, updated_at: after.updated_at });
    for (const p of await proposalRows(ids)) {
      expect(p.status).toBe('undone');
      expect(p.undone_at).toBeInstanceOf(Date);
      expect(p.undone_by).toBe(tenant.userId);
    }
    expect(await settingsRows()).toEqual(settingsBefore);
    expect(await auditCount('onboarding.draft_undone')).toBe(1);
    expect(await auditCount('proposal.undone')).toBe(2);
    const audit = await pool.query(`SELECT entity_id, actor_id, metadata FROM audit_events WHERE tenant_id = $1 AND event_type = 'onboarding.draft_undone'`, [tenant.tenantId]);
    expect(audit.rows[0]).toMatchObject({ entity_id: draftBefore.id, actor_id: tenant.userId });
    expect(audit.rows[0].metadata).toMatchObject({ proposalIds: ids, draftVersionBefore: version, draftVersionAfter: version + 1 });

    // The status agrees: editing again, no hints; the inbox never sees the undone pair.
    expect(await hint()).toMatchObject({ status: 'draft', version: version + 1 });
    expect(await hint()).not.toHaveProperty('undoable');
    // And the owner can approve again, minting a fresh pair.
    const again = await approve();
    expect(again.status).toBe(200);
    expect(again.body.draft.version).toBe(version + 2);
    expect([...again.body.proposalIds].sort()).not.toEqual(ids);
  });

  // ─── refusals ───────────────────────────────────────────────────────────

  describe('every refusal changes no row', () => {
    async function expectRefused(ids: string[], version: number, code: RegExp, statuses?: string[]) {
      const draftBefore = await draftRow();
      const proposalsBefore = await proposalRows(ids);
      const res = await undo(version);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(code);
      if (statuses) expect([...res.body.details.statuses].sort()).toEqual([...statuses].sort());
      expect(await draftRow()).toEqual(draftBefore);
      expect(await proposalRows(ids)).toEqual(proposalsBefore);
      expect(await auditCount('onboarding.draft_undone')).toBe(0);
      expect(await auditCount('proposal.undone')).toBe(0);
    }

    it.each(['executing', 'executed', 'execution_failed', 'undone'])('one member %s: DRAFT_UNDO_REFUSED, the draft still approved', async (status) => {
      const { ids, version } = await approvedDraft();
      await setStatus(ids[0], status);
      await expectRefused(ids, version, /^DRAFT_UNDO_REFUSED: /, ['approved', status]);
      expect((await draftRow()).status).toBe('approved');
    });

    it('a listed proposal whose row is gone: DRAFT_UNDO_REFUSED naming missing', async () => {
      const { ids, version } = await approvedDraft();
      await pool.query(`UPDATE onboarding_drafts SET proposal_ids = jsonb_build_array($2::text, $3::text) WHERE tenant_id = $1`, [
        tenant.tenantId,
        ids[0],
        crypto.randomUUID(),
      ]);
      await expectRefused(ids, version, /^DRAFT_UNDO_REFUSED: /, ['approved', 'missing']);
    });

    it('the window closed on one row: UNDO_WINDOW_CLOSED', async () => {
      const { ids, version } = await approvedDraft();
      await ageApproval([ids[1]], 5000);
      await expectRefused(ids, version, /^UNDO_WINDOW_CLOSED: /);
    });

    it('a stale version with a closed window is VERSION_CONFLICT, not UNDO_WINDOW_CLOSED (the set is never read)', async () => {
      const { ids, version } = await approvedDraft();
      await ageApproval(ids, 60_000);
      await expectRefused(ids, version - 1, new RegExp(`^VERSION_CONFLICT: expected ${version - 1}, found ${version}`));
    });

    it('a version ahead of the row is VERSION_CONFLICT too', async () => {
      const { ids, version } = await approvedDraft();
      await expectRefused(ids, version + 4, new RegExp(`^VERSION_CONFLICT: expected ${version + 4}, found ${version}`));
    });

    it('a malformed body is 400 with nothing locked or written', async () => {
      const { ids } = await approvedDraft();
      const draftBefore = await draftRow();
      const proposalsBefore = await proposalRows(ids);
      for (const body of [{}, { expectedVersion: 0 }, { expectedVersion: 'x' }, { expectedVersion: 2, extra: true }]) {
        expect((await request(app).post(`${BASE}/undo`).send(body)).status, JSON.stringify(body)).toBe(400);
      }
      expect(await draftRow()).toEqual(draftBefore);
      expect(await proposalRows(ids)).toEqual(proposalsBefore);
    });
  });

  // ─── the stale tab ──────────────────────────────────────────────────────

  it('a stale tab cannot undo a newer approval: A holds v, B undoes, stages and approves at v + 3, A is VERSION_CONFLICT naming v and v + 3', async () => {
    const first = await approvedDraft();
    const v = first.version;
    // Tab B: undo, stage a change, approve a new pair.
    expect((await undo(v)).status).toBe(200);
    const staged = await request(app).put(`${BASE}/choices/greeting`).send({ choice: { option: 'b' }, version: v + 1 });
    expect(staged.status).toBe(200);
    const second = await approve();
    expect(second.status).toBe(200);
    expect(second.body.draft.version).toBe(v + 3);
    const bIds: string[] = [...second.body.proposalIds].sort();
    const settingsBefore = await settingsRows();
    const draftBefore = await draftRow();
    const bBefore = await proposalRows(bIds);

    // Tab A taps Undo on its saving screen for approval 1.
    const stale = await undo(v);
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(new RegExp(`^VERSION_CONFLICT: expected ${v}, found ${v + 3}`));
    expect(await draftRow()).toEqual(draftBefore);
    expect(draftBefore).toMatchObject({ status: 'approved', version: v + 3, proposal_ids: second.body.proposalIds });
    expect(await proposalRows(bIds)).toEqual(bBefore);
    for (const p of bBefore) expect(p.status).toBe('approved');
    expect(await auditCount('onboarding.draft_undone')).toBe(1);
    expect(await settingsRows()).toEqual(settingsBefore);

    // B's own undo, with the version its screen holds, succeeds.
    const own = await undo(v + 3);
    expect(own.status).toBe(200);
    expect(own.body.draft).toMatchObject({ status: 'draft', version: v + 4 });
  });

  it('the same when B reached the new pair through reset: A holds v, B splits the pair, resets, stages and approves at v + 3; A\'s undo and A\'s reset are both VERSION_CONFLICT', async () => {
    const first = await approvedDraft();
    const v = first.version;
    // Tab B: the inbox undoes one half, then Start over, a change, and a new approval.
    expect((await request(app).post(`/api/proposals/${first.ids[0]}/undo`).send({})).status).toBe(200);
    expect((await request(app).post(`${BASE}/reset`).send({ expectedVersion: v })).status).toBe(200);
    const staged = await request(app).put(`${BASE}/choices/greeting`).send({ choice: { option: 'b' }, version: v + 1 });
    expect(staged.status).toBe(200);
    const second = await approve();
    expect(second.body.draft.version).toBe(v + 3);
    const bIds: string[] = [...second.body.proposalIds].sort();
    const draftBefore = await draftRow();
    const bBefore = await proposalRows(bIds);

    for (const path of ['undo', 'reset']) {
      const stale = await request(app).post(`${BASE}/${path}`).send({ expectedVersion: v });
      expect(stale.status, path).toBe(409);
      expect(stale.body.message, path).toMatch(new RegExp(`^VERSION_CONFLICT: expected ${v}, found ${v + 3}`));
    }
    expect(await draftRow()).toEqual(draftBefore);
    expect(await proposalRows(bIds)).toEqual(bBefore);
    for (const p of bBefore) expect(p.status).toBe('approved');
    expect(await auditCount('onboarding.draft_undone')).toBe(0);
    expect(await auditCount('onboarding.draft_reset')).toBe(1);
  });

  it('the same tap twice: the second is DRAFT_NOT_APPROVED and writes nothing', async () => {
    const { version } = await approvedDraft();
    expect((await undo(version)).status).toBe(200);
    const before = await draftRow();
    const again = await undo(version);
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/^DRAFT_NOT_APPROVED: /);
    expect(await draftRow()).toEqual(before);
    expect(await auditCount('onboarding.draft_undone')).toBe(1);
  });

  // ─── races on two real connections ─────────────────────────────────────

  describe('the five-second boundary against the worker claim', () => {
    it('(a) a claim that arrives while undo holds the locks waits, then matches nothing: no handler, the draft is editing', async () => {
      const { ids, version } = await approvedDraft();
      const tx = await beginRequestTx(pool, tenant.tenantId);
      try {
        const undone = await tx.run(undoIn(version));
        expect(undone.draft.status).toBe('draft');
        // The worker claims on its own connection: it parks on undo's row lock.
        const claim = proposalRepo.claimForExecution(ids[0], 'execution-worker');
        await waitForBlockedQuery(`SET status = 'executing'`);
        await tx.commit();
        expect(await claim).toBeNull();
      } finally {
        await tx.rollback();
      }
      for (const p of await proposalRows(ids)) expect(p.status).toBe('undone');
      expect((await draftRow()).status).toBe('draft');
    });

    it('(b) a claim that committed first reads as executing: undo is refused, the draft stays approved, the claimed row untouched', async () => {
      const { ids, version } = await approvedDraft();
      const claimed = await proposalRepo.claimForExecution(ids[1], 'execution-worker');
      expect(claimed?.status).toBe('executing');
      const before = await proposalRows(ids);
      const res = await undo(version);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/^DRAFT_UNDO_REFUSED: /);
      expect(res.body.details.statuses).toContain('executing');
      expect(await proposalRows(ids)).toEqual(before);
      expect((await draftRow()).status).toBe('approved');
    });
  });

  it('two undos at one version (two tabs), both orders, on 5 tenants: exactly one wins, the loser waited and is DRAFT_NOT_APPROVED', async () => {
    for (let i = 0; i < 5; i++) {
      tenant = await createTestTenant(pool);
      const { ids, version } = await approvedDraft();
      const { first, second } = await raceFirstThen(pool, tenant.tenantId, undoIn(version), undoIn(version));
      expect(first.draft.status, `round ${i}`).toBe('draft');
      expect(second.status, `round ${i}`).toBe('rejected');
      expect((second as PromiseRejectedResult).reason?.name, `round ${i}`).toBe('DraftNotApprovedError');
      expect(await draftRow()).toMatchObject({ status: 'draft', version: version + 1, proposal_ids: [] });
      expect(await auditCount('onboarding.draft_undone')).toBe(1);
      expect(await auditCount('proposal.undone')).toBe(2);
      for (const p of await proposalRows(ids)) expect(p.status).toBe('undone');

      // Over HTTP, fired together: the same outcome whichever request reaches the lock first.
      const again = await approve();
      const v2: number = again.body.draft.version;
      const [r1, r2] = await Promise.all([undo(v2), undo(v2)]);
      expect([r1.status, r2.status].sort(), `round ${i} http`).toEqual([200, 409]);
      expect((r1.status === 409 ? r1 : r2).body.message).toMatch(/^DRAFT_NOT_APPROVED: /);
      expect(await auditCount('onboarding.draft_undone')).toBe(2);
    }
  });

  it('never: the draft back in editing while a listed proposal is executing or executed', async () => {
    for (const status of ['executing', 'executed']) {
      tenant = await createTestTenant(pool);
      const { ids, version } = await approvedDraft();
      await setStatus(ids[0], status);
      expect((await undo(version)).status).toBe(409);
      expect((await draftRow()).status).toBe('approved');
    }
  });

  // ─── the hint never promises a refused undo ────────────────────────────

  it('sweep 0-8 s in 250 ms steps: whenever the status says undoable, an undo at that instant is not refused for the window or a status', async () => {
    const seen = { undoable: 0, notUndoable: 0 };
    for (let offset = 0; offset <= 8000; offset += 250) {
      tenant = await createTestTenant(pool);
      const { ids, version } = await approvedDraft();
      await ageApproval(ids, offset);
      const block = await hint();
      const res = await undo(version);
      if (block?.undoable) {
        seen.undoable++;
        expect(res.status, `offset ${offset} ms: ${JSON.stringify(res.body)}`).toBe(200);
      } else {
        seen.notUndoable++;
        if (offset >= 5000) expect(res.body.message, `offset ${offset} ms`).toMatch(/^UNDO_WINDOW_CLOSED: /);
      }
      // Anything well inside the margin is offered.
      if (offset <= 3000) expect(block?.undoable, `offset ${offset} ms`).toBe(true);
      if (offset >= 4000) expect(block?.undoable, `offset ${offset} ms`).toBe(false);
    }
    expect(seen.undoable).toBeGreaterThan(10);
    expect(seen.notUndoable).toBeGreaterThan(10);
  });
});
