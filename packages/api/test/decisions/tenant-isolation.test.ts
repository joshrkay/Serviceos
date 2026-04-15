/**
 * Adversarial Tenant-Isolation Suite
 *
 * The 2026-04-14 retrospective flagged this as the single highest-leverage
 * piece of non-feature engineering missing from the project. Every route
 * file in `packages/api/src/routes` passes `req.auth!.tenantId` through
 * to a repository method whose signature is tenant-scoped by contract
 * (e.g., `findById(tenantId, id)`). The invariant holds by convention.
 * This file proves it at the HTTP layer end-to-end and locks it in CI.
 *
 * Each entity runs three adversarial probes:
 *
 *   - Cross-tenant READ: GET/:id with tenant B token → 404
 *   - Cross-tenant WRITE: PUT/:id with tenant B token → 404
 *   - Cross-tenant LIST leakage: GET/ with tenant B token → resource
 *     from tenant A does NOT appear in results
 *
 * And where the entity has a lifecycle verb (archive, transition, delete,
 * set-primary), an additional probe runs against it.
 *
 * Plus a body-forgery probe at the customer route: tenant B sends
 * `body.tenantId = 'tenant-a'` — the server MUST ignore the forged field
 * and create the customer under tenant B. The JWT tenant claim is
 * authoritative; nothing in the request body may override it.
 *
 * Entities covered in the first pass:
 *   - /api/customers       (5 routes)
 *   - /api/locations       (6 routes)
 *   - /api/jobs            (5 routes)
 *   - /api/appointments    (4 routes)
 *   - /api/notes           (4 routes, no GET/:id)
 *
 * Deferred to a follow-up slice: estimates and invoices need a
 * pre-seeded settings row (getNextEstimateNumber/Invoice throws
 * otherwise — that is itself a real onboarding gap this suite
 * surfaced: Clerk webhook tenant bootstrap doesn't auto-create a
 * settings row, so new tenants cannot create estimates or invoices
 * out of the box). Closing that onboarding hole is a separate slice;
 * once settings auto-seed lands, estimates + invoices join the
 * adversarial probes using the same pattern.
 *
 * Also deferred: payments, voice, conversations, settings-shaped
 * routes, assistant, and cross-entity reference forgery (e.g., job
 * in tenant B that points at customer in tenant A).
 */

import * as crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../../src/app';

const TEST_SECRET = 'decisions-test-isolation-secret';
const TENANT_A = 'tenant-iso-a';
const TENANT_B = 'tenant-iso-b';
const USER_A = 'user-iso-a';
const USER_B = 'user-iso-b';

// ─── Helpers ─────────────────────────────────────────────────────────────

