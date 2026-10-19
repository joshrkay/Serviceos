/**
 * U11 — every draft writer against approve, table-driven, on real Postgres under RLS.
 *
 * `DRAFT_WRITERS` has one row per writer of onboarding_drafts the router
 * exposes. For each row, on two real connections and in both orders:
 *   (a) the write takes the lock and commits first; the approve that carries the
 *       pre-write version is VERSION_CONFLICT with zero proposals and the value
 *       on the draft, and an approve with no version mints with the value IN its
 *       payload;
 *   (b) the approve takes the lock first; the write that waited is
 *       DRAFT_APPROVED, the draft is unchanged by it, and after the REAL
 *       execution handlers run through the REAL sweep the tenant's settings
 *       equal, field by field, the committed draft's resolved choices.
 * Never: a proposal payload that differs from the committed draft.
 *
 * The table is exported: S4-2 (`PUT /draft/metro`) and S5 (`PUT /draft/forwarding`)
 * add their rows in the PR that adds the endpoint, and a test here walks the
 * router so a new write path with no row fails until it has one.
 *
 * Also here, the Pg half of the `updateLocked` contract (the in-memory half is
 * test/onboarding/draft/repository-writers.test.ts): status, precondition and
 * version in that order, the version bump, and that `compute` sees the row as
 * it is under the lock, not as an earlier read saw it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction, type Router } from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { beginRequestTx, raceFirstThen, waitUntilBlocked } from './onboarding-draft-request-tx';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import { createOnboardingDraftRouter } from '../../src/routes/onboarding-draft';
import {
  PgOnboardingDraftRepository,
  InMemoryOnboardingDraftRepository,
  DraftVersionConflictError,
  DraftAlreadyApprovedError,
  DraftNotApprovedError,
  DraftNotFoundError,
  type OnboardingDraft,
  type OnboardingDraftRepository,
} from '../../src/onboarding/draft/repository';
import { approveDraft, buildDraftProposals, resolveChoices, type ApproveDraftDeps } from '../../src/onboarding/draft/approve';
import { assembleTypicalShop } from '../../src/onboarding/choices/assemble';
import {
  InMemoryRegionalPriceTierRepository,
  PgRegionalPriceTierRepository,
  type RegionalPriceTierRepository,
} from '../../src/onboarding/choices/price-tiers';
import { bookingHoursFromPreset, type BookingHoursPreset } from '../../src/proposals/contracts/onboarding';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgCatalogItemRepository } from '../../src/catalog/pg-catalog-item';
import { PgEstimateTemplateRepository } from '../../src/templates/pg-estimate-template';
import { OnboardingTenantSettingsExecutionHandler, OnboardingVoicePolicyExecutionHandler } from '../../src/proposals/execution/onboarding-handlers';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { PgIdempotencyLockProvider } from '../../src/proposals/execution/idempotency-lock';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import type { ExecutionHandler } from '../../src/proposals/execution/handlers';
import { runExecutionSweep } from '../../src/workers/execution-worker';
import type { Logger } from '../../src/logging/logger';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const BASE = '/api/onboarding/draft';
const CREATE = { packId: 'plumbing', businessName: 'Walsh Plumbing', ownerFirstName: 'Jenna', clientTimezone: 'America/New_York' };
const CLE = { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } };
const CMH = { standard: { tripFeeCents: 7900, hourlyRateCents: 13500 }, premium: { tripFeeCents: 10900, hourlyRateCents: 16500 } };

/** One row per draft writer the router exposes. */
export interface DraftWriterRow {
  name: string;
  /** The router path this writer is reached by; the completeness test matches it against the router. */
  route: { method: 'PUT' | 'POST'; path: string };
  /** The repository call the route makes, run inside a scripted request transaction (with the real tier table). */
  write: (repo: OnboardingDraftRepository, tenantId: string, version: number, tierRepo: RegionalPriceTierRepository) => Promise<OnboardingDraft>;
  /** The same write over HTTP, through the real router and request transaction. */
  http: (app: express.Express, version: number) => request.Test;
  /** True when the draft carries the value this writer sets. */
  applied: (d: OnboardingDraft) => boolean;
  /** True when the minted onboarding_tenant_settings / onboarding_voice_policy payloads carry it. */
  inPayloads: (settings: Record<string, unknown>, voicePolicy: Record<string, unknown>) => boolean;
  /**
   * What the same request answers once the draft is approved: 409 DRAFT_APPROVED,
   * or (POST /draft only) the idempotent read it has always been, which never
   * reaches the writer. Either way the row is unchanged.
   */
  httpAfterApproval: { status: 409; code: RegExp } | { status: 200 };
}

