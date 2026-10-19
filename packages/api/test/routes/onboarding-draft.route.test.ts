import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeEach } from 'vitest';
import { createOnboardingDraftRouter } from '../../src/routes/onboarding-draft';
import { DraftNotApprovedError, DraftVersionConflictError, InMemoryOnboardingDraftRepository } from '../../src/onboarding/draft/repository';
import { ONBOARDING_READBACK_SURFACE } from '../../src/onboarding/draft/approve';
import { InMemoryRegionalPriceTierRepository } from '../../src/onboarding/choices/price-tiers';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT_ID = '00000000-0000-0000-0000-0000000000a1';
const USER_ID = 'user-owner-1';
const CLE = { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } };
const CMH = { standard: { tripFeeCents: 7900, hourlyRateCents: 13500 }, premium: { tripFeeCents: 10900, hourlyRateCents: 16500 } };

function buildApp(role: 'owner' | 'dispatcher' = 'owner', draftRepo: InMemoryOnboardingDraftRepository = new InMemoryOnboardingDraftRepository()) {
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: USER_ID, sessionId: 's1', tenantId: TENANT_ID, role };
    next();
  });
  app.use(
    '/api/onboarding/draft',
    createOnboardingDraftRouter({
      draftRepo,
      tierRepo: new InMemoryRegionalPriceTierRepository({ 'plumbing|CLE': CLE, 'plumbing|CMH': CMH }),
      proposalRepo,
      auditRepo,
    }),
  );
  return { app, draftRepo, proposalRepo, auditRepo };
}

const CREATE = { packId: 'plumbing', businessName: 'Walsh Plumbing', ownerFirstName: 'Jenna', phone: '(216) 555-0142', clientTimezone: 'America/New_York' };

