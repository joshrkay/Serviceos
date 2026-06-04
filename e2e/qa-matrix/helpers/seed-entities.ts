import type { RowHarness } from './matrix-test';

/**
 * QA-2026-06-04 (JRN-02 / EST-05): seed a FRESH customer→location→job chain
 * for rows that accept estimates. The product enforces one accepted estimate
 * per job (partial unique index uq_estimates_accepted_per_job), so any row
 * that drives an estimate to 'accepted' must own its job — sharing the
 * seeded fixture job makes rows collide with each other and with prior runs.
 */
export interface SeededJob {
  customerId: string;
  locationId: string;
  jobId: string;
}

export async function seedFreshJob(
  h: RowHarness,
  label: string,
  tenant: { token: string } = h.tenantA
): Promise<SeededJob> {
  const { token } = tenant;
  const stamp = Date.now();
  const customer = await h.api.call({
    method: 'POST',
    path: '/api/customers',
    body: {
      firstName: 'QA',
      lastName: `${label}-${stamp}`,
      primaryPhone: `+1555${String(stamp).slice(-7)}`,
    },
    token,
    label: `${label}-customer`,
    expectStatus: 201,
  });
  const customerId = (customer.response.body as { id: string }).id;

  const location = await h.api.call({
    method: 'POST',
    path: '/api/locations',
    body: { customerId, street1: '1 QA Way', city: 'Testville', state: 'CA', postalCode: '90001' },
    token,
    label: `${label}-location`,
    expectStatus: 201,
  });
  const locationId = (location.response.body as { id: string }).id;

  const job = await h.api.call({
    method: 'POST',
    path: '/api/jobs',
    body: { customerId, locationId, summary: `QA ${label} job`, priority: 'normal' },
    token,
    label: `${label}-job`,
    expectStatus: 201,
  });
  return { customerId, locationId, jobId: (job.response.body as { id: string }).id };
}
