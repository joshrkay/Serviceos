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
 *   - /api/estimates       (4 routes, no list endpoint)
 *   - /api/invoices        (5 routes, no list endpoint)
 *   - /api/appointments    (4 routes)
 *   - /api/notes           (4 routes, no GET/:id)
 *
 * Estimates + invoices were unblocked by the edge-case slice that
 * added `ensureTenantSettings` lazy seeding to `getNextEstimateNumber`
 * / `getNextInvoiceNumber`. Brand-new tenants now get default
 * settings on first use, and `bootstrapTenant` also seeds the row
 * via the Clerk webhook for the production path.
 *
 * Deferred: payments, voice, conversations, settings-shaped routes,
 * assistant, and cross-entity reference forgery (e.g., job in tenant B
 * that points at customer in tenant A).
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
// Accepted status codes for a denied cross-tenant attempt: 400/401/403/404.
// 500 was accepted in the first cut because POST /api/jobs/:id/transition
// exploded on a null cross-tenant lookup; the edge-case slice tightened
// that handler (and proved the others were already clean) so this set
// can stay strict. The non-negotiable part is that no resource body
// leaks through — every probe additionally asserts no id match in the
// response body.
const ISOLATION_OK_STATUSES = [400, 401, 403, 404];

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
  estimateId: string;
  invoiceId: string;
  appointmentId: string;
  noteId: string;
}

