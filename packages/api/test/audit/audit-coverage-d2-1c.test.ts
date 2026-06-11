/**
 * D2-1c — audit-coverage smoke test.
 *
 * CLAUDE.md requires: "All mutations emit audit events". The Phase 1
 * audit (`docs/quality/audit-coverage-2026-05-16.md`) identified four
 * route files whose mutation endpoints had no audit trail anywhere in
 * their call stack:
 *
 *   - proposals (approve / reject / edit / undo)
 *   - settings  (tenant + language)
 *   - users     (role edit + invitation)
 *   - feature-flags (upsert + delete; platform-admin)
 *
 * This file asserts the canary mutation on each of the five most
 * sensitive endpoints persists an audit event with the agreed event
 * type. It does NOT enumerate every metadata field — those are pinned
 * by the individual route unit tests. The point of this file is to
 * prevent a regression where a future refactor removes the audit
 * wiring and the audit row silently stops being written.
 */
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryPlatformAdminChecker } from '../../src/auth/platform-admin';

import { createProposalsRouter } from '../../src/routes/proposals';
import { createSettingsRouter } from '../../src/routes/settings';
import { createUsersRouter } from '../../src/routes/users';
import { createFeatureFlagsRouter } from '../../src/routes/feature-flags';

import {
  InMemoryProposalRepository,
  createProposal,
} from '../../src/proposals/proposal';
import {
  InMemorySettingsRepository,
  TenantSettings,
} from '../../src/settings/settings';
import { InMemoryUserRepository } from '../../src/users/user';
import {
  InMemoryFeatureFlagRepository,
  InMemoryFeatureFlagStore,
} from '../../src/flags/feature-flags';

const TENANT = 'tenant-d21c-smoke';
const USER = 'user-d21c-smoke';

function withAuth(role: 'owner' | 'dispatcher' | 'technician' = 'owner') {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: USER,
      sessionId: 'sess-d21c',
      tenantId: TENANT,
      role,
    };
    next();
  };
}

