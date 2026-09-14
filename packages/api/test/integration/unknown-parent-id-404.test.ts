/**
 * #1187 — a well-formed but *unknown* parent id must 404 and write nothing,
 * at real Postgres.
 *
 * #1185 (#1110) converted *malformed* `:id`s (non-uuid strings) to 404 via
 * `notFoundOnMalformedId`. These are different: the id parses as a uuid but
 * names no row.
 *
 *   1. `POST /api/jobs/:id/files/upload-url` and `.../files/upload`
 *      (job-files.ts) and `POST /api/jobs/:id/photos/presign-upload`
 *      (job-photos.ts) write into `files`, whose `entity_id` is TEXT (no
 *      FK) — an unknown job id wrote an orphan row and 201'd.
 *   2. `PUT /api/customer-groups/:id/members/:customerId` inserts into
 *      `customer_group_members`, whose `customer_id` FKs `customers(id)` —
 *      an unknown customer id hit the FK violation as a bare 500.
 *   3. `POST /api/jobs/:id/photos` inserts into `job_photos`, whose
 *      `job_id` FKs `jobs(id)` — an unknown job id hit the FK violation as
 *      a bare 500.
 *
 * Fix: look the parent up through the tenant-scoped repository (`findById`)
 * before writing, 404 with the #1185 envelope (`{error:'NOT_FOUND', message}`)
 * when it's missing. Because the lookup is tenant-scoped, a tenant B parent
 * id used by tenant A also resolves to "missing" (T1).
 *
 * Harness copied from malformed-id-404-seam.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb, createTestTenant } from './shared';
import type { AppWithLifecycle } from '../../src/app';

function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

function bearer(sub: string, role: 'owner' | 'technician' = 'owner'): string {
  return `Bearer ${unsignedJwt({
    sub,
    sid: `sess-${sub}`,
    role,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`;
}

interface Tenant {
  tenantId: string;
  userId: string;
}

async function seedCustomer(pool: Pool, tenant: Tenant): Promise<string> {
  const customerId = randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, $3, $4)`,
    [customerId, tenant.tenantId, 'Unknown-parent-id customer', tenant.userId],
  );
  return customerId;
}

async function seedJob(pool: Pool, tenant: Tenant): Promise<string> {
  const customerId = await seedCustomer(pool, tenant);
  const locationId = randomUUID();
  const jobId = randomUUID();
  await pool.query(
    `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
     VALUES ($1, $2, $3, '1 Main St', 'Austin', 'TX', '78701')`,
    [locationId, tenant.tenantId, customerId],
  );
  await pool.query(
    `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by)
     VALUES ($1, $2, $3, $4, $5, 'Unknown-parent-id job', $6)`,
    [jobId, tenant.tenantId, customerId, locationId, `JOB-${jobId.slice(0, 8)}`, tenant.userId],
  );
  return jobId;
}

/** #1133 workaround — the request transaction commits on res.finish; poll until visible. */
async function waitForRow(pool: Pool, sql: string, params: unknown[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const { rowCount } = await pool.query(sql, params);
    if ((rowCount ?? 0) > 0 || Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function filesCountForEntity(pool: Pool, entityId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM files WHERE entity_type = 'job' AND entity_id = $1`,
    [entityId],
  );
  return rows[0].n;
}

async function jobPhotosCountForJob(pool: Pool, jobId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM job_photos WHERE job_id = $1`, [jobId]);
  return rows[0].n;
}

async function memberRow(pool: Pool, groupId: string, customerId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM customer_group_members WHERE group_id = $1 AND customer_id = $2`,
    [groupId, customerId],
  );
  return rows[0].n;
}

describe('#1187 — unknown parent ids answer 404 and write nothing, at real Postgres', () => {
  let pool: Pool;
  let app: AppWithLifecycle;
  let tenantA: Tenant;
  let tenantB: Tenant;
  let jobB: string;
  let groupA: string;
  let customerB: string;
  let prevEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    jobB = await seedJob(pool, tenantB);
    customerB = await seedCustomer(pool, tenantB);

    prevEnv = {
      NODE_ENV: process.env.NODE_ENV,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
      PROCESS_ROLE: process.env.PROCESS_ROLE,
      DATABASE_URL: process.env.DATABASE_URL,
      DB_SSL: process.env.DB_SSL,
    };
    process.env.NODE_ENV = 'dev';
    process.env.DEV_AUTH_BYPASS = 'true';
    process.env.PROCESS_ROLE = 'web';
    process.env.DATABASE_URL = process.env.TEST_DB_URL;
    process.env.DB_SSL = 'false';

    const { resetConfig } = await import('../../src/shared/config');
    const { createApp } = await import('../../src/app');
    resetConfig();
    app = createApp();

    const g = await request(app)
      .post('/api/customer-groups')
      .set('Authorization', bearer(tenantA.userId))
      .send({ name: `A-group-${randomUUID().slice(0, 8)}` });
    expect(g.status).toBe(201);
    groupA = g.body.id;
    await waitForRow(pool, 'SELECT 1 FROM customer_groups WHERE id = $1', [groupA]);
  });

  afterAll(async () => {
    await app.gracefulDrain('test-cleanup');
    const { resetConfig } = await import('../../src/shared/config');
    resetConfig();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await closeSharedTestDb();
  });

  describe('1a. POST /api/jobs/:id/files/upload-url — orphan `files` row on an unknown job id', () => {
    it('an unknown job id answers 404 and writes no files row', async () => {
      const unknown = randomUUID();
      const res = await request(app)
        .post(`/api/jobs/${unknown}/files/upload-url`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ filename: 'permit.pdf', contentType: 'application/pdf', sizeBytes: 2048 });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Job not found' });
      expect(await filesCountForEntity(pool, unknown)).toBe(0);
    });

    it("T1: tenant A naming tenant B's real job id answers 404 and B's files are untouched", async () => {
      const before = await filesCountForEntity(pool, jobB);
      const res = await request(app)
        .post(`/api/jobs/${jobB}/files/upload-url`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ filename: 'permit.pdf', contentType: 'application/pdf', sizeBytes: 2048 });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Job not found' });
      expect(await filesCountForEntity(pool, jobB)).toBe(before);
    });

    it("the legit case — the caller's own existing job — still 201s with exactly one files row", async () => {
      const jobA = await seedJob(pool, tenantA);
      const res = await request(app)
        .post(`/api/jobs/${jobA}/files/upload-url`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ filename: 'permit.pdf', contentType: 'application/pdf', sizeBytes: 2048 });
      expect(res.status).toBe(201);
      expect(res.body.fileId).toBeTruthy();
      await waitForRow(pool, 'SELECT 1 FROM files WHERE id = $1', [res.body.fileId]);
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM files WHERE id = $1', [res.body.fileId]);
      expect(rows[0].n).toBe(1);
      expect(await filesCountForEntity(pool, jobA)).toBe(1);
    });
  });

  describe('1b. POST /api/jobs/:id/files/upload — orphan `files` row on an unknown job id', () => {
    it('an unknown job id answers 404 and writes no files row', async () => {
      const unknown = randomUUID();
      const res = await request(app)
        .post(`/api/jobs/${unknown}/files/upload`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ filename: 'permit.pdf', contentType: 'application/pdf', sizeBytes: 2048 });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Job not found' });
      expect(await filesCountForEntity(pool, unknown)).toBe(0);
    });

    it("T1: tenant A naming tenant B's real job id answers 404 and B's files are untouched", async () => {
      const before = await filesCountForEntity(pool, jobB);
      const res = await request(app)
        .post(`/api/jobs/${jobB}/files/upload`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ filename: 'permit.pdf', contentType: 'application/pdf', sizeBytes: 2048 });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Job not found' });
      expect(await filesCountForEntity(pool, jobB)).toBe(before);
    });

    it("the legit case — the caller's own existing job — still 201s with exactly one files row", async () => {
      const jobA = await seedJob(pool, tenantA);
      const res = await request(app)
        .post(`/api/jobs/${jobA}/files/upload`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ filename: 'permit.pdf', contentType: 'application/pdf', sizeBytes: 2048 });
      expect(res.status).toBe(201);
      await waitForRow(pool, 'SELECT 1 FROM files WHERE id = $1', [res.body.fileId]);
      expect(await filesCountForEntity(pool, jobA)).toBe(1);
    });
  });

  describe('1c. POST /api/jobs/:id/photos/presign-upload — orphan `files` row on an unknown job id', () => {
    it('an unknown job id answers 404 and writes no files row', async () => {
      const unknown = randomUUID();
      const res = await request(app)
        .post(`/api/jobs/${unknown}/photos/presign-upload`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ filename: 'before.jpg', contentType: 'image/jpeg', sizeBytes: 2048 });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Job not found' });
      expect(await filesCountForEntity(pool, unknown)).toBe(0);
    });

    it("T1: tenant A naming tenant B's real job id answers 404 and B's files are untouched", async () => {
      const before = await filesCountForEntity(pool, jobB);
      const res = await request(app)
        .post(`/api/jobs/${jobB}/photos/presign-upload`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ filename: 'before.jpg', contentType: 'image/jpeg', sizeBytes: 2048 });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Job not found' });
      expect(await filesCountForEntity(pool, jobB)).toBe(before);
    });

    it("the legit case — the caller's own existing job — still 201s with exactly one files row", async () => {
      const jobA = await seedJob(pool, tenantA);
      const res = await request(app)
        .post(`/api/jobs/${jobA}/photos/presign-upload`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ filename: 'before.jpg', contentType: 'image/jpeg', sizeBytes: 2048 });
      expect(res.status).toBe(201);
      await waitForRow(pool, 'SELECT 1 FROM files WHERE id = $1', [res.body.fileId]);
      expect(await filesCountForEntity(pool, jobA)).toBe(1);
    });
  });

  describe('2. PUT /api/customer-groups/:id/members/:customerId — customer_group_members FK on an unknown customer id', () => {
    it('an unknown customer id answers 404 and writes no membership row (not the FK-violation 500)', async () => {
      const unknown = randomUUID();
      const res = await request(app)
        .put(`/api/customer-groups/${groupA}/members/${unknown}`)
        .set('Authorization', bearer(tenantA.userId))
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Customer not found' });
      expect(await memberRow(pool, groupA, unknown)).toBe(0);
    });

    it("T1: tenant A naming tenant B's real customer id answers 404 and writes no membership row", async () => {
      const res = await request(app)
        .put(`/api/customer-groups/${groupA}/members/${customerB}`)
        .set('Authorization', bearer(tenantA.userId))
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Customer not found' });
      expect(await memberRow(pool, groupA, customerB)).toBe(0);
    });

    it("the legit case — the caller's own existing customer — still 201s with exactly one membership row", async () => {
      const customerA = await seedCustomer(pool, tenantA);
      const res = await request(app)
        .put(`/api/customer-groups/${groupA}/members/${customerA}`)
        .set('Authorization', bearer(tenantA.userId))
        .send({});
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ added: true });
      await waitForRow(
        pool,
        'SELECT 1 FROM customer_group_members WHERE group_id = $1 AND customer_id = $2',
        [groupA, customerA],
      );
      expect(await memberRow(pool, groupA, customerA)).toBe(1);
    });
  });

  describe('3. POST /api/jobs/:id/photos — job_photos FK on an unknown job id', () => {
    it('an unknown job id answers 404 and writes no job_photos row (not the FK-violation 500)', async () => {
      const jobA = await seedJob(pool, tenantA);
      const presign = await request(app)
        .post(`/api/jobs/${jobA}/photos/presign-upload`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ filename: 'before.jpg', contentType: 'image/jpeg', sizeBytes: 2048 });
      expect(presign.status).toBe(201);
      const fileId = presign.body.fileId as string;

      const unknown = randomUUID();
      const res = await request(app)
        .post(`/api/jobs/${unknown}/photos`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ fileId, category: 'before' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Job not found' });
      expect(await jobPhotosCountForJob(pool, unknown)).toBe(0);
    });

    it("T1: tenant A naming tenant B's real job id (with A's own file) answers 404 and B's job_photos are untouched", async () => {
      const jobA = await seedJob(pool, tenantA);
      const presign = await request(app)
        .post(`/api/jobs/${jobA}/photos/presign-upload`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ filename: 'before.jpg', contentType: 'image/jpeg', sizeBytes: 2048 });
      expect(presign.status).toBe(201);
      const fileId = presign.body.fileId as string;

      const before = await jobPhotosCountForJob(pool, jobB);
      const res = await request(app)
        .post(`/api/jobs/${jobB}/photos`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ fileId, category: 'before' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Job not found' });
      expect(await jobPhotosCountForJob(pool, jobB)).toBe(before);
    });

    it("the legit case — the caller's own existing job — still 201s with exactly one job_photos row", async () => {
      const jobA = await seedJob(pool, tenantA);
      const presign = await request(app)
        .post(`/api/jobs/${jobA}/photos/presign-upload`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ filename: 'before.jpg', contentType: 'image/jpeg', sizeBytes: 2048 });
      expect(presign.status).toBe(201);
      const fileId = presign.body.fileId as string;

      const res = await request(app)
        .post(`/api/jobs/${jobA}/photos`)
        .set('Authorization', bearer(tenantA.userId))
        .send({ fileId, category: 'before' });
      expect(res.status).toBe(201);
      await waitForRow(pool, 'SELECT 1 FROM job_photos WHERE id = $1', [res.body.id]);
      expect(await jobPhotosCountForJob(pool, jobA)).toBe(1);
    });
  });
});
