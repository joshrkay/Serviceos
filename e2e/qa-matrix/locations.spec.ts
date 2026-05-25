import { expect, matrixTest, test } from './helpers/matrix-test';

/**
 * LOC-01 — service location lifecycle on the seeded customer:
 *          create → read → update → archive, verified via API and the
 *          service_locations table.
 */

test.describe.configure({ mode: 'serial' });

matrixTest('LOC-01', 'Service location lifecycle', async (h) => {
  const { token, tenantId, customerId } = h.tenantA;

  const created = await h.api.call({
    method: 'POST',
    path: '/api/locations',
    body: {
      customerId,
      label: 'QA Site',
      street1: '500 Industrial Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      accessNotes: 'Gate code 1234',
    },
    token,
    label: '01-create',
    expectStatus: 201,
  });
  const locationId = (created.response.body as { id: string }).id;
  expect(locationId, 'location create must return an id').toBeTruthy();

  const fetched = await h.api.call({
    method: 'GET',
    path: `/api/locations/${locationId}`,
    token,
    label: '01-get',
    expectStatus: 200,
  });
  expect((fetched.response.body as { city: string }).city, 'fetched location must echo the city').toBe('Austin');

  await h.api.call({
    method: 'PUT',
    path: `/api/locations/${locationId}`,
    body: { accessNotes: 'Gate code 9999 (updated)' },
    token,
    label: '01-update',
    expectStatus: 200,
  });
  const updated = await h.db.query({
    label: '01-updated-row',
    tenantId,
    sql: `SELECT access_notes FROM service_locations WHERE id = $1`,
    params: [locationId],
  });
  expect((updated.rows[0] as { access_notes: string }).access_notes, 'update must persist').toBe('Gate code 9999 (updated)');

  await h.api.call({
    method: 'POST',
    path: `/api/locations/${locationId}/archive`,
    token,
    label: '01-archive',
    expectStatus: 200,
  });
  const archived = await h.db.query({
    label: '01-archived-row',
    tenantId,
    sql: `SELECT is_archived FROM service_locations WHERE id = $1`,
    params: [locationId],
  });
  expect((archived.rows[0] as { is_archived: boolean }).is_archived, 'archive must set is_archived=true').toBe(true);

  h.evidence.pass();
});
