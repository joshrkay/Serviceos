import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeEach } from 'vitest';
import { createOnboardingDraftRouter } from '../../src/routes/onboarding-draft';
import { InMemoryOnboardingDraftRepository } from '../../src/onboarding/draft/repository';
import { ONBOARDING_READBACK_SURFACE } from '../../src/onboarding/draft/approve';
import { InMemoryRegionalPriceTierRepository } from '../../src/onboarding/choices/price-tiers';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT_ID = '00000000-0000-0000-0000-0000000000a1';
const USER_ID = 'user-owner-1';
const CLE = { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } };

function buildApp(role: 'owner' | 'dispatcher' = 'owner') {
  const draftRepo = new InMemoryOnboardingDraftRepository();
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
      tierRepo: new InMemoryRegionalPriceTierRepository({ 'plumbing|CLE': CLE }),
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
    const res = await request(ctx.app).post('/api/onboarding/draft/retry').send();
    expect(res.status).toBe(200);
    expect(res.body.retriedProposalIds).toEqual([a]);
    expect(res.body.draft.status).toBe('approved');
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

  it('nothing failed is a 409 DRAFT_RETRY_NOTHING_FAILED', async () => {
    await approved();
    const res = await request(ctx.app).post('/api/onboarding/draft/retry').send();
    expect(res.status).toBe(409);
    expect(errText(res)).toMatch(/DRAFT_RETRY_NOTHING_FAILED/);
  });

  it('a failed proposal next to an undone one is a 409 DRAFT_RETRY_UNSAFE and nothing is re-queued', async () => {
    const [a, b] = await approved();
    await fail(a);
    await ctx.proposalRepo.update(TENANT_ID, b, { status: 'undone' });
    const res = await request(ctx.app).post('/api/onboarding/draft/retry').send();
    expect(res.status).toBe(409);
    expect(errText(res)).toMatch(/DRAFT_RETRY_UNSAFE/);
    expect((await ctx.proposalRepo.findById(TENANT_ID, a))?.status).toBe('execution_failed');
    expect((await ctx.proposalRepo.findById(TENANT_ID, b))?.status).toBe('undone');
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

  it('is owner-only', async () => {
    const { app } = buildApp('dispatcher');
    expect((await request(app).post('/api/onboarding/draft/retry').send()).status).toBe(403);
  });
});
