/**
 * #1110 — a malformed `:id` must never surface as a bare 500, at real Postgres.
 *
 * The route tests (test/routes/*-malformed-id.route.test.ts) prove each chain
 * with a PgLike stub. This leg proves it where it matters: a real `createApp()`
 * boot against real Postgres, so the `invalid input syntax for type uuid`
 * that actually throws is the one under test — per CLAUDE.md a mocked Pool is
 * never the only proof a query behaves. It also caught what a stub cannot:
 * the job-files handlers bind `:id` to `files.entity_id`, which is TEXT, so
 * they never 500 and are deliberately NOT converted.
 *
 * For every handler #1110 converts, on one booted app:
 *   (a) a malformed id               → 404 with the route's NOT_FOUND envelope
 *                                       (main answers 500 — the RED run);
 *   (b) a well-formed unknown id     → its existing answer, unchanged;
 *   (c) auth ordering                → unauthenticated 401 and, where the
 *                                       route's permission is withheld from a
 *                                       technician, 403 — never the 404;
 *   (d) tenant grade (T2)            → tenant B has divergent rows (its own
 *                                       customer group, job, file); tenant A
 *                                       naming B's real ids gets the same answer
 *                                       as an unknown id, and B's rows are
 *                                       untouched (read back raw).
 *
 * Auth is the DEV_AUTH_BYPASS unsigned-JWT path used by
 * users-update-tenant-predicate.test.ts: `sub` = the tenant owner id that
 * `createTestTenant` seeds, and the `role` claim selects the RBAC role.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb, createTestTenant, createTestFile } from './shared';
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

async function seedJob(pool: Pool, tenant: { tenantId: string; userId: string }): Promise<string> {
  const customerId = randomUUID();
  const locationId = randomUUID();
  const jobId = randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, $3, $4)`,
    [customerId, tenant.tenantId, 'Malformed-id customer', tenant.userId],
  );
  await pool.query(
    `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
     VALUES ($1, $2, $3, '1 Main St', 'Austin', 'TX', '78701')`,
    [locationId, tenant.tenantId, customerId],
  );
  await pool.query(
    `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by)
     VALUES ($1, $2, $3, $4, $5, 'Malformed-id job', $6)`,
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

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface Case {
  router: string;
  method: Method;
  /** Path with the value under test substituted for exactly one param. */
  path: (value: string) => string;
  body?: Record<string, unknown>;
  message: string;
  /** The answer a well-formed id that names nothing gets today (unchanged by #1110). */
  unknownStatus: number;
  /** True when a technician holds the route's permission (so no 403 leg). */
  technicianAllowed: boolean;
}