function sampleLineItem(id: string, unitCents: number) {
  return {
    id,
    description: 'Adversarial test line',
    category: 'labor' as const,
    quantity: 1,
    unitPriceCents: unitCents,
    totalCents: unitCents,
    sortOrder: 1,
    taxable: true,
  };
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
    // P0-033: this suite uses synthetic HMAC dev tokens via signToken().
    // The new RS256 verifier is the default; honor the legacy HMAC path
    // explicitly. Production-mode would refuse this flag (defense in depth)
    // but vitest defaults NODE_ENV to 'test'.
    process.env.CLERK_DEV_HMAC_TOKENS = 'true';
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

    const estimateRes = await request(app)
      .post('/api/estimates')
      .set(bearer(tokenA))
      .send({
        jobId,
        estimateNumber: 'EST-IGNORED',
        lineItems: [sampleLineItem('est-line-1', 5000)],
      });
    expect(estimateRes.status).toBe(201);
    const estimateId = estimateRes.body.id as string;

    const invoiceRes = await request(app)
      .post('/api/invoices')
      .set(bearer(tokenA))
      .send({
        jobId,
        invoiceNumber: 'INV-IGNORED',
        lineItems: [sampleLineItem('inv-line-1', 5000)],
      });
    expect(invoiceRes.status).toBe(201);
    const invoiceId = invoiceRes.body.id as string;

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

    graphA = { customerId, locationId, jobId, estimateId, invoiceId, appointmentId, noteId };
  });

  afterAll(() => {
    delete process.env.CLERK_DEV_HMAC_TOKENS;
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

  // ── Estimates ────────────────────────────────────────────────────────

  describe('/api/estimates', () => {
    it('tenant B cannot GET tenant A estimate', async () => {
      await probeCannotRead(app, '/api/estimates', graphA.estimateId, tokenB);
    });

    it('tenant B cannot PUT tenant A estimate', async () => {
      await probeCannotUpdate(app, '/api/estimates', graphA.estimateId, tokenB, {
        customerMessage: 'hacked',
      });
    });

    it('tenant B cannot transition tenant A estimate', async () => {
      await probeCannotHitLifecycle(
        app,
        'post',
        `/api/estimates/${graphA.estimateId}/transition`,
        tokenB,
        { status: 'sent' }
      );
    });
  });

  // ── Invoices ─────────────────────────────────────────────────────────

  describe('/api/invoices', () => {
    it('tenant B cannot GET tenant A invoice', async () => {
      await probeCannotRead(app, '/api/invoices', graphA.invoiceId, tokenB);
    });

    it('tenant B cannot PUT tenant A invoice', async () => {
      await probeCannotUpdate(app, '/api/invoices', graphA.invoiceId, tokenB, {
        customerMessage: 'hacked',
      });
    });

    it('tenant B cannot transition tenant A invoice', async () => {
      await probeCannotHitLifecycle(
        app,
        'post',
        `/api/invoices/${graphA.invoiceId}/transition`,
        tokenB,
        { status: 'open' }
      );
    });

    it('tenant B cannot issue tenant A invoice', async () => {
      await probeCannotHitLifecycle(
        app,
        'post',
        `/api/invoices/${graphA.invoiceId}/issue`,
        tokenB
      );
    });
  });

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

  // ── Cross-entity reference forgery ──────────────────────────────────
  //
  // Body-forged `tenantId` is structurally impossible (Zod schemas strip
  // it on parse, handlers re-assign from the JWT). The harder class is
  // cross-entity reference forgery: tenant B sending a parent id (e.g.
  // customerId) that belongs to tenant A. Without a guard, the new
  // child entity gets stamped with tenant B's tenantId but its parent
  // reference field still leaks tenant A's UUID.
  //
  // Closed by the `TenantOwnership` guard in
  // `packages/api/src/shared/tenant-ownership.ts`, wired into the six
  // POST handlers (locations, jobs, appointments, notes, estimates,
  // invoices). These tests prove the guard works on every entity.

  describe('cross-entity reference forgery', () => {
    let tenantBCustomerId: string;
    let tenantBLocationId: string;
    let tenantBJobId: string;

    beforeAll(async () => {
      // Seed a minimal tenant B graph so we can construct otherwise-
      // valid create requests that only differ in the forged parent ref.
      const cust = await request(app)
        .post('/api/customers')
        .set(bearer(tokenB))
        .send({ firstName: 'Bob', lastName: 'TenantB' });
      expect(cust.status).toBe(201);
      tenantBCustomerId = cust.body.id;

      const loc = await request(app)
        .post('/api/locations')
        .set(bearer(tokenB))
        .send({
          customerId: tenantBCustomerId,
          street1: '2 Tenant B Way',
          city: 'Btown',
          state: 'CA',
          postalCode: '94001',
        });
      expect(loc.status).toBe(201);
      tenantBLocationId = loc.body.id;

      const job = await request(app)
        .post('/api/jobs')
        .set(bearer(tokenB))
        .send({
          customerId: tenantBCustomerId,
          locationId: tenantBLocationId,
          summary: 'Tenant B own job',
        });
      expect(job.status).toBe(201);
      tenantBJobId = job.body.id;
    });

    it('POST /api/locations in tenant B with tenant A customerId → 404', async () => {
      const res = await request(app)
        .post('/api/locations')
        .set(bearer(tokenB))
        .send({
          customerId: graphA.customerId, // forged
          street1: '3 Forge Way',
          city: 'Btown',
          state: 'CA',
          postalCode: '94001',
        });
      expect(res.status).toBe(404);
    });

    it('POST /api/jobs in tenant B with tenant A customerId → 404', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set(bearer(tokenB))
        .send({
          customerId: graphA.customerId, // forged
          locationId: tenantBLocationId,
          summary: 'Forged customer ref',
        });
      expect(res.status).toBe(404);
    });

    it('POST /api/jobs in tenant B with tenant A locationId → 404', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set(bearer(tokenB))
        .send({
          customerId: tenantBCustomerId,
          locationId: graphA.locationId, // forged
          summary: 'Forged location ref',
        });
      expect(res.status).toBe(404);
    });

    it('POST /api/appointments in tenant B with tenant A jobId → 404', async () => {
      const start = new Date();
      start.setHours(start.getHours() + 1);
      const end = new Date(start);
      end.setHours(end.getHours() + 1);
      const res = await request(app)
        .post('/api/appointments')
        .set(bearer(tokenB))
        .send({
          jobId: graphA.jobId, // forged
          scheduledStart: start.toISOString(),
          scheduledEnd: end.toISOString(),
          timezone: 'UTC',
        });
      expect(res.status).toBe(404);
    });

    it('POST /api/notes in tenant B with tenant A entityId → 404', async () => {
      const res = await request(app)
        .post('/api/notes')
        .set(bearer(tokenB))
        .send({
          entityType: 'customer',
          entityId: graphA.customerId, // forged
          content: 'Forged note',
        });
      expect(res.status).toBe(404);
    });

    it('POST /api/estimates in tenant B with tenant A jobId → 404', async () => {
      const res = await request(app)
        .post('/api/estimates')
        .set(bearer(tokenB))
        .send({
          jobId: graphA.jobId, // forged
          estimateNumber: 'EST-IGNORED',
          lineItems: [sampleLineItem('forge-est', 1000)],
        });
      expect(res.status).toBe(404);
    });

    it('POST /api/invoices in tenant B with tenant A jobId → 404', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .set(bearer(tokenB))
        .send({
          jobId: graphA.jobId, // forged
          invoiceNumber: 'INV-IGNORED',
          lineItems: [sampleLineItem('forge-inv', 1000)],
        });
      expect(res.status).toBe(404);
    });

    it('POST /api/invoices in tenant B with own jobId but tenant A estimateId → 404', async () => {
      const res = await request(app)
        .post('/api/invoices')
        .set(bearer(tokenB))
        .send({
          jobId: tenantBJobId,
          estimateId: graphA.estimateId, // forged
          invoiceNumber: 'INV-IGNORED-2',
          lineItems: [sampleLineItem('forge-inv-2', 1000)],
        });
      expect(res.status).toBe(404);
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
