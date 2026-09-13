/**
 * Route tests — GET /api/estimates/:id/revisions (revision read path).
 *
 * The document-revision subsystem snapshots every estimate edit (see
 * recordEstimateMutation in estimates/estimate.ts: two revisions + an edit
 * delta whose summary describes the diff between them), but nothing surfaced
 * the revision list to a user. This proves the read path: auth gating, RBAC,
 * tenant scoping (cross-tenant 404, not an empty list), newest-first
 * ordering, source pass-through (manual | ai_generated | ai_revised), and
 * the per-revision diff summary joined from the recorded edit delta.
 */
import express, { Express, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { createEstimateRouter } from '../../src/routes/estimates';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryEditDeltaRepository } from '../../src/estimates/edit-delta';
import {
  InMemoryDocumentRevisionRepository,
  createRevision,
} from '../../src/ai/document-revision';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const SAMPLE_LINE_ITEMS = [
  {
    id: 'li-1',
    description: 'Diagnostic fee',
    quantity: 1,
    unitPriceCents: 9500,
    totalCents: 9500,
    category: 'labor',
    sortOrder: 0,
    taxable: false,
  },
];

function makeSeedSettings(tenantId: string): TenantSettings {
  return {
    id: `settings-${tenantId}`,
    tenantId,
    businessName: 'Test Business',
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

interface Repos {
  estimateRepo: InMemoryEstimateRepository;
  settingsRepo: InMemorySettingsRepository;
  auditRepo: InMemoryAuditRepository;
  docRevisionRepo: InMemoryDocumentRevisionRepository;
  editDeltaRepo: InMemoryEditDeltaRepository;
}

interface BuildOpts {
  tenantId: string;
  repos: Repos;
  /** Defaults to 'owner'. Pass 'technician' to test RBAC (no estimates:view). */
  role?: string;
  /** When true, no auth is injected (simulates unauthenticated request). */
  noAuth?: boolean;
  /** When true, the router is mounted WITHOUT revisionDeps (503 path). */
  withoutRevisionDeps?: boolean;
}

function buildApp(opts: BuildOpts): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (!opts.noAuth) {
      (req as AuthenticatedRequest).auth = {
        userId: `user-${opts.tenantId}`,
        sessionId: `session-${opts.tenantId}`,
        tenantId: opts.tenantId,
        role: opts.role ?? 'owner',
      };
    }
    next();
  });
  const { estimateRepo, settingsRepo, auditRepo, docRevisionRepo, editDeltaRepo } = opts.repos;
  app.use(
    '/api/estimates',
    createEstimateRouter(
      estimateRepo,
      settingsRepo,
      auditRepo,
      permissiveTenantOwnership(),
      undefined,
      undefined,
      undefined,
      opts.withoutRevisionDeps ? undefined : { docRevisionRepo, editDeltaRepo },
    ),
  );
  return app;
}

async function createEstimate(app: Express, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/estimates')
    .send({
      jobId: 'job-1',
      estimateNumber: 'PLACEHOLDER',
      lineItems: SAMPLE_LINE_ITEMS,
      ...overrides,
    });
}

describe('GET /api/estimates/:id/revisions', () => {
  let repos: Repos;
  let app: Express;

  beforeEach(async () => {
    repos = {
      estimateRepo: new InMemoryEstimateRepository(),
      settingsRepo: new InMemorySettingsRepository(),
      auditRepo: new InMemoryAuditRepository(),
      docRevisionRepo: new InMemoryDocumentRevisionRepository(),
      editDeltaRepo: new InMemoryEditDeltaRepository(),
    };
    await repos.settingsRepo.create(makeSeedSettings(TENANT_A));
    await repos.settingsRepo.create(makeSeedSettings(TENANT_B));
    app = buildApp({ tenantId: TENANT_A, repos });
  });

  it('401 when unauthenticated', async () => {
    const noAuthApp = buildApp({ tenantId: TENANT_A, repos, noAuth: true });
    const res = await request(noAuthApp).get('/api/estimates/e1/revisions');
    expect(res.status).toBe(401);
  });

  it('403 for a role without estimates:view', async () => {
    const techApp = buildApp({ tenantId: TENANT_A, repos, role: 'technician' });
    const res = await request(techApp).get('/api/estimates/e1/revisions');
    expect(res.status).toBe(403);
  });

  it('404 for an unknown estimate', async () => {
    const res = await request(app).get('/api/estimates/nope/revisions');
    expect(res.status).toBe(404);
  });

  it('returns an empty array for an estimate with no recorded revisions', async () => {
    const created = await createEstimate(app);
    expect(created.status).toBe(201);
    const res = await request(app).get(`/api/estimates/${created.body.id}/revisions`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('lists revisions newest-first with source, createdAt, and the diff summary where present', async () => {
    const created = await createEstimate(app, { taxRateBps: 0 });
    expect(created.status).toBe(201);
    const patched = await request(app)
      .patch(`/api/estimates/${created.body.id}`)
      .send({
        lineItems: [
          {
            id: 'li-1',
            description: 'Revised',
            quantity: 2,
            unitPriceCents: 5000,
            totalCents: 10000,
            category: 'labor',
            sortOrder: 0,
            taxable: false,
          },
        ],
      });
    expect(patched.status).toBe(200);

    const res = await request(app).get(`/api/estimates/${created.body.id}/revisions`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // One edit snapshots before + after.
    expect(res.body).toHaveLength(2);

    for (const rev of res.body) {
      expect(typeof rev.id).toBe('string');
      expect(rev.source).toBe('manual');
      expect(typeof rev.createdAt).toBe('string');
      expect(Number.isNaN(Date.parse(rev.createdAt))).toBe(false);
    }

    // Newest first: the "after" snapshot (higher version) leads.
    expect(res.body[0].version).toBeGreaterThan(res.body[1].version);

    // The diff summary is joined onto the revision the edit produced;
    // the pre-edit snapshot has no summary.
    expect(typeof res.body[0].summary).toBe('string');
    expect(res.body[0].summary).toMatch(/change/i);
    expect(res.body[1].summary).toBeUndefined();
  });

  it('passes through AI revision sources', async () => {
    const created = await createEstimate(app);
    expect(created.status).toBe(201);
    await createRevision(
      {
        tenantId: TENANT_A,
        documentType: 'estimate',
        documentId: created.body.id,
        snapshot: { lineItems: [] },
        source: 'ai_generated',
        actorId: 'ai-run-1',
        actorRole: 'system',
      },
      repos.docRevisionRepo,
    );

    const res = await request(app).get(`/api/estimates/${created.body.id}/revisions`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].source).toBe('ai_generated');
  });

  it('404 (not an empty list) for a cross-tenant estimate', async () => {
    const created = await createEstimate(app, { taxRateBps: 0 });
    expect(created.status).toBe(201);
    await request(app)
      .patch(`/api/estimates/${created.body.id}`)
      .send({ discountCents: 500 });

    const appB = buildApp({ tenantId: TENANT_B, repos });
    const res = await request(appB).get(`/api/estimates/${created.body.id}/revisions`);
    expect(res.status).toBe(404);
    expect(Array.isArray(res.body)).toBe(false);
  });

  it('503 when the revision subsystem is not wired', async () => {
    const bareApp = buildApp({ tenantId: TENANT_A, repos, withoutRevisionDeps: true });
    const created = await createEstimate(bareApp);
    expect(created.status).toBe(201);
    const res = await request(bareApp).get(`/api/estimates/${created.body.id}/revisions`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('NOT_CONFIGURED');
  });
});
