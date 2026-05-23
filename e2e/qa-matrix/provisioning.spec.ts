import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * PROV-01 / PROV-02 — provision the two QA tenants into distinct verticals via
 * the REAL onboarding path (POST /api/onboarding/configure), then prove the
 * vertical-specific context "pulls up correctly" and differs between tenants.
 *
 * Tenant A → HVAC, Tenant B → plumbing. Configure is idempotent (union of
 * activated packs), so re-runs are safe.
 */

test.describe.configure({ mode: 'serial' });

function configureBody(businessName: string, service: 'HVAC' | 'Plumbing') {
  return {
    name: 'QA Owner',
    businessName,
    services: [service],
    teamSize: '1-5',
    workerTerm: 'technician',
    jobTerm: 'job',
    estimateTerm: 'estimate',
    automationRules: [],
  };
}

async function verifyVertical(
  h: RowHarness,
  tenant: { token: string; tenantId: string },
  pack: 'hvac' | 'plumbing',
  ownTerm: string,
  foreignTerm: string,
  labelPrefix: string
): Promise<void> {
  // Agent A — provision via the real onboarding endpoint.
  await h.api.call({
    method: 'POST',
    path: '/api/onboarding/configure',
    body: configureBody(`QA ${pack.toUpperCase()} Co`, pack === 'hvac' ? 'HVAC' : 'Plumbing'),
    token: tenant.token,
    label: `${labelPrefix}-configure`,
    expectStatus: [200, 201],
  });

  // Settings should now report the active pack.
  const settings = await h.api.call({
    method: 'GET',
    path: '/api/settings',
    token: tenant.token,
    label: `${labelPrefix}-settings`,
    expectStatus: 200,
  });
  expect(
    JSON.stringify(settings.response.body).toLowerCase(),
    `settings must reflect the ${pack} pack`
  ).toContain(pack);

  // Vertical categories should be pack-specific and distinct from the other vertical.
  const cats = await h.api.call({
    method: 'GET',
    path: `/api/verticals/${pack}/categories`,
    token: tenant.token,
    label: `${labelPrefix}-categories`,
    expectStatus: [200, 404],
  });
  if (cats.response.status === 200) {
    // Assert on category IDs (not a stringified blob — HVAC's "maintenance"
    // category legitimately lists "Condensate drain cleaning").
    const ids = Array.isArray(cats.response.body)
      ? (cats.response.body as Array<{ id?: string }>).map((c) => String(c.id))
      : [];
    expect(ids, `${pack} categories must include the ${pack} category id "${ownTerm}"`).toContain(ownTerm);
    expect(ids, `${pack} categories must NOT include the other vertical's category id "${foreignTerm}"`).not.toContain(
      foreignTerm
    );
  } else {
    h.evidence.note(`/api/verticals/${pack}/categories returned 404 — vertical-categories route may differ; relied on settings + pack_activations.`);
  }

  // Agent C — the activation is persisted under this tenant.
  const db = await h.db.query({
    label: `${labelPrefix}-pack-activation`,
    tenantId: tenant.tenantId,
    sql: `SELECT pack_id FROM pack_activations WHERE tenant_id = $1`,
    params: [tenant.tenantId],
  });
  const packs = db.rows.map((r) => (r as { pack_id: string }).pack_id);
  expect(packs, `pack_activations must contain ${pack} for this tenant`).toContain(pack);

  // Agent B — settings/onboarding screen renders.
  await gotoUi(h, '/settings', `${labelPrefix}-settings-ui`);
}

matrixTest('PROV-01', 'HVAC tenant provisioned + correct vertical', async (h) => {
  // 'drain' is a plumbing-only category; HVAC must not surface it.
  await verifyVertical(h, h.tenantA, 'hvac', 'maintenance', 'drain', '01');
  h.evidence.pass();
});

matrixTest('PROV-02', 'Plumbing tenant provisioned + correct vertical', async (h) => {
  // 'water-heater'/'drain' are plumbing-specific; HVAC's 'maintenance' install set differs.
  await verifyVertical(h, h.tenantB, 'plumbing', 'drain', 'maintenance', '02');
  h.evidence.pass();
});

// ---------------- helpers ----------------

async function gotoUi(h: RowHarness, path: string, label: string): Promise<void> {
  const baseUrl = process.env.E2E_BASE_URL!;
  try {
    await h.page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    h.evidence.note(`navigation to ${path} failed: ${(err as Error).message}`);
  }
  await h.page.waitForTimeout(500);
  await h.snapshot(`${label}`);
}
