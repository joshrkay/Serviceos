/**
 * S4-2 (U5) — the metro change, `PUT /api/onboarding/draft/metro`, on real Postgres under RLS.
 *
 *   - the change: the row's metro_code, metro_name and the whole assembled shop equal
 *     assembleTypicalShop for the new metro field by field, in one version bump, with
 *     one onboarding.metro_changed audit row; GET agrees; the approval that follows
 *     mints the Columbus city and prices;
 *   - the refusals (DRAFT_APPROVED, DRAFT_METRO_LOCKED before VERSION_CONFLICT, a 400 for
 *     an unknown code) leave the row physically untouched (same xmin: no UPDATE ran);
 *   - the race with a choice PUT from the same rendered version, both orders, on two
 *     real connections, over fresh tenants: exactly one wins, and never a staged choice
 *     beside a shop other than the one it was staged against.
 *
 * The race against approve is the metro row of DRAFT_WRITERS in
 * onboarding-draft-writers-vs-approve.test.ts.
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
  DraftMetroLockedError,
  DraftVersionConflictError,
  type OnboardingDraft,
} from '../../src/onboarding/draft/repository';
import { assembleTypicalShop, type AssembledShop } from '../../src/onboarding/choices/assemble';
import { PgRegionalPriceTierRepository } from '../../src/onboarding/choices/price-tiers';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const BASE = '/api/onboarding/draft';
const CLE = { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } };
const CMH = { standard: { tripFeeCents: 7900, hourlyRateCents: 13500 }, premium: { tripFeeCents: 10900, hourlyRateCents: 16500 } };
const CLEVELAND = { kind: 'metro' as const, metroCode: 'CLE', name: 'Cleveland' };
const COLUMBUS = { kind: 'metro' as const, metroCode: 'CMH', name: 'Columbus' };

describe('onboarding draft metro change (real DB)', () => {
  let pool: Pool;
  let draftRepo: PgOnboardingDraftRepository;
  let tierRepo: PgRegionalPriceTierRepository;
  let app: express.Express;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    draftRepo = new PgOnboardingDraftRepository(pool);
    tierRepo = new PgRegionalPriceTierRepository(pool);
    await tierRepo.upsert('plumbing', 'CLE', CLE, 'test');
    await tierRepo.upsert('plumbing', 'CMH', CMH, 'test');
    const proposalRepo = new PgProposalRepository(pool);
    const auditRepo = new PgAuditRepository(pool);

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

  const shopFor = (metro: typeof CLEVELAND | typeof COLUMBUS): Promise<AssembledShop> =>
    assembleTypicalShop(tierRepo, { packId: 'plumbing', businessName: 'Walsh Plumbing', ownerFirstName: 'Jenna', metro });

  /** A plumbing draft assembled for Cleveland with no choice staged, as POST /draft makes it. */
  async function seedCleveland(): Promise<OnboardingDraft> {
    const res = await request(app)
      .post(BASE)
      .send({ packId: 'plumbing', businessName: 'Walsh Plumbing', ownerFirstName: 'Jenna', phone: '(216) 555-0142', clientTimezone: 'America/New_York' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.draft.metroCode).toBe('CLE');
    return (await draftRepo.getForTenant(tenant.tenantId))!;
  }

  /** The row as stored, by column name, plus its physical version (xmin moves on any UPDATE). */
  const raw = async () =>
    (
      await pool.query<{
        xmin: string;
        metro_code: string;
        metro_name: string;
        assembled: AssembledShop;
        choices: Record<string, unknown>;
        version: number;
        status: string;
      }>('SELECT xmin::text, metro_code, metro_name, assembled, choices, version, status FROM onboarding_drafts WHERE tenant_id = $1', [tenant.tenantId])
    ).rows[0];
  const metroAudits = async () =>
    (
      await pool.query<{ actor_id: string; entity_id: string; metadata: Record<string, unknown> }>(
        `SELECT actor_id, entity_id, metadata FROM audit_events WHERE tenant_id = $1 AND event_type = 'onboarding.metro_changed'`,
        [tenant.tenantId],
      )
    ).rows;

  /** One metro on the row: the columns and the stored shop name the same one. */
  async function expectOneMetro(code: 'CLE' | 'CMH') {
    const row = await raw();
    const expected = await shopFor(code === 'CLE' ? CLEVELAND : COLUMBUS);
    expect({ metro_code: row.metro_code, metro_name: row.metro_name }).toEqual({ metro_code: code, metro_name: expected.metroName });
    expect(row.assembled).toEqual(JSON.parse(JSON.stringify(expected)));
    return row;
  }

  it('Cleveland to Columbus: one bump, and the row equals the Columbus shop field by field, with nothing of Cleveland left', async () => {
    const d = await seedCleveland();
    const cleveland = await shopFor(CLEVELAND);
    const columbus = await shopFor(COLUMBUS);
    // The property setMetro relies on: the two shops share no price or rendered line.
    const lines = (s: AssembledShop) => s.choices.flatMap((c) => c.options.map((o) => `${o.label}|${o.rivetLine}`));
    const priceOf = (s: AssembledShop) => s.choices.find((c) => c.settingKey === 'trip_fee_and_rate')!.options;
    expect(priceOf(cleveland).map((o) => o.label)).not.toEqual(priceOf(columbus).map((o) => o.label));

    const res = await request(app).put(`${BASE}/metro`).send({ metro: 'CMH', version: d.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.draft.version).toBe(d.version + 1);

    const row = await raw();
    expect(row.version).toBe(d.version + 1);
    expect(row.metro_code).toBe('CMH');
    expect(row.metro_name).toBe('Columbus');
    expect(row.choices).toEqual({});
    expect(row.assembled).toEqual(JSON.parse(JSON.stringify(columbus)));
    // Field by field, as named in the plan.
    expect(row.assembled).toMatchObject({ metroCode: 'CMH', metroName: 'Columbus', showsCity: true, priceSource: 'metro' });
    expect(priceOf(row.assembled).map((o) => o.prices)).toEqual([CMH.standard, CMH.premium]);
    expect(lines(row.assembled)).toEqual(lines(columbus));
    expect(JSON.stringify(row.assembled)).not.toMatch(/Cleveland|\$89\b|\$150\b|\$129\b|\$185\b/);

    // GET returns the same pair, and the response was that row.
    const got = await request(app).get(BASE);
    expect(got.body.draft).toEqual(res.body.draft);
    expect(got.body.draft.assembled).toEqual(row.assembled);

    const audits = await metroAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_id: tenant.userId, entity_id: d.id, metadata: { from: 'CLE', to: 'CMH', version: d.version + 1 } });

    // An approve taken afterwards mints the Columbus city and prices, equal to the row.
    const approved = await request(app).post(`${BASE}/approve`).send({ expectedVersion: d.version + 1 });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const settings = (
      await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM proposals WHERE tenant_id = $1 AND proposal_type = 'onboarding_tenant_settings'`,
        [tenant.tenantId],
      )
    ).rows;
    expect(settings).toHaveLength(1);
    const defaultPrice = priceOf(row.assembled).find((o) => o.key === row.assembled.defaults.trip_fee_and_rate)!.prices!;
    expect(settings[0].payload).toMatchObject({
      city: row.metro_name,
      tripFeeCents: defaultPrice.tripFeeCents,
      hourlyRateCents: defaultPrice.hourlyRateCents,
    });
    expect(settings[0].payload).toMatchObject({ city: 'Columbus', tripFeeCents: 7900, hourlyRateCents: 13500 });
  });

  it('refusals write nothing (the row is physically untouched) and audit nothing: DRAFT_APPROVED, DRAFT_METRO_LOCKED before VERSION_CONFLICT, VERSION_CONFLICT, 400', async () => {
    // Unstaged + stale version.
    let d = await seedCleveland();
    let before = await raw();
    let res = await request(app).put(`${BASE}/metro`).send({ metro: 'CMH', version: d.version + 1 });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(new RegExp(`VERSION_CONFLICT: expected ${d.version + 1}, found ${d.version}`));
    expect(await raw()).toEqual(before);

    // A malformed code: 400 naming the field.
    res = await request(app).put(`${BASE}/metro`).send({ metro: 'Columbus', version: d.version });
    expect(res.status).toBe(400);
    expect(res.body.details.issues.map((i: { path: string }) => i.path)).toEqual(['metro']);
    expect(await raw()).toEqual(before);

    // A staged choice: DRAFT_METRO_LOCKED at the current version and at the stale pre-stage one.
    const staged = await request(app).put(`${BASE}/choices/trip_fee_and_rate`).send({ choice: { option: 'b' }, version: d.version });
    expect(staged.status).toBe(200);
    before = await raw();
    for (const version of [d.version + 1, d.version]) {
      res = await request(app).put(`${BASE}/metro`).send({ metro: 'CMH', version });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/DRAFT_METRO_LOCKED/);
    }
    expect(await raw()).toEqual(before);
    await expectOneMetro('CLE');

    // Approved: DRAFT_APPROVED.
    tenant = await createTestTenant(pool);
    d = await seedCleveland();
    const approved = await request(app).post(`${BASE}/approve`).send({ expectedVersion: d.version });
    expect(approved.status).toBe(200);
    before = await raw();
    res = await request(app).put(`${BASE}/metro`).send({ metro: 'CMH', version: approved.body.draft.version });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/DRAFT_APPROVED/);
    expect(await raw()).toEqual(before);
    expect(await metroAudits()).toHaveLength(0);
  });

  const setColumbus = (v: number) =>
    draftRepo.setMetro(tenant.tenantId, 'CMH', v, (row) =>
      assembleTypicalShop(tierRepo, { packId: row.packId, businessName: row.businessName, ownerFirstName: row.ownerFirstName ?? undefined, metro: COLUMBUS }),
    );
  const stagePremium = (v: number) => draftRepo.stageChoice(tenant.tenantId, 'trip_fee_and_rate', { option: 'b' }, v);

  /** After every run: the columns and the shop name one metro, and a staged pick sits beside the shop it was staged against. */
  async function expectInvariant(code: 'CLE' | 'CMH', stagedChoices: Record<string, unknown>) {
    const row = await expectOneMetro(code);
    expect(row.choices).toEqual(stagedChoices);
    return row;
  }

  it('metro first, then a choice PUT from the same rendered version (5 fresh tenants): the choice is VERSION_CONFLICT naming v and v + 1, then lands against the Columbus shop at v + 1', async () => {
    for (let i = 0; i < 5; i++) {
      tenant = await createTestTenant(pool);
      const d = await seedCleveland();
      const v = d.version;
      const { first, second } = await raceFirstThen(pool, tenant.tenantId, () => setColumbus(v), () => stagePremium(v));
      expect(first.version).toBe(v + 1);
      expect(second.status).toBe('rejected');
      const reason = (second as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(DraftVersionConflictError);
      expect(reason).toMatchObject({ expected: v, actual: v + 1 });
      const afterRace = await expectInvariant('CMH', {});
      expect(afterRace.version).toBe(v + 1);

      // The loser re-reads and re-sends once with v + 1: its pick is staged against the Columbus shop.
      const resent = await stagePremium(v + 1);
      expect(resent.version).toBe(v + 2);
      const row = await expectInvariant('CMH', { trip_fee_and_rate: { option: 'b' } });
      const premium = row.assembled.choices.find((c) => c.settingKey === 'trip_fee_and_rate')!.options[1];
      expect(premium.prices).toEqual(CMH.premium);
    }
  });

  it('a choice PUT first, then the metro from the same rendered version (5 fresh tenants): the metro is DRAFT_METRO_LOCKED and Cleveland stays with its staged pick', async () => {
    for (let i = 0; i < 5; i++) {
      tenant = await createTestTenant(pool);
      const d = await seedCleveland();
      const v = d.version;
      const { second } = await raceFirstThen(pool, tenant.tenantId, () => stagePremium(v), () => setColumbus(v));
      expect(second.status).toBe('rejected');
      expect((second as PromiseRejectedResult).reason).toBeInstanceOf(DraftMetroLockedError);
      const row = await expectInvariant('CLE', { trip_fee_and_rate: { option: 'b' } });
      expect(row.version).toBe(v + 1);
      const premium = row.assembled.choices.find((c) => c.settingKey === 'trip_fee_and_rate')!.options[1];
      expect(premium.prices).toEqual(CLE.premium);
    }
  });
});