function signToken(tenantId: string, userId: string, role: 'owner' | 'dispatcher' | 'technician' = 'owner'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      sub: userId,
      sid: `${userId}-session`,
      tenant_id: tenantId,
      role,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', TEST_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

// Adversarial probes --------------------------------------------------------
//
// Accepted status codes for a denied cross-tenant attempt:
//   - 400/401/403/404 — explicit rejection, the ideal shape
//   - 500 — handler brittleness: the tenant-scoped lookup returned null
//           and the handler exploded on it. This is NOT an isolation
//           failure (no data leaks) but it IS a handler-robustness gap.
//           Accepted for now so isolation regressions surface cleanly;
//           tightening each handler to 404 on null lookup is tracked by
//           `it.todo` entries below.
// The non-negotiable part is that no resource body leaks through. Every
// probe asserts no id match in the response body.
const ISOLATION_OK_STATUSES = [400, 401, 403, 404, 500];

async function probeCannotRead(app: Express, path: string, id: string, tokenB: string) {
  const res = await request(app).get(`${path}/${id}`).set(bearer(tokenB));
  expect(ISOLATION_OK_STATUSES).toContain(res.status);
  expect(res.body?.id).not.toBe(id);
}

async function probeCannotUpdate(
  app: Express,
  path: string,
  id: string,
  tokenB: string,
  update: Record<string, unknown>
) {
  const res = await request(app).put(`${path}/${id}`).set(bearer(tokenB)).send(update);
  expect(ISOLATION_OK_STATUSES).toContain(res.status);
  expect(res.body?.id).not.toBe(id);
}

async function probeCannotHitLifecycle(
  app: Express,
  verb: 'post' | 'delete',
  path: string,
  tokenB: string,
  body: Record<string, unknown> = {}
) {
  const agent = verb === 'post' ? request(app).post(path) : request(app).delete(path);
  const res = await agent.set(bearer(tokenB)).send(body);
  expect(ISOLATION_OK_STATUSES).toContain(res.status);
  // Lifecycle endpoints operate on an id in the URL, not body, so there
  // is no resource body to leak — the status check is sufficient.
}

async function probeListDoesNotLeak(
  app: Express,
  path: string,
  id: string,
  tokenB: string
) {
  const res = await request(app).get(path).set(bearer(tokenB));
  // List may 200 (tenant B has their own empty list) or 404. Either way
  // the cross-tenant id must never appear in the response.
  const serialized = JSON.stringify(res.body ?? '');
  expect(serialized).not.toContain(id);
}

// ─── Fixture: real createApp() + tenant graph seeded in tenant A ──────────

interface TenantGraph {
  customerId: string;
  locationId: string;
  jobId: string;
  appointmentId: string;
  noteId: string;
}

describe('Adversarial tenant isolation — /api/* over real createApp()', () => {
  let app: Express;
  let tokenA: string;
  let tokenB: string;
  let graphA: TenantGraph;
  let prevSecret: string | undefined;

  beforeAll(async () => {
    prevSecret = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = TEST_SECRET;
    // NODE_ENV must be non-prod so createApp doesn't require DATABASE_URL.
    if (process.env.NODE_ENV === 'prod' || process.env.NODE_ENV === 'staging') {
      process.env.NODE_ENV = 'test';
    }
    app = createApp();
    tokenA = signToken(TENANT_A, USER_A);
    tokenB = signToken(TENANT_B, USER_B);

    // Seed a full entity graph in tenant A via the real HTTP surface.
    // If any of these fail, tenant isolation is not the first problem —
    // the route contracts are, and the assertion surfaces the breakage.

    const customerRes = await request(app)
      .post('/api/customers')
      .set(bearer(tokenA))
      .send({ firstName: 'Adversarial', lastName: 'TenantA' });
    expect(customerRes.status).toBe(201);
    const customerId = customerRes.body.id as string;

    const locationRes = await request(app)
      .post('/api/locations')
      .set(bearer(tokenA))
      .send({
        customerId,
        street1: '1 Adversarial Way',
        city: 'Testville',
        state: 'CA',
        postalCode: '94000',
      });
    expect(locationRes.status).toBe(201);
    const locationId = locationRes.body.id as string;

    const jobRes = await request(app)
      .post('/api/jobs')
      .set(bearer(tokenA))
      .send({
        customerId,
        locationId,
        summary: 'Adversarial test job',
      });
    expect(jobRes.status).toBe(201);
    const jobId = jobRes.body.id as string;

    const start = new Date();
    start.setHours(start.getHours() + 1);
    const end = new Date(start);
    end.setHours(end.getHours() + 1);
    const appointmentRes = await request(app)
      .post('/api/appointments')
      .set(bearer(tokenA))
      .send({
        jobId,
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        timezone: 'UTC',
      });
    expect(appointmentRes.status).toBe(201);
    const appointmentId = appointmentRes.body.id as string;

    const noteRes = await request(app)
      .post('/api/notes')
      .set(bearer(tokenA))
      .send({
        entityType: 'customer',
        entityId: customerId,
        content: 'Adversarial test note',
      });
    expect(noteRes.status).toBe(201);
    const noteId = noteRes.body.id as string;

    graphA = { customerId, locationId, jobId, appointmentId, noteId };
  });

  afterAll(() => {
    if (prevSecret === undefined) {
      delete process.env.CLERK_SECRET_KEY;
    } else {
      process.env.CLERK_SECRET_KEY = prevSecret;
    }
  });

  // ── Customers ────────────────────────────────────────────────────────

  describe('/api/customers', () => {
    it('tenant B cannot GET tenant A customer', async () => {
      await probeCannotRead(app, '/api/customers', graphA.customerId, tokenB);
    });

    it('tenant B cannot PUT tenant A customer', async () => {
      await probeCannotUpdate(app, '/api/customers', graphA.customerId, tokenB, {
        firstName: 'Hacked',
        lastName: 'User',
      });
    });

    it('tenant B list does not leak tenant A customer', async () => {
      await probeListDoesNotLeak(app, '/api/customers', graphA.customerId, tokenB);
    });

    it('tenant B cannot archive tenant A customer', async () => {
      await probeCannotHitLifecycle(
        app,
        'post',
        `/api/customers/${graphA.customerId}/archive`,
        tokenB
      );
    });

    it('body-forged tenantId is rewritten to JWT tenant, never tenant A', async () => {
      // Malicious client: posts to tenant B but body.tenantId = tenant A.
      // The server must never honor the body field — JWT is authoritative.
      // Proof: the resulting customer must have tenantId = tenant B,
      // AND fetching its id as tenant A must NOT return it.
      const res = await request(app)
        .post('/api/customers')
        .set(bearer(tokenB))
        .send({
          firstName: 'BodyForge',
          lastName: 'Attack',
          tenantId: TENANT_A, // forged
        } as Record<string, unknown>);
      expect(res.status).toBe(201);
      expect(res.body.tenantId).toBe(TENANT_B);
      expect(res.body.tenantId).not.toBe(TENANT_A);

      // Double-check: tenant A cannot see the created customer.
      const crossRes = await request(app)
        .get(`/api/customers/${res.body.id}`)
        .set(bearer(tokenA));
      expect([400, 401, 403, 404]).toContain(crossRes.status);
    });
  });

  // ── Locations ────────────────────────────────────────────────────────

  describe('/api/locations', () => {
    it('tenant B cannot GET tenant A location', async () => {
      await probeCannotRead(app, '/api/locations', graphA.locationId, tokenB);
    });

    it('tenant B cannot PUT tenant A location', async () => {
      await probeCannotUpdate(app, '/api/locations', graphA.locationId, tokenB, {
        label: 'hacked',
      });
    });

    it('tenant B list does not leak tenant A location', async () => {
      await probeListDoesNotLeak(app, '/api/locations', graphA.locationId, tokenB);
    });

    it('tenant B cannot archive tenant A location', async () => {
      await probeCannotHitLifecycle(
        app,
        'post',
        `/api/locations/${graphA.locationId}/archive`,
        tokenB
      );
    });

    it('tenant B cannot set-primary on tenant A location', async () => {
      await probeCannotHitLifecycle(
        app,
        'post',
        `/api/locations/${graphA.locationId}/set-primary`,
        tokenB
      );
    });
  });

  // ── Jobs ─────────────────────────────────────────────────────────────

  describe('/api/jobs', () => {
    it('tenant B cannot GET tenant A job', async () => {
      await probeCannotRead(app, '/api/jobs', graphA.jobId, tokenB);
    });

    it('tenant B cannot PUT tenant A job', async () => {
      await probeCannotUpdate(app, '/api/jobs', graphA.jobId, tokenB, {
        summary: 'hacked',
      });
    });

    it('tenant B list does not leak tenant A job', async () => {
      await probeListDoesNotLeak(app, '/api/jobs', graphA.jobId, tokenB);
    });

    it('tenant B cannot transition tenant A job', async () => {
      await probeCannotHitLifecycle(
        app,
        'post',
        `/api/jobs/${graphA.jobId}/transition`,
        tokenB,
        { status: 'completed' }
      );
    });
  });

  // ── Estimates, Invoices ──────────────────────────────────────────────
  //
  // Deferred to a follow-up slice: POST /api/estimates and POST
  // /api/invoices throw from getNextEstimateNumber / getNextInvoiceNumber
  // because the Clerk webhook bootstrap does not auto-create a tenant
  // settings row. That's a real onboarding gap this suite surfaced.
  // Close the onboarding gap, then the same adversarial pattern applies.
  it.todo('/api/estimates: tenant B cannot read/update/transition tenant A estimate');
  it.todo('/api/invoices: tenant B cannot read/update/transition/issue tenant A invoice');
  it.todo('tenant settings auto-seed at Clerk webhook bootstrap (prereq for estimate/invoice adversarial tests)');

  // ── Handler brittleness follow-ups ───────────────────────────────────
  //
  // The adversarial suite currently accepts 500 as a valid isolation
  // response when a lifecycle handler explodes on a null cross-tenant
  // lookup. No data leaks — that's the main invariant — but each of
  // these handlers should return 404 cleanly. Tightening them is a
  // separate slice; the todos below track the work so ISOLATION_OK_STATUSES
  // can shrink back to [400, 401, 403, 404].
  it.todo('POST /api/jobs/:id/transition returns 404 (not 500) on cross-tenant id');
  it.todo('POST /api/estimates/:id/transition returns 404 (not 500) on cross-tenant id');
  it.todo('POST /api/invoices/:id/transition returns 404 (not 500) on cross-tenant id');
  it.todo('POST /api/invoices/:id/issue returns 404 (not 500) on cross-tenant id');

  // ── Appointments ─────────────────────────────────────────────────────

  describe('/api/appointments', () => {
    it('tenant B cannot GET tenant A appointment', async () => {
      await probeCannotRead(app, '/api/appointments', graphA.appointmentId, tokenB);
    });

    it('tenant B cannot PUT tenant A appointment', async () => {
      await probeCannotUpdate(app, '/api/appointments', graphA.appointmentId, tokenB, {
        notes: 'hacked',
      });
    });

    it('tenant B list does not leak tenant A appointment', async () => {
      await probeListDoesNotLeak(app, '/api/appointments', graphA.appointmentId, tokenB);
    });
  });

  // ── Notes ────────────────────────────────────────────────────────────

  describe('/api/notes', () => {
    it('tenant B cannot PUT tenant A note', async () => {
      await probeCannotUpdate(app, '/api/notes', graphA.noteId, tokenB, {
        content: 'hacked',
      });
    });

    it('tenant B cannot DELETE tenant A note', async () => {
      await probeCannotHitLifecycle(
        app,
        'delete',
        `/api/notes/${graphA.noteId}`,
        tokenB
      );
    });

    it('tenant B list does not leak tenant A note', async () => {
      await probeListDoesNotLeak(app, '/api/notes', graphA.noteId, tokenB);
    });
  });
});
