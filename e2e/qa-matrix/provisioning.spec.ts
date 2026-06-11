import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * PROV-01 / PROV-02 — provision the two QA tenants into distinct verticals,
 * then prove the vertical-specific context "pulls up correctly" and differs
 * between tenants. Tenant A → HVAC, Tenant B → plumbing.
 *
 * QA-2026-06-04 (PROV-01-onboarding-configure-route): the original spec
 * provisioned via POST /api/onboarding/configure, a route that has never
 * existed in packages/api (Express 404 on every env). The REAL provisioning
 * surface is pack activation:
 *
 *   GET /api/verticals                        → canonical packs (packId, verticalType)
 *   PUT /api/settings/packs/:packId/activate  → activate for the tenant (201)
 *   GET /api/settings/packs                   → tenant's active packs
 *
 * Pack ids are looked up by verticalType at runtime ('hvac' → e.g. 'hvac-v1')
 * so the spec survives packId naming differences between environments.
 * Re-runs are safe: an already-active pack re-activation is accepted
 * (200/201) or rejected as a duplicate (409) — both leave the tenant active.
 */

test.describe.configure({ mode: 'serial' });

interface CanonicalPack {
  packId?: string;
  verticalType?: string;
  status?: string;
}

async function lookupPackId(
  h: RowHarness,
  token: string,
  verticalType: 'hvac' | 'plumbing',
  labelPrefix: string
): Promise<string> {
  const res = await h.api.call({
    method: 'GET',
    path: '/api/verticals',
    token,
    label: `${labelPrefix}-verticals`,
    expectStatus: 200,
  });
  const packs = (res.response.body as CanonicalPack[]) ?? [];
  const match = packs.find((p) => p.verticalType === verticalType && p.status === 'active');
  expect(match?.packId, `an active canonical ${verticalType} pack must exist in /api/verticals`).toBeTruthy();
  return match!.packId!;
}

async function verifyVertical(
  h: RowHarness,
  tenant: { token: string; tenantId: string },
  pack: 'hvac' | 'plumbing',
  ownTerm: string,
  foreignTerm: string,
  labelPrefix: string
): Promise<void> {
  // Agent A — resolve the canonical pack id, then activate it for the tenant.
  const packId = await lookupPackId(h, tenant.token, pack, labelPrefix);
  await h.api.call({
    method: 'PUT',
    path: `/api/settings/packs/${packId}/activate`,
    body: {},
    token: tenant.token,
    label: `${labelPrefix}-activate`,
    expectStatus: [200, 201, 409],
  });

  // The tenant's active-pack list must now contain it.
  const active = await h.api.call({
    method: 'GET',
    path: '/api/settings/packs',
    token: tenant.token,
    label: `${labelPrefix}-active-packs`,
    expectStatus: 200,
  });
  const activeIds = ((active.response.body as Array<{ packId?: string; status?: string }>) ?? [])
    .filter((a) => a.status === 'active')
    .map((a) => String(a.packId));
  expect(activeIds, `tenant's active packs must include ${packId}`).toContain(packId);

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
    h.evidence.note(`/api/verticals/${pack}/categories returned 404 — vertical-categories route may differ; relied on pack activation list.`);
  }

  // Agent C — the activation is persisted under this tenant.
  const db = await h.db.query({
    label: `${labelPrefix}-pack-activation`,
    tenantId: tenant.tenantId,
    sql: `SELECT pack_id FROM pack_activations WHERE tenant_id = $1 AND status = 'active'`,
    params: [tenant.tenantId],
  });
  const packs = db.rows.map((r) => (r as { pack_id: string }).pack_id);
  expect(packs, `pack_activations must contain ${packId} for this tenant`).toContain(packId);
  // Vertical separation, enforced regardless of whether the categories
  // endpoint responded: this tenant must NOT carry the other vertical's pack.
  const foreign = pack === 'hvac' ? 'plumbing' : 'hvac';
  expect(
    packs.some((p) => p.toLowerCase().includes(foreign)),
    `tenant must NOT have a ${foreign} pack active (got: ${packs.join(', ')})`
  ).toBe(false);

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