export const DRAFT_WRITERS: DraftWriterRow[] = [
  {
    name: 'PUT /draft/choices/:settingKey',
    route: { method: 'PUT', path: '/choices/:settingKey' },
    write: (repo, tenantId, v) => repo.stageChoice(tenantId, 'greeting', { option: 'b' }, v),
    http: (app, v) => request(app).put(`${BASE}/choices/greeting`).send({ choice: { option: 'b' }, version: v }),
    applied: (d) => d.choices.greeting !== undefined && 'option' in d.choices.greeting && d.choices.greeting.option === 'b',
    inPayloads: (_s, voice) => voice.voiceGreeting === "Thanks for calling Walsh Plumbing. What's going on today?",
    httpAfterApproval: { status: 409, code: /DRAFT_APPROVED/ },
  },
  {
    name: 'timezone write (POST /draft with a new clientTimezone)',
    route: { method: 'POST', path: '/' },
    write: (repo, tenantId) => repo.setClientTimezone(tenantId, 'America/Chicago'),
    http: (app) => request(app).post(BASE).send({ ...CREATE, clientTimezone: 'America/Chicago' }),
    applied: (d) => d.clientTimezone === 'America/Chicago',
    inPayloads: (settings) => settings.timezone === 'America/Chicago',
    httpAfterApproval: { status: 200 },
  },
  {
    name: 'PUT /draft/owner-phone',
    route: { method: 'PUT', path: '/owner-phone' },
    write: (repo, tenantId, v) => repo.setOwnerPhone(tenantId, '+12165550142', v),
    http: (app, v) => request(app).put(`${BASE}/owner-phone`).send({ ownerPhone: '(216) 555-0142', version: v }),
    applied: (d) => d.ownerPhone === '+12165550142',
    inPayloads: (settings) => settings.ownerPhone === '+12165550142',
    httpAfterApproval: { status: 409, code: /DRAFT_APPROVED/ },
  },
  {
    name: 'PUT /draft/metro',
    route: { method: 'PUT', path: '/metro' },
    // What the route does: the Columbus shop built from the locked row, stored whole.
    write: (repo, tenantId, v, tierRepo) =>
      repo.setMetro(tenantId, 'CMH', v, (row) =>
        assembleTypicalShop(tierRepo, {
          packId: row.packId,
          businessName: row.businessName,
          ownerFirstName: row.ownerFirstName ?? undefined,
          metro: { kind: 'metro', metroCode: 'CMH', name: 'Columbus' },
        }),
      ),
    http: (app, v) => request(app).put(`${BASE}/metro`).send({ metro: 'CMH', version: v }),
    applied: (d) => d.metroCode === 'CMH' && d.metroName === 'Columbus' && d.assembled.metroCode === 'CMH' && d.assembled.metroName === 'Columbus',
    // The settings proposal carries the Columbus city and the Columbus standard tier (the default price option).
    inPayloads: (settings) =>
      settings.city === 'Columbus' && settings.tripFeeCents === CMH.standard.tripFeeCents && settings.hourlyRateCents === CMH.standard.hourlyRateCents,
    httpAfterApproval: { status: 409, code: /DRAFT_APPROVED/ },
  },
];

/**
 * Mutating routes that are not draft field writers: approve is the other side of
 * the race; retry bumps, and undo (S4-4) and reset (S4-5) revert, an APPROVED
 * draft, so none of them can land inside approve's draft-status window (their
 * own races are in onboarding-draft-execution.test.ts, onboarding-draft-undo.test.ts
 * and onboarding-draft-reset.test.ts).
 */
const NOT_FIELD_WRITERS = ['POST /approve', 'POST /retry', 'POST /undo', 'POST /reset'];