describe('onboarding draft routes', () => {
  let ctx: ReturnType<typeof buildApp>;
  beforeEach(() => {
    ctx = buildApp();
  });

  it('GET before any draft is 404', async () => {
    const res = await request(ctx.app).get('/api/onboarding/draft');
    expect(res.status).toBe(404);
  });

  it('POST assembles the typical shop from trade and area code and creates the draft; a second POST returns the same draft', async () => {
    const first = await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    const d = first.body.draft;
    expect(d.version).toBe(1);
    expect(d.metroCode).toBe('CLE');
    expect(d.metroName).toBe('Cleveland');
    expect(d.assembled.showsCity).toBe(true);
    expect(d.assembled.choices).toHaveLength(8);
    const price = d.assembled.choices.find((c: { settingKey: string }) => c.settingKey === 'trip_fee_and_rate');
    expect(price.options[0].label).toBe('$89 to come out, then $150 an hour');
    expect(d.clientTimezone).toBe('America/New_York');

    const second = await request(ctx.app).post('/api/onboarding/draft').send({ ...CREATE, businessName: 'Other' });
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.draft.id).toBe(d.id);
    expect(second.body.draft.businessName).toBe('Walsh Plumbing');

    const audits = await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 50 });
    expect(audits.filter((a) => a.eventType === 'onboarding.draft_created')).toHaveLength(1);
  });

  it('POST rejects a malformed body', async () => {
    const res = await request(ctx.app).post('/api/onboarding/draft').send({ packId: '' });
    expect(res.status).toBe(400);
  });

  it('PUT stages a choice with version CAS and audits it', async () => {
    await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
    const ok = await request(ctx.app).put('/api/onboarding/draft/choices/greeting').send({ choice: { option: 'b' }, version: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.draft.version).toBe(2);
    expect(ok.body.draft.choices.greeting).toEqual({ option: 'b' });

    const stale = await request(ctx.app).put('/api/onboarding/draft/choices/greeting').send({ choice: { option: 'a' }, version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code ?? stale.body.code ?? JSON.stringify(stale.body)).toMatch(/VERSION_CONFLICT/);

    const badKey = await request(ctx.app).put('/api/onboarding/draft/choices/nope').send({ choice: { option: 'a' }, version: 2 });
    expect(badKey.status).toBe(400);
    const badBody = await request(ctx.app).put('/api/onboarding/draft/choices/greeting').send({ choice: { option: 'c' }, version: 2 });
    expect(badBody.status).toBe(400);

    const audits = await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 50 });
    expect(audits.filter((a) => a.eventType === 'onboarding.choice_staged')).toHaveLength(1);
  });

  it('PUT without a draft is 404', async () => {
    const res = await request(ctx.app).put('/api/onboarding/draft/choices/greeting').send({ choice: { option: 'a' }, version: 1 });
    expect(res.status).toBe(404);
  });

  it('POST approve mints two proposals, approves them, marks the draft approved, and is idempotent', async () => {
    await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
    await request(ctx.app).put('/api/onboarding/draft/choices/trip_fee_and_rate').send({ choice: { option: 'b' }, version: 1 });

    const res = await request(ctx.app).post('/api/onboarding/draft/approve').send({});
    expect(res.status).toBe(200);
    expect(res.body.approvedNow).toBe(true);
    expect(res.body.proposalIds).toHaveLength(2);
    expect(res.body.draft.status).toBe('approved');

    const proposals = await ctx.proposalRepo.findByTenant(TENANT_ID);
    expect(proposals).toHaveLength(2);
    for (const p of proposals) {
      expect(p.status).toBe('approved');
      expect(p.sourceContext).toMatchObject({ surface: ONBOARDING_READBACK_SURFACE });
    }
    const settings = proposals.find((p) => p.proposalType === 'onboarding_tenant_settings')!;
    expect(settings.payload).toMatchObject({ businessName: 'Walsh Plumbing', city: 'Cleveland', verticalPacks: ['plumbing'], tripFeeCents: 12900, hourlyRateCents: 18500, timezone: 'America/New_York' });
    const policy = proposals.find((p) => p.proposalType === 'onboarding_voice_policy')!;
    expect(policy.payload).toMatchObject({ autonomousBookingEnabled: true, paymentCollectionMode: 'pay_link' });

    const again = await request(ctx.app).post('/api/onboarding/draft/approve').send({});
    expect(again.status).toBe(200);
    expect(again.body.approvedNow).toBe(false);
    expect(again.body.proposalIds).toEqual(res.body.proposalIds);
    expect(await ctx.proposalRepo.findByTenant(TENANT_ID)).toHaveLength(2);

    const afterApprove = await request(ctx.app).put('/api/onboarding/draft/choices/greeting').send({ choice: { option: 'a' }, version: res.body.draft.version });
    expect(afterApprove.status).toBe(409);

    const audits = await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 50 });
    expect(audits.filter((a) => a.eventType === 'onboarding.draft_approved')).toHaveLength(1);
  });

  it('POST approve without a timezone on the draft is 400 and mints nothing', async () => {
    await request(ctx.app).post('/api/onboarding/draft').send({ ...CREATE, clientTimezone: undefined });
    const res = await request(ctx.app).post('/api/onboarding/draft/approve').send({});
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/TIMEZONE_REQUIRED/);
    expect(await ctx.proposalRepo.findByTenant(TENANT_ID)).toHaveLength(0);
  });

  it('a later POST records a timezone the first call lacked, so approve then succeeds', async () => {
    const first = await request(ctx.app).post('/api/onboarding/draft').send({ ...CREATE, clientTimezone: undefined });
    expect(first.status).toBe(201);
    expect(first.body.draft.clientTimezone).toBeNull();
    expect((await request(ctx.app).post('/api/onboarding/draft/approve').send({})).status).toBe(400);

    const again = await request(ctx.app).post('/api/onboarding/draft').send({ ...CREATE, clientTimezone: 'America/Phoenix' });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.draft.id).toBe(first.body.draft.id);
    expect(again.body.draft.clientTimezone).toBe('America/Phoenix');
    expect(again.body.draft.version).toBe(first.body.draft.version + 1);

    // Same zone again is a no-op: no version bump, no second audit event.
    const same = await request(ctx.app).post('/api/onboarding/draft').send({ ...CREATE, clientTimezone: 'America/Phoenix' });
    expect(same.body.draft.version).toBe(again.body.draft.version);

    const approve = await request(ctx.app).post('/api/onboarding/draft/approve').send({});
    expect(approve.status).toBe(200);
    const audits = await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 50 });
    expect(audits.filter((a) => a.eventType === 'onboarding.draft_timezone_set')).toHaveLength(1);
    const settings = (await ctx.proposalRepo.findByTenant(TENANT_ID)).find((p) => p.proposalType === 'onboarding_tenant_settings')!;
    expect(settings.payload).toMatchObject({ timezone: 'America/Phoenix' });
  });

  it('POST rejects an unrecognized timezone on create and on update', async () => {
    const onCreate = await request(ctx.app).post('/api/onboarding/draft').send({ ...CREATE, clientTimezone: 'Mars/Olympus' });
    expect(onCreate.status).toBe(400);
    expect(await ctx.draftRepo.getForTenant(TENANT_ID)).toBeNull();

    await request(ctx.app).post('/api/onboarding/draft').send({ ...CREATE, clientTimezone: undefined });
    const onUpdate = await request(ctx.app).post('/api/onboarding/draft').send({ ...CREATE, clientTimezone: 'Mars/Olympus' });
    expect(onUpdate.status).toBe(400);
    expect((await ctx.draftRepo.getForTenant(TENANT_ID))!.clientTimezone).toBeNull();
  });

  it('a repeat POST with a different timezone leaves an approved draft untouched', async () => {
    await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
    await request(ctx.app).post('/api/onboarding/draft/approve').send({});
    const res = await request(ctx.app).post('/api/onboarding/draft').send({ ...CREATE, clientTimezone: 'America/Phoenix' });
    expect(res.status).toBe(200);
    expect(res.body.draft.clientTimezone).toBe('America/New_York');
  });

  it('PUT rejects an override whose writes belong to another choice, or whose prices are misplaced', async () => {
    await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
    const smuggled = await request(ctx.app)
      .put('/api/onboarding/draft/choices/greeting')
      .send({ choice: { override: { label: 'Hi there', writes: { voiceGreeting: 'Hi', autonomousBookingEnabled: true } } }, version: 1 });
    expect(smuggled.status).toBe(400);
    expect(JSON.stringify(smuggled.body)).toMatch(/autonomousBookingEnabled/);

    const noPrices = await request(ctx.app)
      .put('/api/onboarding/draft/choices/trip_fee_and_rate')
      .send({ choice: { override: { label: '$120 then $175', writes: {} } }, version: 1 });
    expect(noPrices.status).toBe(400);

    const strayPrices = await request(ctx.app)
      .put('/api/onboarding/draft/choices/greeting')
      .send({ choice: { override: { label: 'Hi there', writes: { voiceGreeting: 'Hi' }, prices: { tripFeeCents: 100, hourlyRateCents: 200 } } }, version: 1 });
    expect(strayPrices.status).toBe(400);

    // Nothing was staged or audited by the rejected calls.
    expect((await ctx.draftRepo.getForTenant(TENANT_ID))!.version).toBe(1);
    const audits = await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 50 });
    expect(audits.filter((a) => a.eventType === 'onboarding.choice_staged')).toHaveLength(0);

    const ok = await request(ctx.app)
      .put('/api/onboarding/draft/choices/greeting')
      .send({ choice: { override: { label: 'Hi there', writes: { voiceGreeting: 'Hi there' } } }, version: 1 });
    expect(ok.status).toBe(200);
  });

  it('POST approve without a draft is 404', async () => {
    const res = await request(ctx.app).post('/api/onboarding/draft/approve').send({});
    expect(res.status).toBe(404);
  });

  describe('POST approve expectedVersion', () => {
    const errText = (res: { body: unknown }) => JSON.stringify(res.body);
    const approvedAudits = async () =>
      (await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 50 })).filter((a) => a.eventType === 'onboarding.draft_approved');

    it('approves when expectedVersion matches the draft', async () => {
      const created = await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
      const res = await request(ctx.app).post('/api/onboarding/draft/approve').send({ expectedVersion: created.body.draft.version });
      expect(res.status).toBe(200);
      expect(res.body.approvedNow).toBe(true);
      expect(await ctx.proposalRepo.findByTenant(TENANT_ID)).toHaveLength(2);
    });

    it('a stale expectedVersion is 409 VERSION_CONFLICT naming expected and found, and nothing is minted', async () => {
      await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
      await request(ctx.app).put('/api/onboarding/draft/choices/greeting').send({ choice: { option: 'b' }, version: 1 });
      const res = await request(ctx.app).post('/api/onboarding/draft/approve').send({ expectedVersion: 1 });
      expect(res.status).toBe(409);
      expect(errText(res)).toMatch(/VERSION_CONFLICT/);
      expect(errText(res)).toMatch(/expected 1, found 2/);
      expect(await ctx.proposalRepo.findByTenant(TENANT_ID)).toHaveLength(0);
      const got = await request(ctx.app).get('/api/onboarding/draft');
      expect(got.body.draft.status).toBe('draft');
      expect(got.body.draft.choices.greeting).toEqual({ option: 'b' });
      expect(await approvedAudits()).toHaveLength(0);
    });

    it('an expectedVersion ahead of the row is the same 409', async () => {
      await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
      const res = await request(ctx.app).post('/api/onboarding/draft/approve').send({ expectedVersion: 9 });
      expect(res.status).toBe(409);
      expect(errText(res)).toMatch(/VERSION_CONFLICT/);
      expect(await ctx.proposalRepo.findByTenant(TENANT_ID)).toHaveLength(0);
    });

    it('no body at all and {} both approve (lock-only mode)', async () => {
      await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
      const noBody = await request(ctx.app).post('/api/onboarding/draft/approve');
      expect(noBody.status).toBe(200);
      expect(noBody.body.approvedNow).toBe(true);
      const empty = await request(ctx.app).post('/api/onboarding/draft/approve').send({});
      expect(empty.status).toBe(200);
      expect(empty.body.approvedNow).toBe(false);
    });

    it.each([[{ expectedVersion: 'x' }], [{ expectedVersion: 0 }], [{ expectedVersion: 1.5 }], [{ bogus: 1 }]])(
      'rejects %j with 400 and mints nothing',
      async (body) => {
        await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
        const res = await request(ctx.app).post('/api/onboarding/draft/approve').send(body);
        expect(res.status).toBe(400);
        expect(await ctx.proposalRepo.findByTenant(TENANT_ID)).toHaveLength(0);
      },
    );

    it('a second approve with a now-stale expectedVersion is still the idempotent 200', async () => {
      const created = await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
      const v = created.body.draft.version;
      const first = await request(ctx.app).post('/api/onboarding/draft/approve').send({ expectedVersion: v });
      const second = await request(ctx.app).post('/api/onboarding/draft/approve').send({ expectedVersion: v });
      expect(second.status).toBe(200);
      expect(second.body.approvedNow).toBe(false);
      expect(second.body.proposalIds).toEqual(first.body.proposalIds);
      expect(await ctx.proposalRepo.findByTenant(TENANT_ID)).toHaveLength(2);
    });

    it('PUT keeps its codes through the shared error mapping: DRAFT_APPROVED after approve, VERSION_CONFLICT when stale', async () => {
      await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
      const stale = await request(ctx.app).put('/api/onboarding/draft/choices/greeting').send({ choice: { option: 'a' }, version: 7 });
      expect(stale.status).toBe(409);
      expect(errText(stale)).toMatch(/VERSION_CONFLICT/);
      const approved = await request(ctx.app).post('/api/onboarding/draft/approve').send({});
      const after = await request(ctx.app).put('/api/onboarding/draft/choices/greeting').send({ choice: { option: 'a' }, version: approved.body.draft.version });
      expect(after.status).toBe(409);
      expect(errText(after)).toMatch(/DRAFT_APPROVED/);
    });
  });

  it('every route is owner-only', async () => {
    const { app } = buildApp('dispatcher');
    expect((await request(app).get('/api/onboarding/draft')).status).toBe(403);
    expect((await request(app).post('/api/onboarding/draft').send(CREATE)).status).toBe(403);
    expect((await request(app).put('/api/onboarding/draft/choices/greeting').send({ choice: { option: 'a' }, version: 1 })).status).toBe(403);
    expect((await request(app).post('/api/onboarding/draft/approve').send({})).status).toBe(403);
    expect((await request(app).put('/api/onboarding/draft/metro').send({ metro: 'CMH', version: 1 })).status).toBe(403);
  });
});

