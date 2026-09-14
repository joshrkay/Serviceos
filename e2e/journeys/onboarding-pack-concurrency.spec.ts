import { test, expect } from '@playwright/test';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import {
  API_URL,
  bootstrapOwner,
  pollDbSnapshot,
  queryOne,
  queryColumn,
} from '../fixtures/onboarding-hermetic-lane';

/**
 * 1.3 — "I want a price book I didn't have to build, so I can quote on day
 * one." Acceptance: picking a pack, when it activates TWICE CONCURRENTLY,
 * seeds exactly once under an advisory lock and the catalog holds the
 * pack's SKUs at the pack's prices.
 *
 * `test/integration/onboarding-pack.test.ts` +
 * `test/integration/onboarding-pack-seed-concurrency.test.ts` already prove
 * this at real Postgres (T1, T3) but only by calling
 * `activatePackWithSeed`/the execution handlers directly — never through
 * the real `POST /api/onboarding/pack` HTTP route a browser click actually
 * posts to, and never via a browser at all. This spec drives ONE real pack
 * pick through the `/onboarding` browser form (proving the persona's own
 * path reaches activation), then fires the SAME real route TWICE
 * CONCURRENTLY (the literal shape of the acceptance criterion — a
 * double-click or a client retry racing the network) for a second tenant,
 * against the real running webServer + real Postgres.
 */

const REPORT_DIR = 'setup-8-1-r5';

