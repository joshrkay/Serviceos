import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { describe, it, expect, beforeEach } from 'vitest';
import { createOnboardingDraftRouter } from '../../src/routes/onboarding-draft';
import { InMemoryOnboardingDraftRepository } from '../../src/onboarding/draft/repository';
import { OWNER_PHONE_INVALID_MESSAGE } from '../../src/onboarding/draft/owner-phone';
import { InMemoryRegionalPriceTierRepository } from '../../src/onboarding/choices/price-tiers';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT_ID = '00000000-0000-0000-0000-0000000000b1';
const CLE = { standard: { tripFeeCents: 8900, hourlyRateCents: 15000 }, premium: { tripFeeCents: 12900, hourlyRateCents: 18500 } };
const BASE = '/api/onboarding/draft';

function buildApp(role: 'owner' | 'dispatcher' = 'owner') {
  const draftRepo = new InMemoryOnboardingDraftRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: 'user-owner-1', sessionId: 's1', tenantId: TENANT_ID, role };
    next();
  });
  app.use(
    BASE,
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
const { phone: _phone, ...CREATE_NO_PHONE } = CREATE;

describe('owner cell on the onboarding draft routes', () => {
  let ctx: ReturnType<typeof buildApp>;
  beforeEach(() => {
    ctx = buildApp();
  });

  async function settingsPayload() {
    return (await ctx.proposalRepo.findByTenant(TENANT_ID)).find((p) => p.proposalType === 'onboarding_tenant_settings')!.payload;
  }

  describe('POST /', () => {
    it('stores the first-screen cell as E.164 and still places the metro from it', async () => {
      const res = await request(ctx.app).post(BASE).send(CREATE);
      expect(res.status).toBe(201);
      expect(res.body.draft.ownerPhone).toBe('+12165550142');
      expect(res.body.draft.metroCode).toBe('CLE');
      const audits = await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 50 });
      const created = audits.find((a) => a.eventType === 'onboarding.draft_created')!;
      expect(created.metadata).toMatchObject({ hasOwnerPhone: true });
      expect(JSON.stringify(created.metadata)).not.toContain('5550142');
    });

    it('without a cell, ownerPhone is null', async () => {
      const res = await request(ctx.app).post(BASE).send(CREATE_NO_PHONE);
      expect(res.status).toBe(201);
      expect(res.body.draft.ownerPhone).toBeNull();
      const audits = await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 50 });
      expect(audits.find((a) => a.eventType === 'onboarding.draft_created')!.metadata).toMatchObject({ hasOwnerPhone: false });
    });

    it.each(['abcdefgh', '555-0142', '123-456-7890'])('a cell that does not normalise (%j) is a 400 naming phone and creates nothing', async (phone) => {
      const res = await request(ctx.app).post(BASE).send({ ...CREATE, phone });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(res.body.details.issues[0]).toEqual({ path: 'phone', message: OWNER_PHONE_INVALID_MESSAGE });
      expect(await ctx.draftRepo.getForTenant(TENANT_ID)).toBeNull();
      const audits = await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 50 });
      expect(audits.filter((a) => a.eventType === 'onboarding.draft_created')).toHaveLength(0);
    });

    it('a 3-character phone fails the length rule, also naming phone', async () => {
      const res = await request(ctx.app).post(BASE).send({ ...CREATE, phone: '123' });
      expect(res.status).toBe(400);
      expect(res.body.details.issues[0].path).toBe('phone');
    });

    it('a repeat POST with a different valid phone leaves the stored cell and version alone; an invalid one is still a 400', async () => {
      const first = await request(ctx.app).post(BASE).send(CREATE);
      const again = await request(ctx.app).post(BASE).send({ ...CREATE, phone: '(216) 555-0199' });
      expect(again.status).toBe(200);
      expect(again.body.created).toBe(false);
      expect(again.body.draft.ownerPhone).toBe('+12165550142');
      expect(again.body.draft.version).toBe(first.body.draft.version);
      const bad = await request(ctx.app).post(BASE).send({ ...CREATE, phone: 'abc' });
      expect(bad.status).toBe(400);
    });
  });

  describe('PUT /owner-phone', () => {
    it('normalises, stores, bumps the version, and audits with a masked number', async () => {
      await request(ctx.app).post(BASE).send(CREATE_NO_PHONE);
      const res = await request(ctx.app).put(`${BASE}/owner-phone`).send({ ownerPhone: '(216) 555-0199', version: 1 });
      expect(res.status).toBe(200);
      expect(res.body.draft.ownerPhone).toBe('+12165550199');
      expect(res.body.draft.version).toBe(2);
      const audits = await ctx.auditRepo.findRecentByTenant(TENANT_ID, { limit: 50 });
      const set = audits.filter((a) => a.eventType === 'onboarding.owner_phone_set');
      expect(set).toHaveLength(1);
      expect(set[0].entityType).toBe('onboarding_draft');
      expect(set[0].entityId).toBe(res.body.draft.id);
      expect(JSON.stringify(set[0].metadata)).not.toContain('+12165550199');
      expect(JSON.stringify(set[0].metadata)).not.toContain('2165550199');
    });

    it('a stale version is a 409 VERSION_CONFLICT and changes nothing', async () => {
      await request(ctx.app).post(BASE).send(CREATE_NO_PHONE);
      await request(ctx.app).put(`${BASE}/owner-phone`).send({ ownerPhone: '2165550199', version: 1 });
      const stale = await request(ctx.app).put(`${BASE}/owner-phone`).send({ ownerPhone: '2165550177', version: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body.message).toMatch(/^VERSION_CONFLICT/);
      expect((await ctx.draftRepo.getForTenant(TENANT_ID))!.ownerPhone).toBe('+12165550199');
    });

    it('after approve it is a 409 DRAFT_APPROVED and the cell is unchanged', async () => {
      await request(ctx.app).post(BASE).send(CREATE);
      const approved = await request(ctx.app).post(`${BASE}/approve`).send({});
      expect(approved.status).toBe(200);
      const res = await request(ctx.app).put(`${BASE}/owner-phone`).send({ ownerPhone: '2165550199', version: approved.body.draft.version });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/^DRAFT_APPROVED/);
      expect((await ctx.draftRepo.getForTenant(TENANT_ID))!.ownerPhone).toBe('+12165550142');
    });

    it.each(['12345', 'abc'])('a value that does not normalise (%j) is a 400 naming ownerPhone', async (ownerPhone) => {
      await request(ctx.app).post(BASE).send(CREATE_NO_PHONE);
      const res = await request(ctx.app).put(`${BASE}/owner-phone`).send({ ownerPhone, version: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(res.body.details.issues[0]).toEqual({ path: 'ownerPhone', message: OWNER_PHONE_INVALID_MESSAGE });
      expect((await ctx.draftRepo.getForTenant(TENANT_ID))!.version).toBe(1);
    });

    it.each([
      ['missing ownerPhone', { version: 1 }],
      ['missing version', { ownerPhone: '2165550199' }],
      ['version 0', { ownerPhone: '2165550199', version: 0 }],
      ['empty ownerPhone', { ownerPhone: '', version: 1 }],
      ['null ownerPhone', { ownerPhone: null, version: 1 }],
      ['extra key', { ownerPhone: '2165550199', version: 1, extra: true }],
    ])('rejects a malformed body: %s', async (_name, body) => {
      await request(ctx.app).post(BASE).send(CREATE_NO_PHONE);
      const res = await request(ctx.app).put(`${BASE}/owner-phone`).send(body);
      expect(res.status).toBe(400);
    });

    it('without a draft is 404', async () => {
      const res = await request(ctx.app).put(`${BASE}/owner-phone`).send({ ownerPhone: '2165550199', version: 1 });
      expect(res.status).toBe(404);
    });

    it('is owner-only', async () => {
      const other = buildApp('dispatcher');
      const res = await request(other.app).put(`${BASE}/owner-phone`).send({ ownerPhone: '2165550199', version: 1 });
      expect(res.status).toBe(403);
    });
  });

  describe('approve', () => {
    it('succeeds without a cell and mints a payload with no ownerPhone key (no gate)', async () => {
      await request(ctx.app).post(BASE).send(CREATE_NO_PHONE);
      const res = await request(ctx.app).post(`${BASE}/approve`).send({});
      expect(res.status).toBe(200);
      expect(res.body.approvedNow).toBe(true);
      expect(await settingsPayload()).not.toHaveProperty('ownerPhone');
    });

    it('carries the first-screen cell', async () => {
      await request(ctx.app).post(BASE).send(CREATE);
      await request(ctx.app).post(`${BASE}/approve`).send({});
      expect(await settingsPayload()).toMatchObject({ ownerPhone: '+12165550142' });
    });

    it('carries a cell added later with PUT /owner-phone', async () => {
      await request(ctx.app).post(BASE).send(CREATE_NO_PHONE);
      await request(ctx.app).put(`${BASE}/owner-phone`).send({ ownerPhone: '216-555-0177', version: 1 });
      await request(ctx.app).post(`${BASE}/approve`).send({});
      expect(await settingsPayload()).toMatchObject({ ownerPhone: '+12165550177' });
    });
  });
});
