/**
 * Docker-gated integration test — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * §8.1 row 1.5 — "As T, I want to look around before finishing setup, so I
 * can decide if this is worth my time." G1 (#1006) found NO command proving
 * this row at all ("1.5 has no command — write the soft-gate test").
 *
 * The story is a claim about `GET /api/onboarding/status`: nothing in this
 * codebase stores a "wizard step" pointer or blocks a request until some
 * prior step is marked complete — `deriveOnboardingStatus` (onboarding/
 * derive-status.ts) is a PURE function of facts loaded straight from
 * Postgres (onboarding/load-facts.ts). A tenant can call /status (or any
 * other CRM route) at any point mid-setup and get back an accurate,
 * derived picture — never a redirect-only "finish setup first" gate — and
 * completing steps OUT OF ORDER (pack before identity, here) still derives
 * correctly, which a linear stored-progress wizard would not allow.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createOnboardingRouter } from '../../src/routes/onboarding';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgPackActivationRepository } from '../../src/settings/pg-pack-activation';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

describe('GET /api/onboarding/status — the derived "look around before finishing" gate (1.5)', () => {
  let pool: Pool;
  let app: express.Express;
  let auditRepo: PgAuditRepository;
  let activeTenant: { tenantId: string; userId: string };
  let currentTenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    const settingsRepo = new PgSettingsRepository(pool);
    const packActivationRepo = new PgPackActivationRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: activeTenant.userId,
        sessionId: 'sess-test',
        tenantId: activeTenant.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api/onboarding', createOnboardingRouter({ settingsRepo, packActivationRepo, auditRepo, pool }));
  });

  beforeEach(async () => {
    currentTenant = await createTestTenant(pool);
    activeTenant = currentTenant;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('a brand-new tenant can look around — GET /status succeeds (never a "finish setup first" block) and reports the real, incomplete state', async () => {
    const res = await request(app).get('/api/onboarding/status');
    expect(res.status).toBe(200);
    expect(res.body.isComplete).toBe(false);
    expect(res.body.currentStep).toBe('identity');
    const identityStep = res.body.steps.find((s: { id: string }) => s.id === 'identity');
    expect(identityStep.status).toBe('current');
  });

  it('completing pack BEFORE identity still derives correctly — proves status reads real facts, not a stored linear wizard-progress pointer', async () => {
    // Out-of-order: activate the pack first, without ever touching /identity.
    const packRes = await request(app).post('/api/onboarding/pack').send({ packId: 'hvac' });
    expect(packRes.status).toBe(200);

    const status = await request(app).get('/api/onboarding/status');
    const packStep = status.body.steps.find((s: { id: string }) => s.id === 'pack');
    const identityStep = status.body.steps.find((s: { id: string }) => s.id === 'identity');
    // A stored "you're on step N" wizard pointer would still say "identity"
    // is next-to-submit and would have no way to mark "pack" done out of
    // sequence; the derived facts say otherwise, correctly.
    expect(packStep.status).toBe('done');
    expect(identityStep.status).toBe('current');
    expect(status.body.currentStep).toBe('identity');
  });

  it('PUT /identity is audited against real Postgres, and the very next /status call reflects it immediately — no separate confirmation step', async () => {
    const putRes = await request(app).put('/api/onboarding/identity').send({
      businessName: 'Look Around HVAC',
      businessHours: { mon: { open: '08:00', close: '17:00' } },
      jobBufferMinutes: 30,
      hourlyRateCents: 15000,
      timezone: 'America/Phoenix',
    });
    expect(putRes.status).toBe(200);

    const auditRows = await auditRepo.findByEntity(currentTenant.tenantId, 'tenant_settings', currentTenant.tenantId);
    const identitySet = auditRows.filter((r) => r.eventType === 'tenant.identity_set');
    expect(identitySet).toHaveLength(1);
    expect(identitySet[0].metadata?.businessName).toBe('Look Around HVAC');

    const status = await request(app).get('/api/onboarding/status');
    const identityStep = status.body.steps.find((s: { id: string }) => s.id === 'identity');
    expect(identityStep.status).toBe('done');
  });

  it('T1 — a second tenant looking around at the same time sees none of the first tenant\'s partial setup or audit trail, and vice versa', async () => {
    // Tenant A partially completes setup.
    await request(app).put('/api/onboarding/identity').send({
      businessName: 'Tenant A HVAC',
      businessHours: { mon: { open: '08:00', close: '17:00' } },
      jobBufferMinutes: 30,
      hourlyRateCents: 15000,
      timezone: 'America/Phoenix',
    });

    // Tenant B — brand new, has done NOTHING — looks around via the same route.
    const tenantB = await createTestTenant(pool);
    activeTenant = tenantB;
    const statusB = await request(app).get('/api/onboarding/status');
    activeTenant = currentTenant;

    expect(statusB.status).toBe(200);
    expect(statusB.body.currentStep).toBe('identity');
    const identityStepB = statusB.body.steps.find((s: { id: string }) => s.id === 'identity');
    expect(identityStepB.status).toBe('current');

    // Tenant A's audit trail is invisible under tenant B's id.
    const auditUnderB = await auditRepo.findByEntity(tenantB.tenantId, 'tenant_settings', tenantB.tenantId);
    expect(auditUnderB.filter((r) => r.eventType === 'tenant.identity_set')).toHaveLength(0);

    // And tenant A's own status is unaffected by tenant B ever having looked.
    const statusA = await request(app).get('/api/onboarding/status');
    const identityStepA = statusA.body.steps.find((s: { id: string }) => s.id === 'identity');
    expect(identityStepA.status).toBe('done');
  });
});