describe('PUT /metro', () => {
  const errText = (res: { body: unknown }) => JSON.stringify(res.body);
  const PATH = '/api/onboarding/draft/metro';
  let ctx: ReturnType<typeof buildApp>;
  beforeEach(() => {
    ctx = buildApp();
  });

  async function create() {
    const res = await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
    expect(res.status).toBe(201);
    return res.body.draft as { version: number; metroCode: string };
  }
  const metroAudits = async () => (await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 50 })).filter((a) => a.eventType === 'onboarding.metro_changed');
  const stored = async () => ctx.draftRepo.getForTenant(TENANT_ID);
  const priceOptions = (d: { assembled: { choices: Array<{ settingKey: string; options: Array<{ label: string; prices?: unknown }> }> } }) =>
    d.assembled.choices.find((c) => c.settingKey === 'trip_fee_and_rate')!.options;

  it('re-prices an unstaged draft for the new metro: code, name and the whole shop in one bump, and one onboarding.metro_changed row', async () => {
    const d = await create();
    const res = await request(ctx.app).put(PATH).send({ metro: 'CMH', version: d.version });
    expect(res.status, errText(res)).toBe(200);
    const next = res.body.draft;
    expect(next).toMatchObject({ metroCode: 'CMH', metroName: 'Columbus', version: d.version + 1, choices: {} });
    expect(next.assembled).toMatchObject({ metroCode: 'CMH', metroName: 'Columbus', showsCity: true, priceSource: 'metro', metroCandidates: [] });
    expect(priceOptions(next).map((o) => o.prices)).toEqual([CMH.standard, CMH.premium]);
    expect(priceOptions(next).map((o) => o.label)).toEqual(['$79 to come out, then $135 an hour', '$109 to come out, then $165 an hour']);
    expect(JSON.stringify(next.assembled)).not.toMatch(/Cleveland/);
    expect((await request(ctx.app).get('/api/onboarding/draft')).body.draft).toEqual(next);

    const audits = await metroAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: 'onboarding_draft', entityId: next.id, actorId: USER_ID, metadata: { from: 'CLE', to: 'CMH', version: d.version + 1 } });

    // The approval that follows carries the Columbus city and prices.
    const approved = await request(ctx.app).post('/api/onboarding/draft/approve').send({ expectedVersion: next.version });
    expect(approved.status).toBe(200);
    const settings = (await ctx.proposalRepo.findByTenant(TENANT_ID)).find((p) => p.proposalType === 'onboarding_tenant_settings')!;
    expect(settings.payload).toMatchObject({ city: 'Columbus', tripFeeCents: CMH.standard.tripFeeCents, hourlyRateCents: CMH.standard.hourlyRateCents });
  });

  it('an approved draft is 409 DRAFT_APPROVED; nothing changes and no audit row', async () => {
    const d = await create();
    const approved = await request(ctx.app).post('/api/onboarding/draft/approve').send({ expectedVersion: d.version });
    const before = await stored();
    for (const version of [approved.body.draft.version, approved.body.draft.version + 3]) {
      const res = await request(ctx.app).put(PATH).send({ metro: 'CMH', version });
      expect(res.status).toBe(409);
      expect(errText(res)).toMatch(/DRAFT_APPROVED/);
    }
    expect(await stored()).toEqual(before);
    expect(await metroAudits()).toHaveLength(0);
  });

  it.each([
    ["option 'a'", { option: 'a' }],
    ["option 'b'", { option: 'b' }],
    ['an override', { override: { label: 'Walsh, go ahead', writes: { voiceGreeting: 'Walsh, go ahead' } } }],
  ])('with %s staged is 409 DRAFT_METRO_LOCKED, at the current version and at a stale one; nothing changes and no audit row', async (_n, choice) => {
    const d = await create();
    const staged = await request(ctx.app).put('/api/onboarding/draft/choices/greeting').send({ choice, version: d.version });
    expect(staged.status).toBe(200);
    const before = await stored();
    for (const version of [staged.body.draft.version, d.version]) {
      const res = await request(ctx.app).put(PATH).send({ metro: 'CMH', version });
      expect(res.status).toBe(409);
      expect(errText(res)).toMatch(/DRAFT_METRO_LOCKED/);
      expect(errText(res)).not.toMatch(/VERSION_CONFLICT/);
    }
    expect(await stored()).toEqual(before);
    expect(await metroAudits()).toHaveLength(0);
  });

  it('unstaged with a stale version is 409 VERSION_CONFLICT naming both; nothing written', async () => {
    const d = await create();
    const before = await stored();
    const res = await request(ctx.app).put(PATH).send({ metro: 'CMH', version: d.version + 1 });
    expect(res.status).toBe(409);
    expect(errText(res)).toMatch(new RegExp(`VERSION_CONFLICT: expected ${d.version + 1}, found ${d.version}`));
    expect(await stored()).toEqual(before);
    expect(await metroAudits()).toHaveLength(0);
  });

  it.each([
    ['an unknown code', { metro: 'ZZZ', version: 1 }, 'metro'],
    ['a lowercase code', { metro: 'cmh', version: 1 }, 'metro'],
    ['a city name', { metro: 'Columbus', version: 1 }, 'metro'],
    ['no metro', { version: 1 }, 'metro'],
    ['no version', { metro: 'CMH' }, 'version'],
    ['a zero version', { metro: 'CMH', version: 0 }, 'version'],
    ['an extra field', { metro: 'CMH', version: 1, name: 'Columbus' }, ''],
  ])('%s is 400 naming the field, with nothing written and no audit row', async (_n, body, field) => {
    await create();
    const before = await stored();
    const res = await request(ctx.app).put(PATH).send(body);
    expect(res.status).toBe(400);
    const paths = (res.body.details?.issues ?? []).map((i: { path: string }) => i.path);
    if (field) expect(paths).toContain(field);
    expect(await stored()).toEqual(before);
    expect(await metroAudits()).toHaveLength(0);
  });

  it('a known code with no tier row is 200 on the pack-default prices with the city dropped from the copy', async () => {
    const d = await create();
    const res = await request(ctx.app).put(PATH).send({ metro: 'BUF', version: d.version });
    expect(res.status).toBe(200);
    expect(res.body.draft).toMatchObject({ metroCode: 'BUF', metroName: 'Buffalo' });
    expect(res.body.draft.assembled).toMatchObject({ metroCode: 'BUF', showsCity: false, priceSource: 'pack_default' });
    expect(JSON.stringify(res.body.draft.assembled.choices)).not.toMatch(/Buffalo/);
    expect((await metroAudits())[0].metadata).toEqual({ from: 'CLE', to: 'BUF', version: d.version + 1 });
  });

  it('without a draft is 404', async () => {
    const res = await request(ctx.app).put(PATH).send({ metro: 'CMH', version: 1 });
    expect(res.status).toBe(404);
  });
});

