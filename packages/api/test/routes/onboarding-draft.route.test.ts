import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeEach } from 'vitest';
import { createOnboardingDraftRouter } from '../../src/routes/onboarding-draft';
import { InMemoryOnboardingDraftRepository } from '../../src/onboarding/draft/repository';
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
      expect(p.sourceContext).toMatchObject({ surface: 'onboarding_readback' });
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

  it('POST approve without a draft is 404', async () => {
    const res = await request(ctx.app).post('/api/onboarding/draft/approve').send({});
    expect(res.status).toBe(404);
  });

  it('every route is owner-only', async () => {
    const { app } = buildApp('dispatcher');
    expect((await request(app).get('/api/onboarding/draft')).status).toBe(403);
    expect((await request(app).post('/api/onboarding/draft').send(CREATE)).status).toBe(403);
    expect((await request(app).put('/api/onboarding/draft/choices/greeting').send({ choice: { option: 'a' }, version: 1 })).status).toBe(403);
    expect((await request(app).post('/api/onboarding/draft/approve').send({})).status).toBe(403);
  });
});
