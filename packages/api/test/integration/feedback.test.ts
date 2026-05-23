/**
 * Docker-gated integration tests — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * Covers the feedback repositories against real Postgres + RLS:
 *   - findByToken is intentionally NOT tenant-scoped (public review link flow)
 *   - findByJob IS tenant-scoped (cross-tenant isolation)
 *   - expiresAt round-trips and markSubmitted transitions status
 *   - the unique(request_id) index on feedback_responses rejects a replay
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgFeedbackRequestRepository } from '../../src/feedback/pg-feedback-request';
import { PgFeedbackResponseRepository } from '../../src/feedback/pg-feedback-response';
import { createFeedbackRequest } from '../../src/feedback/feedback-request';
import { createFeedbackResponse } from '../../src/feedback/feedback-response';

/** Insert the customer → location → job FK chain under tenant RLS context. */
async function createJob(pool: Pool, tenant: TestTenant): Promise<string> {
  const customerId = randomUUID();
  const locationId = randomUUID();
  const jobId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant_id = '${tenant.tenantId}'`);
    await client.query(
      `INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, $3, $4)`,
      [customerId, tenant.tenantId, 'Test Customer', tenant.userId],
    );
    await client.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [locationId, tenant.tenantId, customerId, '1 Main St', 'Austin', 'TX', '78701'],
    );
    await client.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [jobId, tenant.tenantId, customerId, locationId, `JOB-${jobId.slice(0, 8)}`, 'Test job', tenant.userId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return jobId;
}

describe('Postgres integration — feedback', () => {
  let pool: Pool;
  let requestRepo: PgFeedbackRequestRepository;
  let responseRepo: PgFeedbackResponseRepository;
  let tenant: TestTenant;
  let other: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    requestRepo = new PgFeedbackRequestRepository(pool);
    responseRepo = new PgFeedbackResponseRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('findByToken resolves WITHOUT a tenant context (public link flow, by design)', async () => {
    const jobId = await createJob(pool, tenant);
    const request = createFeedbackRequest({ tenantId: tenant.tenantId, jobId });
    await requestRepo.create(request);

    // No tenant context is set by findByToken — the token is the credential.
    const found = await requestRepo.findByToken(request.token);
    expect(found?.id).toBe(request.id);
    expect(found?.tenantId).toBe(tenant.tenantId);
  });

  it('findByJob is tenant-scoped — another tenant cannot see the request', async () => {
    const jobId = await createJob(pool, tenant);
    const request = createFeedbackRequest({ tenantId: tenant.tenantId, jobId });
    await requestRepo.create(request);

    expect(await requestRepo.findByJob(tenant.tenantId, jobId)).not.toBeNull();
    expect(await requestRepo.findByJob(other.tenantId, jobId)).toBeNull();
  });

  it('round-trips expiresAt and transitions status via markSubmitted', async () => {
    const jobId = await createJob(pool, tenant);
    const expiresAt = new Date('2026-06-01T00:00:00.000Z');
    const request = createFeedbackRequest({ tenantId: tenant.tenantId, jobId, expiresAt });
    await requestRepo.create(request);

    const before = await requestRepo.findByToken(request.token);
    expect(before?.expiresAt.toISOString()).toBe(expiresAt.toISOString());
    expect(before?.status).toBe('pending');

    await requestRepo.markSubmitted(tenant.tenantId, request.id);
    const after = await requestRepo.findByToken(request.token);
    expect(after?.status).toBe('submitted');
  });

  it('rejects a duplicate response for the same request (unique(request_id) replay guard)', async () => {
    const jobId = await createJob(pool, tenant);
    const request = createFeedbackRequest({ tenantId: tenant.tenantId, jobId });
    await requestRepo.create(request);

    const first = createFeedbackResponse({ tenantId: tenant.tenantId, requestId: request.id, jobId, rating: 5, comment: 'Great' });
    await responseRepo.create(first);
    expect(await responseRepo.findByRequest(tenant.tenantId, request.id)).not.toBeNull();

    const replay = createFeedbackResponse({ tenantId: tenant.tenantId, requestId: request.id, jobId, rating: 1, comment: 'dupe' });
    await expect(responseRepo.create(replay)).rejects.toThrow();
  });
});