describe('POST /retry', () => {
  const errText = (res: { body: unknown }) => JSON.stringify(res.body);
  let ctx: ReturnType<typeof buildApp>;

  beforeEach(() => {
    ctx = buildApp();
  });

  async function approved(): Promise<string[]> {
    await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
    const res = await request(ctx.app).post('/api/onboarding/draft/approve').send({});
    return [...res.body.proposalIds].sort();
  }
  const fail = (id: string) =>
    ctx.proposalRepo.update(TENANT_ID, id, { status: 'execution_failed', approvedAt: new Date(Date.now() - 3_600_000), executionError: 'boom' });

  it('re-queues the failed proposal and answers { draft, retriedProposalIds }', async () => {
    const [a, b] = await approved();
    await fail(a);
    const approvedVersion = (await ctx.draftRepo.getForTenant(TENANT_ID))!.version;
    const res = await request(ctx.app).post('/api/onboarding/draft/retry').send();
    expect(res.status).toBe(200);
    expect(res.body.retriedProposalIds).toEqual([a]);
    expect(res.body.draft.status).toBe('approved');
    // The response names the new attempt: one version past the approval, and it is what GET now returns.
    expect(res.body.draft.version).toBe(approvedVersion + 1);
    expect((await request(ctx.app).get('/api/onboarding/draft')).body.draft.version).toBe(approvedVersion + 1);
    expect((await ctx.proposalRepo.findById(TENANT_ID, a))?.status).toBe('approved');
    expect((await ctx.proposalRepo.findById(TENANT_ID, b))?.status).toBe('approved');
  });

  it('a second immediate retry is a 409 (the row is approved now): no double enqueue', async () => {
    const [a] = await approved();
    await fail(a);
    expect((await request(ctx.app).post('/api/onboarding/draft/retry').send()).status).toBe(200);
    const again = await request(ctx.app).post('/api/onboarding/draft/retry').send();
    expect(again.status).toBe(409);
    expect(errText(again)).toMatch(/DRAFT_RETRY_NOTHING_FAILED/);
    const retried = (await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 100 })).filter((e) => e.eventType === 'proposal.retried');
    expect(retried).toHaveLength(1);
  });

  it('nothing failed is a 409 DRAFT_RETRY_NOTHING_FAILED and the version does not move', async () => {
    await approved();
    const before = (await ctx.draftRepo.getForTenant(TENANT_ID))!;
    const res = await request(ctx.app).post('/api/onboarding/draft/retry').send();
    expect(res.status).toBe(409);
    expect(errText(res)).toMatch(/DRAFT_RETRY_NOTHING_FAILED/);
    expect(await ctx.draftRepo.getForTenant(TENANT_ID)).toEqual(before);
  });

  it('a tab that rendered the original approval is refused after a retry: approve with its expectedVersion is a 409 VERSION_CONFLICT', async () => {
    const created = await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
    const v = created.body.draft.version;
    const first = await request(ctx.app).post('/api/onboarding/draft/approve').send({ expectedVersion: v });
    const [a] = [...first.body.proposalIds].sort();
    await fail(a);

    expect((await request(ctx.app).post('/api/onboarding/draft/retry').send()).status).toBe(200);

    const stale = await request(ctx.app).post('/api/onboarding/draft/approve').send({ expectedVersion: v });
    expect(stale.status).toBe(409);
    expect(errText(stale)).toMatch(/VERSION_CONFLICT/);
    const bare = await request(ctx.app).post('/api/onboarding/draft/approve').send({});
    expect(bare.status).toBe(200);
    expect(bare.body.approvedNow).toBe(false);
    expect(await ctx.proposalRepo.findByTenant(TENANT_ID)).toHaveLength(2);
  });

  it('a failed proposal next to an undone one is a 409 DRAFT_RETRY_UNSAFE and nothing is re-queued', async () => {
    const [a, b] = await approved();
    await fail(a);
    await ctx.proposalRepo.update(TENANT_ID, b, { status: 'undone' });
    const draftBefore = await ctx.draftRepo.getForTenant(TENANT_ID);
    const res = await request(ctx.app).post('/api/onboarding/draft/retry').send();
    expect(res.status).toBe(409);
    expect(errText(res)).toMatch(/DRAFT_RETRY_UNSAFE/);
    expect((await ctx.proposalRepo.findById(TENANT_ID, a))?.status).toBe('execution_failed');
    expect((await ctx.proposalRepo.findById(TENANT_ID, b))?.status).toBe('undone');
    expect(await ctx.draftRepo.getForTenant(TENANT_ID)).toEqual(draftBefore);
    const retried = (await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 100 })).filter((e) => e.eventType === 'proposal.retried');
    expect(retried).toHaveLength(0);
  });

  it('a draft that is not approved yet is a 409 DRAFT_NOT_APPROVED', async () => {
    await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
    const res = await request(ctx.app).post('/api/onboarding/draft/retry').send();
    expect(res.status).toBe(409);
    expect(errText(res)).toMatch(/DRAFT_NOT_APPROVED/);
  });

  it('no draft is a 404', async () => {
    expect((await request(ctx.app).post('/api/onboarding/draft/retry').send()).status).toBe(404);
  });

  /** The version bump goes through updateLocked; its typed refusals answer through the same mapper as every draft write. */
  it.each([
    { thrown: () => new DraftNotApprovedError(), code: /DRAFT_NOT_APPROVED/ },
    { thrown: () => new DraftVersionConflictError(4, 5), code: /VERSION_CONFLICT: expected 4, found 5/ },
  ])('a refused version bump ($code) is a 409, not a 500, and no retry is recorded', async ({ thrown, code }) => {
    class RefusingBump extends InMemoryOnboardingDraftRepository {
      override async markRetried(): Promise<never> {
        throw thrown();
      }
    }
    ctx = buildApp('owner', new RefusingBump());
    const [a] = await approved();
    await fail(a);
    const res = await request(ctx.app).post('/api/onboarding/draft/retry').send();
    expect(res.status).toBe(409);
    expect(errText(res)).toMatch(code);
    const retried = (await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 100 })).filter((e) => e.eventType === 'proposal.retried');
    expect(retried).toHaveLength(0);
  });

  it('is owner-only', async () => {
    const { app } = buildApp('dispatcher');
    expect((await request(app).post('/api/onboarding/draft/retry').send()).status).toBe(403);
  });

  describe('S4: { expectedVersion } and undoable', () => {
    const post = (body?: object) => {
      const r = request(ctx.app).post('/api/onboarding/draft/retry');
      return body === undefined ? r.send() : r.send(body);
    };

    it('the bodyless POST keeps the #1694 behaviour: 200, the version moves by one, and undoable rides beside the draft', async () => {
      const [a, b] = await approved();
      await fail(a);
      // The worker is behind: the sibling is still approved, past its window.
      await ctx.proposalRepo.update(TENANT_ID, b, { approvedAt: new Date(Date.now() - 6000) });
      const v = (await ctx.draftRepo.getForTenant(TENANT_ID))!.version;
      const res = await post();
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['draft', 'retriedProposalIds', 'undoable']);
      expect(res.body.draft.version).toBe(v + 1);
      // Partial retry: the sibling's window is the original approval's, so the whole set is not undoable.
      expect(res.body.undoable).toBe(false);
    });

    it('a full-set retry answers undoable: true; {} is the same as no body', async () => {
      const ids = await approved();
      for (const id of ids) await fail(id);
      const res = await post({});
      expect(res.status).toBe(200);
      expect(res.body.undoable).toBe(true);
    });

    it('the failed screen\'s version re-queues; a stale one is 409 VERSION_CONFLICT naming both, with nothing re-queued', async () => {
      const [a] = await approved();
      await fail(a);
      const v = (await ctx.draftRepo.getForTenant(TENANT_ID))!.version;

      const stale = await post({ expectedVersion: v - 1 });
      expect(stale.status).toBe(409);
      expect(stale.body.message).toBe(`VERSION_CONFLICT: expected ${v - 1}, found ${v}; re-read the draft`);
      expect((await ctx.proposalRepo.findById(TENANT_ID, a))?.status).toBe('execution_failed');
      expect((await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 100 })).filter((e) => e.eventType === 'proposal.retried')).toHaveLength(0);

      const ok = await post({ expectedVersion: v });
      expect(ok.status).toBe(200);
      expect(ok.body.draft.version).toBe(v + 1);
      // Two retries at one version: the loser is refused by the version the winner moved.
      const loser = await post({ expectedVersion: v });
      expect(loser.status).toBe(409);
      expect(loser.body.message).toMatch(new RegExp(`^VERSION_CONFLICT: expected ${v}, found ${v + 1}`));
    });

    it('guard order: DRAFT_NOT_APPROVED before VERSION_CONFLICT before DRAFT_RETRY_UNSAFE', async () => {
      await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
      expect(errText(await post({ expectedVersion: 99 }))).toMatch(/DRAFT_NOT_APPROVED/);

      const [a, b] = [...(await request(ctx.app).post('/api/onboarding/draft/approve').send({})).body.proposalIds].sort();
      await fail(a);
      await ctx.proposalRepo.update(TENANT_ID, b, { status: 'undone' });
      const v = (await ctx.draftRepo.getForTenant(TENANT_ID))!.version;
      expect(errText(await post({ expectedVersion: v + 5 }))).toMatch(/VERSION_CONFLICT/);
      expect(errText(await post({ expectedVersion: v }))).toMatch(/DRAFT_RETRY_UNSAFE/);
    });

    it.each([[{ expectedVersion: 'x' }], [{ expectedVersion: 1.5 }], [{ expectedVersion: 0 }], [{ expectedVersion: -2 }], [{ bogus: 1 }]])(
      'rejects %j with 400 and re-queues nothing',
      async (body) => {
        const [a] = await approved();
        await fail(a);
        const before = await ctx.draftRepo.getForTenant(TENANT_ID);
        const res = await post(body);
        expect(res.status).toBe(400);
        expect(await ctx.draftRepo.getForTenant(TENANT_ID)).toEqual(before);
        expect((await ctx.proposalRepo.findById(TENANT_ID, a))?.status).toBe('execution_failed');
      },
    );
  });
});