describe('every router write path has a DRAFT_WRITERS row', () => {
  it('lists each mutating route as a writer row or as a known non-writer', () => {
    const router: Router = createOnboardingDraftRouter({
      draftRepo: new InMemoryOnboardingDraftRepository(),
      tierRepo: new InMemoryRegionalPriceTierRepository({ 'plumbing|CLE': CLE }),
      proposalRepo: new InMemoryProposalRepository(),
      auditRepo: new InMemoryAuditRepository(),
    });
    const mutating = new Set<string>();
    for (const layer of router.stack as { route?: { path: string; methods: Record<string, boolean> } }[]) {
      if (!layer.route) continue;
      for (const [method, on] of Object.entries(layer.route.methods)) {
        if (on && method !== 'get') mutating.add(`${method.toUpperCase()} ${layer.route.path}`);
      }
    }
    const covered = new Set([...DRAFT_WRITERS.map((w) => `${w.route.method} ${w.route.path}`), ...NOT_FIELD_WRITERS]);
    expect([...mutating].sort(), 'a new write path needs a DRAFT_WRITERS row (or a deliberate NOT_FIELD_WRITERS entry)').toEqual([...covered].sort());
  });
});

describe('onboarding draft writers vs approve (real DB)', () => {
  let pool: Pool;
  let draftRepo: PgOnboardingDraftRepository;
  let proposalRepo: PgProposalRepository;
  let auditRepo: PgAuditRepository;
  let settingsRepo: PgSettingsRepository;
  let tierRepo: PgRegionalPriceTierRepository;
  let deps: ApproveDraftDeps;
  let app: express.Express;
  let tenant: { tenantId: string; userId: string };

  const actor = () => ({ userId: tenant.userId, role: 'owner' as const });

  beforeAll(async () => {
    pool = await getSharedTestDb();
    draftRepo = new PgOnboardingDraftRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    tierRepo = new PgRegionalPriceTierRepository(pool);
    await tierRepo.upsert('plumbing', 'CLE', CLE, 'test');
    await tierRepo.upsert('plumbing', 'CMH', CMH, 'test');
    deps = { draftRepo, proposalRepo, auditRepo };

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = { userId: tenant.userId, sessionId: 's', tenantId: tenant.tenantId, role: 'owner' };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.use(BASE, createOnboardingDraftRouter({ draftRepo, tierRepo, proposalRepo, auditRepo }));
  });

  beforeEach(async () => {
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM regional_price_tiers WHERE trade = 'plumbing' AND metro_code IN ('CLE', 'CMH') AND source = 'test'`);
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

  const proposalCount = async () =>
    (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM proposals WHERE tenant_id = $1', [tenant.tenantId])).rows[0].n;
  const rawDraft = async () =>
    (
      await pool.query<{ status: string; version: number; choices: Record<string, unknown>; client_timezone: string; owner_phone: string | null; proposal_ids: string[] }>(
        'SELECT status, version, choices, client_timezone, owner_phone, proposal_ids FROM onboarding_drafts WHERE tenant_id = $1',
        [tenant.tenantId],
      )
    ).rows[0];
  const committedDraft = async () => (await draftRepo.getForTenant(tenant.tenantId))!;
  const approvedAuditCount = async () =>
    (
      await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND event_type = 'onboarding.draft_approved'`, [
        tenant.tenantId,
      ])
    ).rows[0].n;

  async function storedPayloads(ids: string[]) {
    const rows = await pool.query<{ proposal_type: string; payload: Record<string, unknown> }>(
      'SELECT proposal_type, payload FROM proposals WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
      [tenant.tenantId, ids],
    );
    expect(rows.rows).toHaveLength(2);
    const byType = Object.fromEntries(rows.rows.map((r) => [r.proposal_type, r.payload]));
    return { settings: byType.onboarding_tenant_settings, voicePolicy: byType.onboarding_voice_policy };
  }

  /** The stored proposal payloads equal what the committed draft resolves to: never a payload from a row that was not committed. */
  async function expectPayloadsEqualCommitted(committed: OnboardingDraft) {
    expect(committed.status).toBe('approved');
    const expected = buildDraftProposals({ ...committed, status: 'draft' }, tenant.userId);
    const stored = await storedPayloads(committed.proposalIds);
    expect(stored.settings).toEqual(expected.tenantSettings.payload);
    expect(stored.voicePolicy).toEqual(expected.voicePolicy.payload);
    return stored;
  }

  // ─── Real execution: the handlers the worker runs, through the worker's own sweep ───

  const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger,
  };

  function realExecutor(): ProposalExecutor {
    const settingsHandler = new OnboardingTenantSettingsExecutionHandler(
      settingsRepo,
      new PgPackActivationRepository(pool),
      auditRepo,
      { catalogRepo: new PgCatalogItemRepository(pool), templateRepo: new PgEstimateTemplateRepository(pool) },
      pool,
    );
    const voiceHandler = new OnboardingVoicePolicyExecutionHandler(settingsRepo, auditRepo);
    const executionRepo = new PgProposalExecutionRepository(pool);
    const guard = new IdempotencyGuard(executionRepo, proposalRepo, new PgIdempotencyLockProvider(pool));
    return new ProposalExecutor(
      new Map<string, ExecutionHandler>([
        ['onboarding_tenant_settings', settingsHandler],
        ['onboarding_voice_policy', voiceHandler],
      ]) as ConstructorParameters<typeof ProposalExecutor>[0],
      proposalRepo,
      guard,
      auditRepo,
      { executionRepo },
    );
  }

  /** Push both proposals past the undo window, run the real sweep, and require both executed. */
  async function executeCommitted(committed: OnboardingDraft) {
    await pool.query(`UPDATE proposals SET approved_at = NOW() - interval '1 hour' WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [
      tenant.tenantId,
      committed.proposalIds,
    ]);
    await runExecutionSweep({ proposalRepo, executor: realExecutor(), logger: silentLogger, auditRepo });
    const statuses = await pool.query<{ status: string; execution_error: string | null }>(
      'SELECT status, execution_error FROM proposals WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
      [tenant.tenantId, committed.proposalIds],
    );
    expect(statuses.rows.map((r) => [r.status, r.execution_error])).toEqual([
      ['executed', null],
      ['executed', null],
    ]);
  }

  /**
   * The tenant's settings after execution equal the committed draft's resolved
   * choices and facts, field by field: owner phone, metro-derived city, both
   * prices, timezone, and every voice-policy field.
   */
  async function expectExecutedFactsEqualCommitted(committed: OnboardingDraft) {
    const resolved = Object.fromEntries(resolveChoices(committed).map((r) => [r.settingKey, r]));
    const price = resolved.trip_fee_and_rate.prices!;
    const writes = Object.assign({}, ...Object.values(resolved).map((r) => r.writes));

    const settings = (
      await pool.query<Record<string, unknown>>(
        `SELECT business_name, service_area_text, timezone, owner_phone, hourly_rate_cents, voice_greeting,
                autonomous_booking_enabled, payment_collection_mode, business_hours, escalation_settings
           FROM tenant_settings WHERE tenant_id = $1`,
        [tenant.tenantId],
      )
    ).rows[0];
    expect(settings).toBeDefined();
    expect(settings).toMatchObject({
      business_name: committed.businessName,
      service_area_text: committed.metroName,
      timezone: committed.clientTimezone,
      owner_phone: committed.ownerPhone,
      hourly_rate_cents: price.hourlyRateCents,
      voice_greeting: writes.voiceGreeting,
      autonomous_booking_enabled: writes.autonomousBookingEnabled,
      payment_collection_mode: writes.paymentCollectionMode,
      business_hours: bookingHoursFromPreset(writes.bookingHoursPreset as BookingHoursPreset),
    });
    expect(settings.escalation_settings).toMatchObject({
      after_hours_voice_mode: writes.afterHoursVoiceMode,
      emergency_target: writes.emergencyTarget,
    });
    // The chosen trip fee lands on the pack's headline visit item.
    const visit = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM catalog_items WHERE tenant_id = $1 AND unit_price_cents = $2 AND archived_at IS NULL',
      [tenant.tenantId, price.tripFeeCents],
    );
    expect(visit.rows[0].n).toBeGreaterThan(0);
  }

  describe.each(DRAFT_WRITERS)('$name', ({ write, http, applied, inPayloads, httpAfterApproval }) => {
    it('(a) write first, approve with the pre-write version: VERSION_CONFLICT, zero proposals, the value on the draft (5 fresh tenants)', async () => {
      for (let i = 0; i < 5; i++) {
        tenant = await createTestTenant(pool);
        const d = await seedDraft();
        expect(applied(d)).toBe(false);
        const { second } = await raceFirstThen(
          pool,
          tenant.tenantId,
          () => write(draftRepo, tenant.tenantId, d.version, tierRepo),
          () => approveDraft(deps, tenant.tenantId, actor(), { expectedVersion: d.version }),
        );
        expect(second.status).toBe('rejected');
        const reason = (second as PromiseRejectedResult).reason;
        expect(reason).toBeInstanceOf(DraftVersionConflictError);
        expect(reason).toMatchObject({ expected: d.version, actual: d.version + 1 });
        expect(await proposalCount()).toBe(0);
        expect(await approvedAuditCount()).toBe(0);
        const committed = await committedDraft();
        expect(committed.status).toBe('draft');
        expect(committed.version).toBe(d.version + 1);
        expect(applied(committed)).toBe(true);
      }
    });

    it('(a) write first, approve with no version: mints from the row with the value IN the payload, and the executed settings equal that row (5 fresh tenants)', async () => {
      for (let i = 0; i < 5; i++) {
        tenant = await createTestTenant(pool);
        const d = await seedDraft();
        const { second } = await raceFirstThen(
          pool,
          tenant.tenantId,
          () => write(draftRepo, tenant.tenantId, d.version, tierRepo),
          () => approveDraft(deps, tenant.tenantId, actor()),
        );
        expect(second.status).toBe('fulfilled');
        const committed = await committedDraft();
        expect(applied(committed)).toBe(true);
        expect(committed.version).toBe(d.version + 2);
        const stored = await expectPayloadsEqualCommitted(committed);
        expect(inPayloads(stored.settings, stored.voicePolicy)).toBe(true);
        // And what executes is that row: the real handlers write the written value into the settings.
        await executeCommitted(committed);
        await expectExecutedFactsEqualCommitted(committed);
      }
    });

    it('(b) approve first, the waiting write is DRAFT_APPROVED, the draft is unchanged by it, and the executed settings equal the committed draft (5 fresh tenants)', async () => {
      for (let i = 0; i < 5; i++) {
        tenant = await createTestTenant(pool);
        const d = await seedDraft();
        const { first, second } = await raceFirstThen(
          pool,
          tenant.tenantId,
          () => approveDraft(deps, tenant.tenantId, actor(), { expectedVersion: d.version }),
          () => write(draftRepo, tenant.tenantId, d.version, tierRepo),
        );
        expect(first.approvedNow).toBe(true);
        expect(second.status).toBe('rejected');
        expect((second as PromiseRejectedResult).reason).toBeInstanceOf(DraftAlreadyApprovedError);
        expect(await approvedAuditCount()).toBe(1);

        const committed = await committedDraft();
        expect(committed.version).toBe(d.version + 1);
        expect(applied(committed)).toBe(false);
        const stored = await expectPayloadsEqualCommitted(committed);
        expect(inPayloads(stored.settings, stored.voicePolicy)).toBe(false);

        await executeCommitted(committed);
        await expectExecutedFactsEqualCommitted(committed);
        // The refused write never reached the row, the proposals or the settings.
        expect(applied(await committedDraft())).toBe(false);
      }
    });

    it('over HTTP: the write commits, a stale approve is 409 VERSION_CONFLICT, the current version approves with the value in the payload', async () => {
      const d = await seedDraft();
      const wrote = await http(app, d.version);
      expect(wrote.status, JSON.stringify(wrote.body)).toBe(200);
      expect(wrote.body.draft.version).toBe(d.version + 1);
      expect(applied(await committedDraft())).toBe(true);

      const stale = await request(app).post(`${BASE}/approve`).send({ expectedVersion: d.version });
      expect(stale.status).toBe(409);
      expect(JSON.stringify(stale.body)).toMatch(/VERSION_CONFLICT/);
      expect(await proposalCount()).toBe(0);

      const ok = await request(app).post(`${BASE}/approve`).send({ expectedVersion: d.version + 1 });
      expect(ok.status).toBe(200);
      expect(ok.body.approvedNow).toBe(true);
      const stored = await expectPayloadsEqualCommitted(await committedDraft());
      expect(inPayloads(stored.settings, stored.voicePolicy)).toBe(true);

      // Once approved, the same request changes nothing: a field PUT is 409 DRAFT_APPROVED.
      const before = await rawDraft();
      const late = await http(app, d.version + 2);
      expect(late.status).toBe(httpAfterApproval.status);
      if ('code' in httpAfterApproval) expect(JSON.stringify(late.body)).toMatch(httpAfterApproval.code);
      expect(await rawDraft()).toEqual(before);
    });
  });

  describe('writer vs writer', () => {
    it('owner-phone PUT vs choice PUT from the same version: one wins at v + 1, the loser is VERSION_CONFLICT naming v and v + 1, re-sends with v + 1 and lands; both values stored at v + 2', async () => {
      const d = await seedDraft();
      const v = d.version;
      const { second } = await raceFirstThen(
        pool,
        tenant.tenantId,
        () => draftRepo.setOwnerPhone(tenant.tenantId, '+12165550142', v),
        () => draftRepo.stageChoice(tenant.tenantId, 'greeting', { option: 'b' }, v),
      );
      expect(second.status).toBe('rejected');
      const reason = (second as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(DraftVersionConflictError);
      expect(reason).toMatchObject({ expected: v, actual: v + 1 });
      let raw = await rawDraft();
      expect(raw).toMatchObject({ version: v + 1, owner_phone: '+12165550142', choices: {} });

      const retried = await draftRepo.stageChoice(tenant.tenantId, 'greeting', { option: 'b' }, v + 1);
      expect(retried.version).toBe(v + 2);
      raw = await rawDraft();
      expect(raw).toMatchObject({ version: v + 2, owner_phone: '+12165550142', choices: { greeting: { option: 'b' } } });
    });

    it('the same race the other way round: the choice wins, the owner-phone PUT loses, re-sends and lands', async () => {
      const d = await seedDraft();
      const v = d.version;
      const { second } = await raceFirstThen(
        pool,
        tenant.tenantId,
        () => draftRepo.stageChoice(tenant.tenantId, 'greeting', { option: 'b' }, v),
        () => draftRepo.setOwnerPhone(tenant.tenantId, '+12165550142', v),
      );
      expect(second.status).toBe('rejected');
      expect((second as PromiseRejectedResult).reason).toMatchObject({ expected: v, actual: v + 1 });
      expect(await rawDraft()).toMatchObject({ version: v + 1, owner_phone: null, choices: { greeting: { option: 'b' } } });
      await draftRepo.setOwnerPhone(tenant.tenantId, '+12165550142', v + 1);
      expect(await rawDraft()).toMatchObject({ version: v + 2, owner_phone: '+12165550142', choices: { greeting: { option: 'b' } } });
    });

    it('over HTTP: the loser is 409 VERSION_CONFLICT naming v and v + 1, having changed nothing', async () => {
      const d = await seedDraft();
      const v = d.version;
      const won = await request(app).put(`${BASE}/choices/greeting`).send({ choice: { option: 'b' }, version: v });
      expect(won.status).toBe(200);
      const lost = await request(app).put(`${BASE}/owner-phone`).send({ ownerPhone: '(216) 555-0142', version: v });
      expect(lost.status).toBe(409);
      expect(JSON.stringify(lost.body)).toMatch(new RegExp(`VERSION_CONFLICT: expected ${v}, found ${v + 1}`));
      expect(await rawDraft()).toMatchObject({ version: v + 1, owner_phone: null });

      const again = await request(app).put(`${BASE}/owner-phone`).send({ ownerPhone: '(216) 555-0142', version: v + 1 });
      expect(again.status).toBe(200);
      expect(again.body.draft.version).toBe(v + 2);
      expect(await rawDraft()).toMatchObject({ version: v + 2, owner_phone: '+12165550142', choices: { greeting: { option: 'b' } } });
    });

    it('the timezone write (no version) waits behind a choice PUT and still lands: both stored, version up by two', async () => {
      const d = await seedDraft();
      const { second } = await raceFirstThen(
        pool,
        tenant.tenantId,
        () => draftRepo.stageChoice(tenant.tenantId, 'greeting', { option: 'b' }, d.version),
        () => draftRepo.setClientTimezone(tenant.tenantId, 'America/Chicago'),
      );
      expect(second.status).toBe('fulfilled');
      expect(await rawDraft()).toMatchObject({ version: d.version + 2, client_timezone: 'America/Chicago', choices: { greeting: { option: 'b' } } });
    });
  });

  // ─── The Pg half of the updateLocked contract ────────────────────────────

  describe('updateLocked on Postgres', () => {
    type Writer = { name: string; requires: 'draft' | 'approved'; takesVersion: boolean; write: (v: number) => Promise<OnboardingDraft>; applied: (d: OnboardingDraft) => boolean };
    const writers: Writer[] = [
      { name: 'stageChoice', requires: 'draft', takesVersion: true, write: (v) => draftRepo.stageChoice(tenant.tenantId, 'greeting', { option: 'b' }, v), applied: (d) => JSON.stringify(d.choices.greeting) === '{"option":"b"}' },
      { name: 'setClientTimezone', requires: 'draft', takesVersion: false, write: () => draftRepo.setClientTimezone(tenant.tenantId, 'America/Chicago'), applied: (d) => d.clientTimezone === 'America/Chicago' },
      { name: 'setOwnerPhone', requires: 'draft', takesVersion: true, write: (v) => draftRepo.setOwnerPhone(tenant.tenantId, '+12165550142', v), applied: (d) => d.ownerPhone === '+12165550142' },
      { name: 'markApproved', requires: 'draft', takesVersion: true, write: (v) => draftRepo.markApproved(tenant.tenantId, ['11111111-1111-4111-8111-111111111111'], v), applied: (d) => d.status === 'approved' && d.proposalIds.length === 1 && d.approvedAt !== null },
      { name: 'markRetried', requires: 'approved', takesVersion: true, write: (v) => draftRepo.markRetried(tenant.tenantId, v), applied: () => true },
    ];

    describe.each(writers)('$name', ({ requires, takesVersion, write, applied }) => {
      async function rowIn(status: 'draft' | 'approved') {
        const d = await seedDraft();
        return status === 'draft' ? d : draftRepo.markApproved(tenant.tenantId, ['11111111-1111-4111-8111-111111111111'], d.version);
      }
      const wrong = requires === 'draft' ? 'approved' : 'draft';
      const wrongError = requires === 'draft' ? DraftAlreadyApprovedError : DraftNotApprovedError;

      it(`refuses a ${wrong} draft first (before the version), writes nothing`, async () => {
        const row = await rowIn(wrong);
        await expect(write(row.version + 7)).rejects.toBeInstanceOf(wrongError);
        await expect(write(row.version)).rejects.toBeInstanceOf(wrongError);
        expect(await committedDraft()).toEqual(row);
      });

      if (takesVersion) {
        it('a stale version is DraftVersionConflictError naming expected and found, writes nothing', async () => {
          const row = await rowIn(requires);
          for (const stale of [row.version - 1, row.version + 1]) {
            await expect(write(stale)).rejects.toMatchObject({ expected: stale, actual: row.version });
          }
          expect(await committedDraft()).toEqual(row);
        });
      }

      it('bumps version by exactly one and stores the value', async () => {
        const row = await rowIn(requires);
        const next = await write(row.version);
        expect(next.version).toBe(row.version + 1);
        expect(applied(next)).toBe(true);
        expect(await committedDraft()).toEqual(next);
      });

      it('no draft (another tenant) is DraftNotFoundError', async () => {
        const other = await createTestTenant(pool);
        await seedDraft();
        tenant = other;
        await expect(write(1)).rejects.toBeInstanceOf(DraftNotFoundError);
      });
    });

    it('answers a failing precondition before the version compare, with nothing written and no UPDATE issued', async () => {
      class MetroLockedForTest extends Error {}
      const d = await seedDraft();
      let computed = 0;
      await expect(
        draftRepo.updateLocked(
          tenant.tenantId,
          {
            requireStatus: 'draft',
            expectedVersion: d.version + 3,
            precondition: () => {
              throw new MetroLockedForTest('locked');
            },
          },
          () => {
            computed += 1;
            return { metroCode: 'CMH', metroName: 'Columbus' };
          },
        ),
      ).rejects.toBeInstanceOf(MetroLockedForTest);
      expect(computed).toBe(0);
      expect(await committedDraft()).toEqual(d);
    });

    it('compute receives the row as it is under the lock: a write that committed while we waited is what compute sees', async () => {
      const d = await seedDraft();
      const unlockedRead = await draftRepo.getForTenant(tenant.tenantId);
      const seen: { version: number; greeting: unknown }[] = [];

      const tx1 = await beginRequestTx(pool, tenant.tenantId);
      const tx2 = await beginRequestTx(pool, tenant.tenantId);
      try {
        await tx1.run(() => draftRepo.stageChoice(tenant.tenantId, 'greeting', { option: 'b' }, d.version));
        const pending = tx2.run(() =>
          draftRepo.updateLocked(tenant.tenantId, { requireStatus: 'draft' }, (row) => {
            seen.push({ version: row.version, greeting: row.choices.greeting });
            // Computed from the locked row, so the merge keeps tx1's greeting.
            return { choices: { ...row.choices, booking_posture: { option: 'b' } } };
          }),
        );
        await waitUntilBlocked(pool, tx2.pid);
        await tx1.commit();
        const next = await pending;
        await tx2.commit();

        expect(seen).toEqual([{ version: d.version + 1, greeting: { option: 'b' } }]);
        expect(unlockedRead!.version).toBe(d.version);
        expect(next.version).toBe(d.version + 2);
        expect(next.choices).toEqual({ greeting: { option: 'b' }, booking_posture: { option: 'b' } });
        expect((await rawDraft()).choices).toEqual({ greeting: { option: 'b' }, booking_posture: { option: 'b' } });
      } finally {
        await tx1.rollback();
        await tx2.rollback();
      }
    });

    it('writes every patch column the helper knows and only those (pins the real column names)', async () => {
      const d = await seedDraft();
      const approvedAt = new Date('2026-10-19T10:00:00.000Z');
      const next = await draftRepo.updateLocked(tenant.tenantId, { requireStatus: 'draft', expectedVersion: d.version }, (row) => ({
        choices: { greeting: { option: 'b' } },
        clientTimezone: 'America/Chicago',
        ownerPhone: '+12165550142',
        metroCode: 'CMH',
        metroName: 'Columbus',
        assembled: { ...row.assembled, metroCode: 'CMH', metroName: 'Columbus' },
        status: 'approved',
        proposalIds: ['11111111-1111-4111-8111-111111111111'],
        approvedAt,
      }));
      const raw = (
        await pool.query(
          `SELECT choices, client_timezone, owner_phone, metro_code, metro_name, assembled->>'metroCode' AS assembled_metro, status, proposal_ids, approved_at, version
             FROM onboarding_drafts WHERE tenant_id = $1`,
          [tenant.tenantId],
        )
      ).rows[0];
      expect(raw).toEqual({
        choices: { greeting: { option: 'b' } },
        client_timezone: 'America/Chicago',
        owner_phone: '+12165550142',
        metro_code: 'CMH',
        metro_name: 'Columbus',
        assembled_metro: 'CMH',
        status: 'approved',
        proposal_ids: ['11111111-1111-4111-8111-111111111111'],
        approved_at: approvedAt,
        version: d.version + 1,
      });
      expect(next).toEqual(await committedDraft());
    });

    it('refuses to run under another tenant\'s context: the row is invisible and the write is DraftNotFoundError', async () => {
      await seedDraft();
      const other = await createTestTenant(pool);
      await expect(draftRepo.updateLocked(other.tenantId, { requireStatus: 'draft' }, () => ({ ownerPhone: '+12165550142' }))).rejects.toBeInstanceOf(
        DraftNotFoundError,
      );
      expect((await rawDraft()).owner_phone).toBeNull();
    });
  });
});