function seedSettings(tenantId: string): TenantSettings {
  return {
    id: `settings-${tenantId}`,
    tenantId,
    businessName: 'D2-1c smoke',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('D2-1c — audit coverage smoke test', () => {
  it('POST /api/proposals/:id/approve writes proposal.approved', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const proposalRepo = new InMemoryProposalRepository();
    const proposal = createProposal({
      tenantId: TENANT,
      proposalType: 'create_customer',
      payload: { name: 'Audit Smoke' },
      summary: 'smoke',
      createdBy: USER,
    });
    await proposalRepo.create(proposal);
    await proposalRepo.updateStatus(TENANT, proposal.id, 'ready_for_review');

    const app = express();
    app.use(express.json());
    app.use(withAuth());
    app.use(
      '/api/proposals',
      createProposalsRouter(proposalRepo, undefined, auditRepo),
    );

    const res = await request(app).post(`/api/proposals/${proposal.id}/approve`);
    expect(res.status).toBe(200);

    const events = auditRepo.getAll();
    const approved = events.find((e) => e.eventType === 'proposal.approved');
    expect(approved).toBeDefined();
    expect(approved?.tenantId).toBe(TENANT);
    expect(approved?.actorId).toBe(USER);
    expect(approved?.entityType).toBe('proposal');
    expect(approved?.entityId).toBe(proposal.id);
  });

  it('PUT /api/proposals/:id writes proposal.edited', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const proposalRepo = new InMemoryProposalRepository();
    const proposal = createProposal({
      tenantId: TENANT,
      proposalType: 'create_customer',
      payload: { name: 'Audit Smoke' },
      summary: 'smoke',
      createdBy: USER,
    });
    await proposalRepo.create(proposal);
    await proposalRepo.updateStatus(TENANT, proposal.id, 'ready_for_review');

    const app = express();
    app.use(express.json());
    app.use(withAuth());
    app.use(
      '/api/proposals',
      createProposalsRouter(proposalRepo, undefined, auditRepo),
    );

    const res = await request(app)
      .put(`/api/proposals/${proposal.id}`)
      .send({ edits: { name: 'Edited Name' } });
    expect(res.status).toBe(200);

    const events = auditRepo.getAll();
    const edited = events.find((e) => e.eventType === 'proposal.edited');
    expect(edited).toBeDefined();
    expect(edited?.tenantId).toBe(TENANT);
    expect(edited?.entityType).toBe('proposal');
    expect(edited?.metadata?.editedFields).toEqual(['name']);
  });

  it('PUT /api/settings/ writes settings.tenant.updated', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const settingsRepo = new InMemorySettingsRepository();
    await settingsRepo.create(seedSettings(TENANT));

    const app = express();
    app.use(express.json());
    app.use(withAuth());
    app.use('/api/settings', createSettingsRouter(settingsRepo, undefined, auditRepo));

    const res = await request(app)
      .put('/api/settings/')
      .send({ businessName: 'Renamed Inc.' });
    expect(res.status).toBe(200);

    const events = auditRepo.getAll();
    const settingsEvent = events.find(
      (e) => e.eventType === 'settings.tenant.updated',
    );
    expect(settingsEvent).toBeDefined();
    expect(settingsEvent?.tenantId).toBe(TENANT);
    expect(settingsEvent?.entityType).toBe('tenant_settings');
    expect(
      (settingsEvent?.metadata?.changedKeys as string[] | undefined)?.includes(
        'businessName',
      ),
    ).toBe(true);
  });

  it('PATCH /api/users/:id writes user.updated', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const userRepo = new InMemoryUserRepository();
    const targetId = uuidv4();
    const ownerId = uuidv4();
    // Seed two owners so the last-owner guard doesn't block a demotion test;
    // we mutate a technician's name here, but having two owners keeps the
    // tenant safe under any future tweak.
    await userRepo.create!({
      id: ownerId,
      tenantId: TENANT,
      email: 'o@example.com',
      role: 'owner',
      canFieldServe: true,
      clerkUserId: 'clerk_o',
    });
    await userRepo.create!({
      id: targetId,
      tenantId: TENANT,
      email: 't@example.com',
      role: 'technician',
      canFieldServe: false,
      clerkUserId: 'clerk_t',
    });

    const app = express();
    app.use(express.json());
    app.use(withAuth());
    app.use('/api/users', createUsersRouter(userRepo, {}, auditRepo));

    const res = await request(app)
      .patch(`/api/users/${targetId}`)
      .send({ firstName: 'Renamed' });
    expect(res.status).toBe(200);

    const events = auditRepo.getAll();
    const updated = events.find((e) => e.eventType === 'user.updated');
    expect(updated).toBeDefined();
    expect(updated?.tenantId).toBe(TENANT);
    expect(updated?.entityType).toBe('user');
    expect(updated?.entityId).toBe(targetId);
    expect(updated?.metadata?.changedFields).toEqual(['firstName']);
  });

  it('PUT /api/admin/feature-flags/:name writes feature_flag.upserted', async () => {
    const auditRepo = new InMemoryAuditRepository();
    const repo = new InMemoryFeatureFlagRepository();
    const store = new InMemoryFeatureFlagStore();
    const checker = new InMemoryPlatformAdminChecker([USER]);

    const app = express();
    app.use(express.json());
    app.use(withAuth());
    app.use(
      '/api/admin/feature-flags',
      createFeatureFlagsRouter(
        repo,
        store,
        { platformAdminChecker: checker },
        auditRepo,
      ),
    );

    const res = await request(app)
      .put('/api/admin/feature-flags/smoke_flag')
      .send({ enabled: true });
    expect(res.status).toBe(200);

    const events = auditRepo.getAll();
    const upsert = events.find((e) => e.eventType === 'feature_flag.upserted');
    expect(upsert).toBeDefined();
    expect(upsert?.entityType).toBe('feature_flag');
    expect(upsert?.entityId).toBe('smoke_flag');
    // Cross-tenant blast radius — every feature-flag mutation rides under
    // the actor's home tenant id with `scope: 'platform'` so the audit
    // schema's required tenantId stays satisfied without inventing a
    // synthetic id that would break RLS.
    expect(upsert?.metadata?.scope).toBe('platform');
    expect(upsert?.metadata?.flagName).toBe('smoke_flag');
  });
});