describe('POST /undo', () => {
  const errText = (res: { body: unknown }) => JSON.stringify(res.body);
  let ctx: ReturnType<typeof buildApp>;
  const undo = (body?: unknown) => {
    const r = request(ctx.app).post('/api/onboarding/draft/undo');
    return body === undefined ? r.send() : r.send(body as object);
  };

  beforeEach(() => {
    ctx = buildApp();
  });

  /** Approve and return the approve response's draft.version, which the saving screen holds. */
  async function approved(): Promise<{ ids: string[]; version: number }> {
    await request(ctx.app).post('/api/onboarding/draft').send(CREATE);
    const res = await request(ctx.app).post('/api/onboarding/draft/approve').send({});
    return { ids: [...res.body.proposalIds].sort(), version: res.body.draft.version };
  }

  it('inside the window with the approve response version: 200 { draft } back in editing, both proposals undone', async () => {
    const { ids, version } = await approved();
    const res = await undo({ expectedVersion: version });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['draft']);
    expect(res.body.draft).toMatchObject({ status: 'draft', proposalIds: [], approvedAt: null, version: version + 1 });
    for (const id of ids) expect((await ctx.proposalRepo.findById(TENANT_ID, id))?.status).toBe('undone');
    const audit = await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 100 });
    expect(audit.filter((e) => e.eventType === 'onboarding.draft_undone')).toHaveLength(1);
    // The owner can edit and approve again.
    const restage = await request(ctx.app).put('/api/onboarding/draft/choices/greeting').send({ choice: { option: 'b' }, version: version + 1 });
    expect(restage.status).toBe(200);
  });

  it.each([[undefined], [{}], [{ expectedVersion: 'x' }], [{ expectedVersion: 1.5 }], [{ expectedVersion: 0 }], [{ expectedVersion: -1 }], [{ bogus: 1 }]])(
    'rejects %j with 400 naming expectedVersion, and nothing is written',
    async (body) => {
      const { ids } = await approved();
      const before = await ctx.draftRepo.getForTenant(TENANT_ID);
      const res = await undo(body);
      expect(res.status).toBe(400);
      expect((res.body.details.issues as { path: string }[]).map((i) => i.path)).toContain('expectedVersion');
      expect(await ctx.draftRepo.getForTenant(TENANT_ID)).toEqual(before);
      for (const id of ids) expect((await ctx.proposalRepo.findById(TENANT_ID, id))?.status).toBe('approved');
    },
  );

  it('an extra key beside a valid version is 400 too', async () => {
    const { version } = await approved();
    expect((await undo({ expectedVersion: version, bogus: 1 })).status).toBe(400);
  });

  it('a stale or ahead version is 409 VERSION_CONFLICT naming both; nothing changes', async () => {
    const { ids, version } = await approved();
    const before = await ctx.draftRepo.getForTenant(TENANT_ID);
    for (const sent of [version - 1, version + 2]) {
      const res = await undo({ expectedVersion: sent });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe(`VERSION_CONFLICT: expected ${sent}, found ${version}; re-read the draft`);
    }
    expect(await ctx.draftRepo.getForTenant(TENANT_ID)).toEqual(before);
    for (const id of ids) expect((await ctx.proposalRepo.findById(TENANT_ID, id))?.status).toBe('approved');
  });

  it('the same tap twice: the second is 409 DRAFT_NOT_APPROVED', async () => {
    const { version } = await approved();
    expect((await undo({ expectedVersion: version })).status).toBe(200);
    const again = await undo({ expectedVersion: version });
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/^DRAFT_NOT_APPROVED: /);
  });

  it('a member already applying is 409 DRAFT_UNDO_REFUSED with the statuses in details; a closed window is 409 UNDO_WINDOW_CLOSED', async () => {
    const { ids, version } = await approved();
    await ctx.proposalRepo.update(TENANT_ID, ids[0], { status: 'executing' });
    const refused = await undo({ expectedVersion: version });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/^DRAFT_UNDO_REFUSED: /);
    expect(refused.body.details.statuses).toEqual(expect.arrayContaining(['executing', 'approved']));

    await ctx.proposalRepo.update(TENANT_ID, ids[0], { status: 'approved', approvedAt: new Date(Date.now() - 60_000) });
    const closed = await undo({ expectedVersion: version });
    expect(closed.status).toBe(409);
    expect(closed.body.message).toMatch(/^UNDO_WINDOW_CLOSED: /);
    expect((await ctx.draftRepo.getForTenant(TENANT_ID))?.status).toBe('approved');
  });

  it('no draft is a 404, and the route is owner-only', async () => {
    expect((await undo({ expectedVersion: 1 })).status).toBe(404);
    const { app } = buildApp('dispatcher');
    expect((await request(app).post('/api/onboarding/draft/undo').send({ expectedVersion: 1 })).status).toBe(403);
    expect(errText(await request(app).post('/api/onboarding/draft/undo').send({ expectedVersion: 1 }))).not.toMatch(/DRAFT_/);
  });
});
