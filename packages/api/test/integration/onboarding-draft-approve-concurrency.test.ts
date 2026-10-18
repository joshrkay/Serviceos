/**
 * Approve races on real Postgres (U11).
 *
 * The S1 defect: approveDraft read the draft without a lock and markApproved had
 * no version check, so a PUT /choices could commit between building the
 * proposals and marking the draft approved (executed payload != draft), and two
 * concurrent approves each minted and approved a proposal pair.
 *
 * The scripted tests put two real request transactions on two pooled
 * connections (BEGIN + applyTenantContext + tenantContextStore, exactly what
 * withTenantTransaction does) and interleave them deterministically: the second
 * statement is awaited until pg_blocking_pids shows it parked on the first's row
 * lock, then the first commits. The HTTP tests drive the real router through the
 * real withTenantTransaction middleware.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { applyTenantContext } from '../../src/db/rls-runtime-role';
import { tenantContextStore, withTenantTransaction } from '../../src/middleware/tenant-context';
import { createOnboardingDraftRouter } from '../../src/routes/onboarding-draft';
import {
  PgOnboardingDraftRepository,
  DraftVersionConflictError,
  DraftAlreadyApprovedError,
  type OnboardingDraft,
} from '../../src/onboarding/draft/repository';
import { approveDraft, buildDraftProposals, type ApproveDraftDeps } from '../../src/onboarding/draft/approve';
import { assembleTypicalShop } from '../../src/onboarding/choices/assemble';
import { PgRegionalPriceTierRepository } from '../../src/onboarding/choices/price-tiers';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

interface RequestTx {
  pid: number;
  run<T>(fn: () => Promise<T>): Promise<T>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

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

  async function beginRequestTx(tenantId: string): Promise<RequestTx> {
    const client = await pool.connect();
    const slot = { done: false };
    await client.query('BEGIN');
    await applyTenantContext(client, tenantId, { transactional: true });
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const finish = async (sql: 'COMMIT' | 'ROLLBACK') => {
      if (slot.done) return;
      slot.done = true;
      try {
        await client.query(sql);
      } finally {
        client.release();
      }
    };
    return {
      pid,
      run: (fn) => tenantContextStore.run({ client, tenantId }, fn),
      commit: () => finish('COMMIT'),
      rollback: () => finish('ROLLBACK'),
    };
  }

  async function waitUntilBlocked(pid: number): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const r = await pool.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid]);
      if (r.rows[0].blocked) return;
      if (Date.now() > deadline) throw new Error(`backend ${pid} never blocked on a row lock within 5s`);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }

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

  /**
   * Run a draft writer in tx1 (uncommitted; PUT /choices by default), start `second` in tx2, wait for it
   * to park on the lock, then commit tx1.
   */
  async function putFirstThen<T>(
    version: number,
    second: (tx2: RequestTx) => Promise<T>,
    writer: (version: number) => Promise<unknown> = (v) => draftRepo.stageChoice(tenant.tenantId, 'greeting', { option: 'b' }, v),
  ): Promise<PromiseSettledResult<T>> {
    const tx1 = await beginRequestTx(tenant.tenantId);
    const tx2 = await beginRequestTx(tenant.tenantId);
    try {
      await tx1.run(() => writer(version));
      const pending = second(tx2);
      const settled = pending.then(
        (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
        (reason): PromiseSettledResult<T> => ({ status: 'rejected', reason }),
      );
      await waitUntilBlocked(tx2.pid);
      await tx1.commit();
      const result = await settled;
      if (result.status === 'fulfilled') await tx2.commit();
      else await tx2.rollback();
      return result;
    } finally {
      await tx1.rollback();
      await tx2.rollback();
    }
  }

  async function approveFirstThen<T>(
    version: number,
    second: (tx2: RequestTx) => Promise<T>,
  ): Promise<{ first: Awaited<ReturnType<typeof approveDraft>>; second: PromiseSettledResult<T> }> {
    const tx1 = await beginRequestTx(tenant.tenantId);
    const tx2 = await beginRequestTx(tenant.tenantId);
    try {
      const first = await tx1.run(() => approveDraft(deps, tenant.tenantId, actor(), { expectedVersion: version }));
      const pending = second(tx2);
      const settled = pending.then(
        (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
        (reason): PromiseSettledResult<T> => ({ status: 'rejected', reason }),
      );
      await waitUntilBlocked(tx2.pid);
      await tx1.commit();
      const result = await settled;
      if (result.status === 'fulfilled') await tx2.commit();
      else await tx2.rollback();
      return { first, second: result };
    } finally {
      await tx1.rollback();
      await tx2.rollback();
    }
  }

  describe('scripted request transactions', () => {
    it('PUT first, approve second with a stale expectedVersion: 409-class conflict, nothing minted, PUT kept', async () => {
      const d = await seedDraft();
      const result = await putFirstThen(d.version, (tx2) =>
        tx2.run(() => approveDraft(deps, tenant.tenantId, actor(), { expectedVersion: d.version })),
      );
      expect(result.status).toBe('rejected');
      const reason = (result as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(DraftVersionConflictError);
      expect(reason).toMatchObject({ expected: d.version, actual: d.version + 1 });
      expect(await proposalCount()).toBe(0);
      const raw = await rawDraft();
      expect(raw.status).toBe('draft');
      expect(raw.choices.greeting).toEqual({ option: 'b' });
      expect(await approvedAuditCount()).toBe(0);
    });

    it('PUT first, approve second without expectedVersion: the PUT choice is IN the minted payload', async () => {
      const d = await seedDraft();
      const result = await putFirstThen(d.version, (tx2) => tx2.run(() => approveDraft(deps, tenant.tenantId, actor())));
      expect(result.status).toBe('fulfilled');
      const raw = await rawDraft();
      expect(raw.status).toBe('approved');
      expect(raw.choices.greeting).toEqual({ option: 'b' });
      const committed = (await draftRepo.getForTenant(tenant.tenantId))!;
      const expected = buildDraftProposals({ ...committed, status: 'draft' }, tenant.userId);
      const rows = await pool.query<{ proposal_type: string; payload: unknown }>(
        'SELECT proposal_type, payload FROM proposals WHERE id = ANY($1::uuid[])',
        [raw.proposal_ids],
      );
      expect(rows.rows).toHaveLength(2);
      const byType = Object.fromEntries(rows.rows.map((r) => [r.proposal_type, r.payload]));
      expect(byType.onboarding_voice_policy).toEqual(expected.voicePolicy.payload);
      expect(byType.onboarding_tenant_settings).toEqual(expected.tenantSettings.payload);
      // The default greeting would differ from option b, so the PUT really is in the payload.
      const defaults = buildDraftProposals({ ...committed, choices: {}, status: 'draft' }, tenant.userId);
      expect(byType.onboarding_voice_policy).not.toEqual(defaults.voicePolicy.payload);
    });

    it('approve first, PUT second: the PUT gets DraftAlreadyApprovedError and payloads equal the committed choices (5 fresh tenants)', async () => {
      for (let i = 0; i < 5; i++) {
        tenant = await createTestTenant(pool);
        const d = await seedDraft();
        const { first, second } = await approveFirstThen(d.version, (tx2) =>
          tx2.run(() => draftRepo.stageChoice(tenant.tenantId, 'greeting', { option: 'b' }, d.version)),
        );
        expect(first.approvedNow).toBe(true);
        expect(second.status).toBe('rejected');
        expect((second as PromiseRejectedResult).reason).toBeInstanceOf(DraftAlreadyApprovedError);

        const committed = (await draftRepo.getForTenant(tenant.tenantId))!;
        expect(committed.status).toBe('approved');
        expect(committed.choices.greeting).toBeUndefined();
        const expected = buildDraftProposals({ ...committed, status: 'draft' }, tenant.userId);
        const rows = await pool.query<{ proposal_type: string; payload: unknown }>(
          'SELECT proposal_type, payload FROM proposals WHERE id = ANY($1::uuid[])',
          [committed.proposalIds],
        );
        expect(rows.rows).toHaveLength(2);
        const byType = Object.fromEntries(rows.rows.map((r) => [r.proposal_type, r.payload]));
        expect(byType.onboarding_voice_policy).toEqual(expected.voicePolicy.payload);
        expect(byType.onboarding_tenant_settings).toEqual(expected.tenantSettings.payload);
      }
    });

    it('PUT first, approve second, repeated on 5 fresh tenants: never a payload that differs from the committed choices', async () => {
      for (let i = 0; i < 5; i++) {
        tenant = await createTestTenant(pool);
        const d = await seedDraft();
        await putFirstThen(d.version, (tx2) => tx2.run(() => approveDraft(deps, tenant.tenantId, actor())));
        const committed = (await draftRepo.getForTenant(tenant.tenantId))!;
        const expected = buildDraftProposals({ ...committed, status: 'draft' }, tenant.userId);
        const rows = await pool.query<{ proposal_type: string; payload: unknown }>(
          'SELECT proposal_type, payload FROM proposals WHERE id = ANY($1::uuid[])',
          [committed.proposalIds],
        );
        const byType = Object.fromEntries(rows.rows.map((r) => [r.proposal_type, r.payload]));
        expect(byType.onboarding_voice_policy).toEqual(expected.voicePolicy.payload);
      }
    });

    it('approve vs approve: exactly one proposal pair, both callers get the same ids, one audit row', async () => {
      const d = await seedDraft();
      const { first, second } = await approveFirstThen(d.version, (tx2) =>
        tx2.run(() => approveDraft(deps, tenant.tenantId, actor(), { expectedVersion: d.version })),
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
      const { first, second } = await approveFirstThen(d.version, (tx2) =>
        tx2.run(() => approveDraft(deps, tenant.tenantId, actor(), { expectedVersion: d.version - 1 })),
      );
      expect(first.approvedNow).toBe(true);
      expect(second.status).toBe('rejected');
      expect((second as PromiseRejectedResult).reason).toMatchObject({ expected: d.version - 1, actual: d.version });
      expect((second as PromiseRejectedResult).reason).toBeInstanceOf(DraftVersionConflictError);
      expect(await proposalCount()).toBe(2);
      expect(await approvedAuditCount()).toBe(1);
    });
  });

  /**
   * Every draft writer takes the row lock first, so the executed payload equals the committed draft.
   * PUT /choices is raced above; these are the writers added since: the browser timezone and the owner's cell.
   */
  describe.each([
    {
      name: 'timezone',
      write: () => draftRepo.setClientTimezone(tenant.tenantId, 'America/Chicago'),
      applied: (d: OnboardingDraft) => d.clientTimezone === 'America/Chicago',
      inSettingsPayload: (p: Record<string, unknown>) => p.timezone === 'America/Chicago',
    },
    {
      name: 'owner phone',
      write: (version: number) => draftRepo.setOwnerPhone(tenant.tenantId, '+12165550142', version),
      applied: (d: OnboardingDraft) => d.ownerPhone === '+12165550142',
      inSettingsPayload: (p: Record<string, unknown>) => p.ownerPhone === '+12165550142',
    },
  ])('writer vs approve: $name', ({ write, applied, inSettingsPayload }) => {
    const storedSettings = async (ids: string[]) => {
      const rows = await pool.query<{ proposal_type: string; payload: Record<string, unknown> }>(
        'SELECT proposal_type, payload FROM proposals WHERE id = ANY($1::uuid[])',
        [ids],
      );
      return Object.fromEntries(rows.rows.map((r) => [r.proposal_type, r.payload]));
    };

    it('writer first, approve second (no expectedVersion): the write is IN the stored payload', async () => {
      const d = await seedDraft();
      expect(applied(d)).toBe(false);
      const result = await putFirstThen(d.version, (tx2) => tx2.run(() => approveDraft(deps, tenant.tenantId, actor())), write);
      expect(result.status).toBe('fulfilled');
      const committed = (await draftRepo.getForTenant(tenant.tenantId))!;
      expect(committed.status).toBe('approved');
      expect(applied(committed)).toBe(true);
      const stored = await storedSettings(committed.proposalIds);
      expect(inSettingsPayload(stored.onboarding_tenant_settings)).toBe(true);
      const expected = buildDraftProposals({ ...committed, status: 'draft' }, tenant.userId);
      expect(stored.onboarding_tenant_settings).toEqual(expected.tenantSettings.payload);
      expect(stored.onboarding_voice_policy).toEqual(expected.voicePolicy.payload);
    });

    it('approve first, writer second: DraftAlreadyApprovedError and the stored payload equals the committed draft (5 fresh tenants)', async () => {
      for (let i = 0; i < 5; i++) {
        tenant = await createTestTenant(pool);
        const d = await seedDraft();
        const { first, second } = await approveFirstThen(d.version, (tx2) => tx2.run(() => write(d.version)));
        expect(first.approvedNow).toBe(true);
        expect(second.status).toBe('rejected');
        expect((second as PromiseRejectedResult).reason).toBeInstanceOf(DraftAlreadyApprovedError);

        const committed = (await draftRepo.getForTenant(tenant.tenantId))!;
        expect(applied(committed)).toBe(false);
        const stored = await storedSettings(committed.proposalIds);
        expect(inSettingsPayload(stored.onboarding_tenant_settings)).toBe(false);
        const expected = buildDraftProposals({ ...committed, status: 'draft' }, tenant.userId);
        expect(stored.onboarding_tenant_settings).toEqual(expected.tenantSettings.payload);
        expect(await rawDraft().then((r) => r.version)).toBe(d.version + 1);
      }
    });
  });

  describe('writer vs writer', () => {
    it('owner phone PUT vs choice PUT on the same version: one conflicts, the retry lands, version is up by two and neither field is lost', async () => {
      const d = await seedDraft();
      const result = await putFirstThen(
        d.version,
        (tx2) => tx2.run(() => draftRepo.stageChoice(tenant.tenantId, 'greeting', { option: 'b' }, d.version)),
        (v) => draftRepo.setOwnerPhone(tenant.tenantId, '+12165550142', v),
      );
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(DraftVersionConflictError);

      await draftRepo.stageChoice(tenant.tenantId, 'greeting', { option: 'b' }, d.version + 1);
      const raw = await rawDraft();
      expect(raw.version).toBe(d.version + 2);
      expect(raw.choices.greeting).toEqual({ option: 'b' });
      expect((await draftRepo.getForTenant(tenant.tenantId))!.ownerPhone).toBe('+12165550142');
    });

    it('timezone write (no version) racing a choice PUT: both land, version is up by two', async () => {
      const d = await seedDraft();
      const result = await putFirstThen(
        d.version,
        (tx2) => tx2.run(() => draftRepo.setClientTimezone(tenant.tenantId, 'America/Chicago')),
        (v) => draftRepo.stageChoice(tenant.tenantId, 'greeting', { option: 'b' }, v),
      );
      expect(result.status).toBe('fulfilled');
      const raw = await rawDraft();
      expect(raw.version).toBe(d.version + 2);
      expect(raw.choices.greeting).toEqual({ option: 'b' });
      expect((await draftRepo.getForTenant(tenant.tenantId))!.clientTimezone).toBe('America/Chicago');
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