test.describe('onboarding pack activation (1.3) — real Postgres, real /api/onboarding/pack route', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true';
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), and E2E_USE_TEST_DB=true with DATABASE_URL ' +
      'pointing at the test container.',
  );

  async function putIdentity(
    request: import('@playwright/test').APIRequestContext,
    authHeaders: Record<string, string>,
    businessName: string,
  ) {
    const res = await request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...authHeaders },
      data: JSON.stringify({
        businessName,
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 12000,
        timezone: 'America/Chicago',
      }),
    });
    expect(res.ok(), `PUT identity (${businessName}) -> ${res.status()}`).toBeTruthy();
  }

  test(
    'a real browser pack pick activates HVAC once; a SEPARATE tenant racing two concurrent ' +
      'POST /api/onboarding/pack calls for the SAME pack seeds exactly once under the advisory ' +
      'lock (no duplicate catalog rows, exactly one pack_activations row); a neighbour on a ' +
      'DIFFERENT pack (T3) and an untouched bystander tenant (T2) are unaffected',
    async ({ page, baseURL }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      // ── Bystander neighbour, seeded first, never touches onboarding
      //    again — the T2 control we check is untouched at the end. ───────
      const bystander = await bootstrapOwner(page, 'packbystander');

      // ── Persona reachability: a real owner picks HVAC through the real
      //    /onboarding browser form (single click, no race). ──────────────
      const browserOwner = await bootstrapOwner(page, 'packbrowser');
      await putIdentity(page.request, browserOwner.authHeaders, 'Browser Pack HVAC');
      await installClerkStub(page, { signedIn: true, sub: browserOwner.sub, token: browserOwner.jwt });
      await blockExternalHosts(page, baseURL!);
      await page.goto('/onboarding');

      await expect(page.getByRole('heading', { name: /pick your trade/i })).toBeVisible({
        timeout: 15_000,
      });
      const packRequest = page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/onboarding/pack',
      );
      await page.locator('button', { has: page.getByText('HVAC', { exact: true }) }).click();
      const packRes = await packRequest;
      expect(packRes.status(), `browser pack pick -> ${packRes.status()}`).toBeLessThan(300);

      pollDbSnapshot(
        REPORT_DIR,
        '1.3-browser-owner-pack-activations',
        `SELECT tenant_id, pack_id, status FROM pack_activations WHERE tenant_id = '${browserOwner.tenantId}';`,
      );
      const browserPackRows = queryOne(
        `SELECT count(*) FROM pack_activations WHERE tenant_id = '${browserOwner.tenantId}' AND pack_id = 'hvac';`,
      );
      expect(String(browserPackRows).trim()).toBe('1');
      const browserAuditRows = queryOne(
        `SELECT count(*) FROM audit_events WHERE tenant_id = '${browserOwner.tenantId}' AND event_type = 'tenant.pack_activated';`,
      );
      expect(String(browserAuditRows).trim(), 'exactly one tenant.pack_activated audit row').toBe('1');

      // ── The race: a SECOND, independent tenant. Two concurrent
      //    POST /api/onboarding/pack calls for the SAME pack, same tenant —
      //    the literal acceptance scenario. ──────────────────────────────
      const raceOwner = await bootstrapOwner(page, 'packrace');
      await putIdentity(page.request, raceOwner.authHeaders, 'Race Pack HVAC');

      const postPack = () =>
        page.request.post(`${API_URL}/api/onboarding/pack`, {
          headers: { 'content-type': 'application/json', ...raceOwner.authHeaders },
          data: JSON.stringify({ packId: 'hvac' }),
        });
      const [raceA, raceB] = await Promise.all([postPack(), postPack()]);

      // Every response is either a successful activation or the advisory
      // lock's own 409 PACK_ACTIVATION_IN_PROGRESS — never a 500 (which
      // would mean the loser's write was NOT cleanly serialized, #1083's
      // symptom).
      for (const res of [raceA, raceB]) {
        expect([200, 409]).toContain(res.status());
        if (res.status() === 409) {
          const body = (await res.json()) as { error?: string };
          expect(body.error).toBe('PACK_ACTIVATION_IN_PROGRESS');
        }
      }

      pollDbSnapshot(
        REPORT_DIR,
        '1.3-race-pack-activations',
        `SELECT tenant_id, pack_id, status, count(*) OVER () AS row_count ` +
          `FROM pack_activations WHERE tenant_id = '${raceOwner.tenantId}';`,
      );
      const racePackRows = queryOne(
        `SELECT count(*) FROM pack_activations WHERE tenant_id = '${raceOwner.tenantId}' AND pack_id = 'hvac';`,
      );
      expect(String(racePackRows).trim(), 'exactly one pack_activations row survives the race').toBe('1');

      // No duplicate catalog items / estimate templates — the actual
      // "seeds exactly once" claim, not merely a single activation row.
      const dupCatalog = queryColumn(
        `SELECT name FROM catalog_items WHERE tenant_id = '${raceOwner.tenantId}' ` +
          `GROUP BY name HAVING count(*) > 1;`,
      );
      expect(dupCatalog, 'no duplicate catalog item names').toEqual([]);
      const dupTemplates = queryColumn(
        `SELECT name FROM estimate_templates WHERE tenant_id = '${raceOwner.tenantId}' ` +
          `GROUP BY name HAVING count(*) > 1;`,
      );
      expect(dupTemplates, 'no duplicate estimate template names').toEqual([]);

      const raceAuditRows = queryOne(
        `SELECT count(*) FROM audit_events WHERE tenant_id = '${raceOwner.tenantId}' AND event_type = 'tenant.pack_activated';`,
      );
      expect(String(raceAuditRows).trim(), 'exactly one tenant.pack_activated audit row after the race').toBe('1');

      // ── T3 — a THIRD tenant on a DIFFERENT pack (plumbing), activated
      //    through the same real route, ends up with its OWN disjoint
      //    catalog — proving per-tenant pack configuration is respected,
      //    not just isolated. ──────────────────────────────────────────────
      const plumbingOwner = await bootstrapOwner(page, 'packplumbing');
      await putIdentity(page.request, plumbingOwner.authHeaders, 'Plumbing Pack Co');
      const plumbingRes = await page.request.post(`${API_URL}/api/onboarding/pack`, {
        headers: { 'content-type': 'application/json', ...plumbingOwner.authHeaders },
        data: JSON.stringify({ packId: 'plumbing' }),
      });
      expect(plumbingRes.ok(), `plumbing pack activation -> ${plumbingRes.status()}`).toBeTruthy();

      const hvacNames = queryColumn(
        `SELECT name FROM catalog_items WHERE tenant_id = '${raceOwner.tenantId}' ORDER BY name;`,
      );
      const plumbingNames = queryColumn(
        `SELECT name FROM catalog_items WHERE tenant_id = '${plumbingOwner.tenantId}' ORDER BY name;`,
      );
      expect(hvacNames.length, 'HVAC tenant got a non-empty catalog').toBeGreaterThan(0);
      expect(plumbingNames.length, 'plumbing tenant got a non-empty catalog').toBeGreaterThan(0);
      const overlap = hvacNames.filter((n) => plumbingNames.includes(n));
      expect(overlap, 'the two tenants\' catalogs share no line items (T3)').toEqual([]);

      pollDbSnapshot(
        REPORT_DIR,
        '1.3-T3-catalog-disjoint',
        `SELECT tenant_id, pack_id, count(*) FROM catalog_items c ` +
          `JOIN pack_activations p USING (tenant_id) ` +
          `WHERE c.tenant_id IN ('${raceOwner.tenantId}','${plumbingOwner.tenantId}') ` +
          `GROUP BY tenant_id, pack_id;`,
      );

      // ── T2 — the bystander tenant, seeded before all of the above and
      //    never touched again, has NO pack activation at all. ───────────
      const bystanderPackRows = queryOne(
        `SELECT count(*) FROM pack_activations WHERE tenant_id = '${bystander.tenantId}';`,
      );
      expect(String(bystanderPackRows).trim(), 'bystander has no pack activation').toBe('0');
      const bystanderCatalog = queryOne(
        `SELECT count(*) FROM catalog_items WHERE tenant_id = '${bystander.tenantId}';`,
      );
      expect(String(bystanderCatalog).trim(), 'bystander has no catalog items').toBe('0');

      expect(pageErrors, 'no uncaught page errors during the browser pack pick').toEqual([]);
    },
  );
});
