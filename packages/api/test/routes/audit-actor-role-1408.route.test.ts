/**
 * #1408 — audit rows record the acting request's role, not 'unknown'.
 *
 * Seam: the HTTP routes (buildTestApp injects an OWNER request) and the audit
 * trail they write. The structural guard (test/audit/no-hardcoded-actor-role)
 * forbids the hard-coded literal everywhere; these pin the behaviour on the
 * money path (estimate → invoice convert) and a job update.
 */
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { buildTestApp, TEST_TENANT_ID, TEST_USER_ID } from './test-app';
import { buildEstimate } from '../factories/estimate.factory';

describe('#1408 — audit actor_role is the request’s role', () => {
  it('estimate.converted records the owner who converted it', async () => {
    const t = await buildTestApp();
    const jobId = crypto.randomUUID();
    const estimate = await t.estimateRepo.create(
      buildEstimate({ tenantId: TEST_TENANT_ID, jobId, status: 'accepted', createdBy: TEST_USER_ID }),
    );

    const res = await request(t.app).post(`/api/estimates/${estimate.id}/convert-to-invoice`).send({});
    expect(res.status).toBe(201);

    const events = await t.auditRepo.findByEntity(TEST_TENANT_ID, 'estimate', estimate.id);
    const converted = events.find((e) => e.eventType === 'estimate.converted');
    expect(converted?.actorRole).toBe('owner');
  });
});