describe('#1110 — malformed :id → 404 via notFoundOnMalformedId, at real Postgres', () => {
  let pool: Pool;
  let app: AppWithLifecycle;
  let tenantA: { tenantId: string; userId: string };
  let tenantB: { tenantId: string; userId: string };
  let jobA: string;
  let fileA: string;
  let groupA: string;
  let jobB: string;
  let fileB: string;
  let groupB: string;
  let prevEnv: Record<string, string | undefined>;

  const cases = (): Case[] => {
    const u = () => randomUUID();
    return [
      // attachments
      { router: 'attachments', method: 'post', path: (v) => `/api/attachments/${v}/archive`, body: {}, message: 'Attachment not found', unknownStatus: 404, technicianAllowed: false },
      { router: 'attachments', method: 'post', path: (v) => `/api/attachments/${v}/visibility`, body: { visible: true }, message: 'Attachment not found', unknownStatus: 404, technicianAllowed: false },
      { router: 'attachments', method: 'post', path: (v) => `/api/attachments/${v}/pair`, body: { otherId: u(), role: 'before' }, message: 'Attachment not found', unknownStatus: 404, technicianAllowed: true },
      // bundles
      { router: 'bundles', method: 'get', path: (v) => `/api/bundles/${v}`, message: 'Bundle not found', unknownStatus: 404, technicianAllowed: false },
      { router: 'bundles', method: 'put', path: (v) => `/api/bundles/${v}`, body: { name: 'x' }, message: 'Bundle not found', unknownStatus: 404, technicianAllowed: false },
      // catalog-items
      { router: 'catalog-items', method: 'put', path: (v) => `/api/catalog/items/${v}`, body: { name: 'x' }, message: 'Catalog item not found', unknownStatus: 404, technicianAllowed: false },
      { router: 'catalog-items', method: 'delete', path: (v) => `/api/catalog/items/${v}`, message: 'Catalog item not found', unknownStatus: 404, technicianAllowed: false },
      // customer-custom-fields
      { router: 'customer-custom-fields', method: 'post', path: (v) => `/api/customer-custom-fields/${v}/archive`, body: {}, message: 'Custom field not found', unknownStatus: 404, technicianAllowed: false },
      // customer-groups
      { router: 'customer-groups', method: 'patch', path: (v) => `/api/customer-groups/${v}`, body: { name: 'x' }, message: 'Customer group not found', unknownStatus: 404, technicianAllowed: false },
      { router: 'customer-groups', method: 'post', path: (v) => `/api/customer-groups/${v}/archive`, body: {}, message: 'Customer group not found', unknownStatus: 404, technicianAllowed: false },
      { router: 'customer-groups', method: 'get', path: (v) => `/api/customer-groups/for-customer/${v}`, message: 'Customer not found', unknownStatus: 200, technicianAllowed: true },
      { router: 'customer-groups', method: 'get', path: (v) => `/api/customer-groups/${v}/members`, message: 'Customer group not found', unknownStatus: 200, technicianAllowed: true },
      { router: 'customer-groups', method: 'put', path: (v) => `/api/customer-groups/${v}/members/${u()}`, body: {}, message: 'Customer group not found', unknownStatus: 404, technicianAllowed: false },
      { router: 'customer-groups', method: 'put', path: (v) => `/api/customer-groups/${groupA}/members/${v}`, body: {}, message: 'Customer not found', unknownStatus: 500, technicianAllowed: false },
      { router: 'customer-groups', method: 'delete', path: (v) => `/api/customer-groups/${v}/members/${u()}`, message: 'Customer group not found', unknownStatus: 200, technicianAllowed: false },
      { router: 'customer-groups', method: 'delete', path: (v) => `/api/customer-groups/${groupA}/members/${v}`, message: 'Customer not found', unknownStatus: 200, technicianAllowed: false },
      // files
      { router: 'files', method: 'get', path: (v) => `/api/files/${v}`, message: 'File not found', unknownStatus: 404, technicianAllowed: true },
      { router: 'files', method: 'post', path: (v) => `/api/files/${v}/verify`, body: {}, message: 'File not found', unknownStatus: 404, technicianAllowed: true },
      // financing
      { router: 'financing', method: 'post', path: (v) => `/api/financing/invoices/${v}/offer`, body: {}, message: 'Invoice not found', unknownStatus: 404, technicianAllowed: false },
      { router: 'financing', method: 'get', path: (v) => `/api/financing/invoices/${v}`, message: 'Invoice not found', unknownStatus: 200, technicianAllowed: false },
      { router: 'financing', method: 'get', path: (v) => `/api/financing/${v}`, message: 'Financing application not found', unknownStatus: 404, technicianAllowed: false },
      // job-custom-fields
      { router: 'job-custom-fields', method: 'post', path: (v) => `/api/job-custom-fields/defs/${v}/archive`, body: {}, message: 'Job custom field not found', unknownStatus: 404, technicianAllowed: false },
      { router: 'job-custom-fields', method: 'get', path: (v) => `/api/job-custom-fields/jobs/${v}`, message: 'Job not found', unknownStatus: 200, technicianAllowed: true },
      { router: 'job-custom-fields', method: 'put', path: (v) => `/api/job-custom-fields/jobs/${v}/values/${u()}`, body: { value: 'x' }, message: 'Job not found', unknownStatus: 404, technicianAllowed: true },
      { router: 'job-custom-fields', method: 'put', path: (v) => `/api/job-custom-fields/jobs/${jobA}/values/${v}`, body: { value: 'x' }, message: 'Job custom field not found', unknownStatus: 404, technicianAllowed: true },
      // job-files (only :fileId reaches a uuid column)
      { router: 'job-files', method: 'delete', path: (v) => `/api/jobs/${jobA}/files/${v}`, message: 'Job file not found', unknownStatus: 404, technicianAllowed: true },
      // job-forms
      { router: 'job-forms', method: 'get', path: (v) => `/api/job-forms/templates/${v}`, message: 'Job form template not found', unknownStatus: 404, technicianAllowed: true },
      { router: 'job-forms', method: 'patch', path: (v) => `/api/job-forms/templates/${v}`, body: { name: 'x' }, message: 'Job form template not found', unknownStatus: 404, technicianAllowed: false },
      { router: 'job-forms', method: 'post', path: (v) => `/api/job-forms/templates/${v}/archive`, body: {}, message: 'Job form template not found', unknownStatus: 404, technicianAllowed: false },
      { router: 'job-forms', method: 'get', path: (v) => `/api/job-forms/jobs/${v}/submissions`, message: 'Job not found', unknownStatus: 200, technicianAllowed: true },
      { router: 'job-forms', method: 'post', path: (v) => `/api/job-forms/jobs/${v}/submissions`, body: { templateId: u() }, message: 'Job not found', unknownStatus: 404, technicianAllowed: true },
      { router: 'job-forms', method: 'get', path: (v) => `/api/job-forms/submissions/${v}`, message: 'Job form submission not found', unknownStatus: 404, technicianAllowed: true },
      { router: 'job-forms', method: 'patch', path: (v) => `/api/job-forms/submissions/${v}`, body: { answers: [] }, message: 'Job form submission not found', unknownStatus: 404, technicianAllowed: true },
      // job-photos
      { router: 'job-photos', method: 'post', path: (v) => `/api/jobs/${v}/photos`, body: { fileId: fileA, category: 'before' }, message: 'Job not found', unknownStatus: 500, technicianAllowed: true },
      { router: 'job-photos', method: 'get', path: (v) => `/api/jobs/${v}/photos`, message: 'Job not found', unknownStatus: 200, technicianAllowed: true },
      { router: 'job-photos', method: 'delete', path: (v) => `/api/jobs/${jobA}/photos/${v}`, message: 'Job photo not found', unknownStatus: 404, technicianAllowed: true },
      // marketing
      { router: 'marketing', method: 'post', path: (v) => `/api/marketing/campaigns/${v}/send`, body: {}, message: 'Campaign not found', unknownStatus: 404, technicianAllowed: false },
      // portal
      { router: 'portal', method: 'delete', path: (v) => `/api/portal-sessions/${v}`, message: 'Portal session not found', unknownStatus: 404, technicianAllowed: true },
      // recurring-jobs
      { router: 'recurring-jobs', method: 'get', path: (v) => `/api/recurring-jobs/${v}`, message: 'Recurring job not found', unknownStatus: 404, technicianAllowed: true },
      { router: 'recurring-jobs', method: 'get', path: (v) => `/api/recurring-jobs/${v}/occurrences`, message: 'Recurring job not found', unknownStatus: 404, technicianAllowed: true },
      { router: 'recurring-jobs', method: 'patch', path: (v) => `/api/recurring-jobs/${v}`, body: { title: 'x' }, message: 'Recurring job not found', unknownStatus: 404, technicianAllowed: true },
      { router: 'recurring-jobs', method: 'post', path: (v) => `/api/recurring-jobs/${v}/archive`, body: {}, message: 'Recurring job not found', unknownStatus: 404, technicianAllowed: true },
      { router: 'recurring-jobs', method: 'post', path: (v) => `/api/recurring-jobs/${v}/generate`, body: {}, message: 'Recurring job not found', unknownStatus: 404, technicianAllowed: false },
      // standing-instructions
      { router: 'standing-instructions', method: 'patch', path: (v) => `/api/standing-instructions/${v}/deactivate`, body: {}, message: 'Standing instruction not found', unknownStatus: 404, technicianAllowed: false },
      // templates
      { router: 'templates', method: 'get', path: (v) => `/api/templates/${v}`, message: 'Template not found', unknownStatus: 404, technicianAllowed: false },
      { router: 'templates', method: 'post', path: (v) => `/api/templates/${v}/instantiate`, body: {}, message: 'Template not found', unknownStatus: 404, technicianAllowed: false },
      { router: 'templates', method: 'put', path: (v) => `/api/templates/${v}`, body: { name: 'x' }, message: 'Template not found', unknownStatus: 404, technicianAllowed: false },
      // voice
      { router: 'voice', method: 'get', path: (v) => `/api/voice/recordings/${v}`, message: 'Voice recording not found', unknownStatus: 404, technicianAllowed: true },
      { router: 'voice', method: 'get', path: (v) => `/api/voice/recordings/${v}/audio`, message: 'Voice recording not found', unknownStatus: 404, technicianAllowed: true },
      { router: 'voice', method: 'post', path: (v) => `/api/voice/recordings/${v}/retry`, body: { audioUrl: 'https://example.com/a.wav' }, message: 'Voice recording not found', unknownStatus: 404, technicianAllowed: true },
    ];
  };

  function send(c: Case, value: string, authorization?: string) {
    let r = request(app)[c.method](c.path(value));
    if (authorization) r = r.set('Authorization', authorization);
    return c.body !== undefined ? r.send(c.body) : r;
  }

  // Paths embed fresh uuids for the param NOT under test; normalise them so the
  // got/want labels line up.
  const label = (c: Case) =>
    `${c.method.toUpperCase()} ${c.path(':x').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')}`;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    jobA = await seedJob(pool, tenantA);
    jobB = await seedJob(pool, tenantB);
    fileA = await createTestFile(pool, tenantA.tenantId, tenantA.userId);
    fileB = await createTestFile(pool, tenantB.tenantId, tenantB.userId);

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

    // Customer groups through the product path, one per tenant (divergent names).
    const a = await request(app)
      .post('/api/customer-groups')
      .set('Authorization', bearer(tenantA.userId))
      .send({ name: `A-group-${randomUUID().slice(0, 8)}` });
    expect(a.status).toBe(201);
    groupA = a.body.id;
    const b = await request(app)
      .post('/api/customer-groups')
      .set('Authorization', bearer(tenantB.userId))
      .send({ name: `B-group-${randomUUID().slice(0, 8)}` });
    expect(b.status).toBe(201);
    groupB = b.body.id;
    await waitForRow(pool, 'SELECT 1 FROM customer_groups WHERE id = $1', [groupA]);
    await waitForRow(pool, 'SELECT 1 FROM customer_groups WHERE id = $1', [groupB]);
  });

  afterAll(async () => {
    if (process.env.FIXTURE_DUMP_PATH) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        process.env.FIXTURE_DUMP_PATH,
        JSON.stringify({ tenantA, tenantB, jobA, jobB, fileA, fileB, groupA, groupB }, null, 2),
      );
    }
    await app.gracefulDrain('test-cleanup');
    const { resetConfig } = await import('../../src/shared/config');
    resetConfig();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await closeSharedTestDb();
  });

  // ─────────────────────────── (a) malformed → 404 ───────────────────────────

  it('(a) every converted handler answers a malformed id with its 404 NOT_FOUND envelope — never a 500', async () => {
    const got: string[] = [];
    const want: string[] = [];
    for (const c of cases()) {
      const res = await send(c, 'not-a-uuid', bearer(tenantA.userId));
      got.push(`${label(c)} → ${res.status} ${JSON.stringify(res.body)}`);
      want.push(`${label(c)} → 404 ${JSON.stringify({ error: 'NOT_FOUND', message: c.message })}`);
    }
    // One diff for the whole sweep so a RED run lists every handler's real answer.
    expect(got).toEqual(want);
  });

  // ─────────────────────── (b) well-formed unknown: unchanged ───────────────────────

  it('(b) a well-formed id that names nothing keeps its existing answer on every converted handler', async () => {
    const got: string[] = [];
    const want: string[] = [];
    for (const c of cases()) {
      const res = await send(c, randomUUID(), bearer(tenantA.userId));
      got.push(`${label(c)} → ${res.status}`);
      want.push(`${label(c)} → ${c.unknownStatus}`);
    }
    expect(got).toEqual(want);
  });

  // ───────────────────────────── (c) auth ordering ─────────────────────────────

  it('(c) an unauthenticated caller with a malformed id gets 401 on every converted handler, never the 404', async () => {
    const got: string[] = [];
    for (const c of cases()) {
      const res = await send(c, 'not-a-uuid');
      got.push(`${label(c)} → ${res.status}`);
    }
    expect(got).toEqual(cases().map((c) => `${label(c)} → 401`));
  });

  it('(c) a technician with a malformed id gets 403 (not 404) wherever the route withholds the permission', async () => {
    const gated = cases().filter((c) => !c.technicianAllowed);
    expect(gated.length).toBeGreaterThan(0);
    const got: string[] = [];
    for (const c of gated) {
      const res = await send(c, 'not-a-uuid', bearer(tenantA.userId, 'technician'));
      got.push(`${label(c)} → ${res.status} ${res.body?.error}`);
    }
    expect(got).toEqual(gated.map((c) => `${label(c)} → 403 FORBIDDEN`));
  });

  // ───────────────────────────── (d) tenant grade ─────────────────────────────

  it("(d) tenant A naming tenant B's real ids gets the unknown-id answer, and B's rows are untouched", async () => {
    const before = await pool.query(
      `SELECT g.name, g.is_archived, g.updated_at,
              (SELECT count(*)::int FROM job_form_submissions WHERE job_id = $2) AS submissions,
              (SELECT count(*)::int FROM job_photos WHERE job_id = $2) AS photos
         FROM customer_groups g WHERE g.id = $1`,
      [groupB, jobB],
    );

    const auth = bearer(tenantA.userId);
    const answers = {
      patchGroup: (await request(app).patch(`/api/customer-groups/${groupB}`).set('Authorization', auth).send({ name: 'hijacked' })).status,
      archiveGroup: (await request(app).post(`/api/customer-groups/${groupB}/archive`).set('Authorization', auth).send({})).status,
      groupMembers: (await request(app).get(`/api/customer-groups/${groupB}/members`).set('Authorization', auth)).body,
      readFile: (await request(app).get(`/api/files/${fileB}`).set('Authorization', auth)).status,
      jobPhotos: (await request(app).get(`/api/jobs/${jobB}/photos`).set('Authorization', auth)).body,
      submitForm: (await request(app).post(`/api/job-forms/jobs/${jobB}/submissions`).set('Authorization', auth).send({ templateId: randomUUID() })).status,
    };
    expect(answers).toEqual({
      patchGroup: 404,
      archiveGroup: 404,
      groupMembers: { customerIds: [] },
      readFile: 404,
      jobPhotos: [],
      submitForm: 404,
    });

    const after = await pool.query(
      `SELECT g.name, g.is_archived, g.updated_at,
              (SELECT count(*)::int FROM job_form_submissions WHERE job_id = $2) AS submissions,
              (SELECT count(*)::int FROM job_photos WHERE job_id = $2) AS photos
         FROM customer_groups g WHERE g.id = $1`,
      [groupB, jobB],
    );
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0].name.startsWith('B-group-')).toBe(true);

    // And tenant B's own owner still reads its group — the data is B's, not gone.
    const own = await request(app).get(`/api/customer-groups/${groupB}/members`).set('Authorization', bearer(tenantB.userId));
    expect(own.status).toBe(200);
  });
});
