import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 1.2 — onboarding identity, real Postgres, driven through the actual
 * `/onboarding` browser form (not just the API, as digest-toggle.spec.ts
 * and its siblings do to clear the onboarding gate).
 *
 * `test/integration/onboarding-identity.test.ts` already proves, against
 * real Postgres: the upsert, the `tenant.identity_set` audit event, and
 * the `serviceAreaRadius` omit-vs-null tri-state (#874) — all via
 * `request(app).put(...)`, never through a browser. This spec proves the
 * SAME upsert + audit event reachable from a fresh owner typing business
 * details into the real `IdentityStep` form. The web client itself always
 * SENDS `serviceAreaRadius` (packages/web/src/components/onboarding/v2/steps/IdentityStep.tsx
 * never omits the key — `useState<number>` initialized to 25), so the
 * omit-tri-state leg is driven directly against `PUT
 * /api/onboarding/identity` (the same real route the form posts to),
 * exactly like the unit test does but against the live API + Postgres —
 * only an API caller (a raw request, or a future conversational/AI
 * handler) can omit the key at all.
 *
 * Bootstrap pattern mirrors e2e/journeys/digest-toggle.spec.ts.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function unsignedJwt(sub: string): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    sub,
    sid: 'dev-session',
    role: 'owner',
  })}.x`;
}

function signSvix(rawBody: string, svixId: string, svixTimestamp: string): string {
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest('base64');
  return `v1,${sig}`;
}

async function postSignedWebhook(
  request: import('@playwright/test').APIRequestContext,
  body: Record<string, unknown>,
) {
  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(body);
  return request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
  });
}

async function bootstrapOwner(
  page: import('@playwright/test').Page,
  label: string,
): Promise<{ sub: string; jwt: string; authHeaders: Record<string, string>; tenantId: string }> {
  const sub = `user_e2e_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `${label}-${Date.now()}@serviceos-hermetic.test`;
  const jwt = unsignedJwt(sub);
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const webhookRes = await postSignedWebhook(page.request, {
    type: 'user.created',
    data: { id: sub, email_addresses: [{ email_address: email }] },
  });
  expect(webhookRes.status(), `${label} bootstrap webhook -> ${await webhookRes.text()}`).toBe(200);

  const meRes = await page.request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);

  return { sub, jwt, authHeaders, tenantId: me.tenant_id! };
}

function pollDbSnapshot(label: string, sql: string): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;
  try {
    const out = execFileSync('psql', [databaseUrl, '-c', sql], { encoding: 'utf8' });
    writeFileSync(`docs/audit/lane-reports/owner-surfaces-r5/${label}.snapshot.txt`, out);
  } catch (err) {
    writeFileSync(
      `docs/audit/lane-reports/owner-surfaces-r5/${label}.snapshot.txt`,
      `psql poll failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function queryOne<T = Record<string, string>>(sql: string): T | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const out = execFileSync(
    'psql',
    [databaseUrl, '-t', '-A', '-F', '\t', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
  if (!out) return null;
  return out as unknown as T;
}

test.describe('onboarding identity (1.2) — real Postgres', () => {
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

  test('a fresh owner submits /onboarding identity in the browser; it persists to tenant_settings + an audit event; the radius tri-state and T2 hold', async ({
    page,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant B, seeded FIRST with its own distinct identity — the T2
    //    control we check is untouched at the end. ─────────────────────────
    const ownerB = await bootstrapOwner(page, 'ownerb');
    const identityBRes = await page.request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...ownerB.authHeaders },
      data: JSON.stringify({
        businessName: 'Tenant B Untouched HVAC',
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 9900,
        serviceAreaRadius: 99,
        timezone: 'America/Denver',
      }),
    });
    expect(identityBRes.ok()).toBeTruthy();

    // ── Tenant A: a FRESH owner, onboarding not yet started. ────────────────
    const ownerA = await bootstrapOwner(page, 'ownera');

    await installClerkStub(page, { signedIn: true, sub: ownerA.sub, token: ownerA.jwt });
    await blockExternalHosts(page, baseURL!);
    await page.goto('/onboarding');

    const businessNameInput = page.getByLabel('Business name');
    await expect(businessNameInput).toBeVisible({ timeout: 15_000 });
    // IdentityStep pre-loads any existing (webhook-bootstrapped default)
    // settings asynchronously and overwrites the form state when it
    // resolves; wait for that pre-load to finish (the submit button only
    // enables once `loaded` is true) before typing, or a fill() that races
    // ahead of it gets silently clobbered back to the default.
    await expect(page.getByRole('button', { name: /save and continue/i })).toBeEnabled({ timeout: 15_000 });
    await businessNameInput.fill('Onboarding Browser E2E HVAC');

    // The "Hourly rate" Field wraps its Input in a `$ ... /hour` flex div
    // (not the Input directly), so Field's htmlFor/id association lands on
    // that wrapper div, not the input itself — getByLabel can't resolve it.
    // Locate the number input following the "Hourly rate" label instead.
    const hourlyRateInput = page.locator(
      'xpath=//label[contains(., "Hourly rate")]/following-sibling::div[1]//input[@type="number"]',
    );
    await hourlyRateInput.fill('150');

    const radiusInput = page.getByLabel('Service area radius in miles');
    await radiusInput.fill('42');

    await page.screenshot({
      path: 'docs/audit/lane-reports/owner-surfaces-r5/1.2-onboarding-identity-before-submit.png',
      fullPage: true,
    });

    const putPromise = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/onboarding/identity',
    );
    await page.getByRole('button', { name: /save and continue/i }).click();
    const putRes = await putPromise;
    expect(putRes.status(), `PUT /api/onboarding/identity -> ${putRes.status()}`).toBeLessThan(300);

    // ── Poll tenant_settings + audit_events directly from Postgres. ─────────
    pollDbSnapshot(
      '1.2-onboarding-identity-tenant-settings',
      `SELECT tenant_id, business_name, hourly_rate_cents, service_area_radius, timezone ` +
        `FROM tenant_settings WHERE tenant_id IN ('${ownerA.tenantId}','${ownerB.tenantId}') ORDER BY business_name;`,
    );
    pollDbSnapshot(
      '1.2-onboarding-identity-audit-events',
      `SELECT tenant_id, event_type, entity_type, entity_id FROM audit_events ` +
        `WHERE tenant_id = '${ownerA.tenantId}' AND event_type = 'tenant.identity_set';`,
    );

    const settingsAfterSubmit = await page.request.get(`${API_URL}/api/settings`, { headers: ownerA.authHeaders });
    expect(settingsAfterSubmit.ok()).toBeTruthy();
    const settingsBody = (await settingsAfterSubmit.json()) as {
      businessName?: string;
      hourlyRateCents?: number;
      serviceAreaRadius?: number;
    };
    expect(settingsBody.businessName).toBe('Onboarding Browser E2E HVAC');
    expect(settingsBody.hourlyRateCents).toBe(15000);
    expect(settingsBody.serviceAreaRadius).toBe(42);

    const auditRow = queryOne(
      `SELECT count(*) FROM audit_events WHERE tenant_id = '${ownerA.tenantId}' AND event_type = 'tenant.identity_set';`,
    );
    expect(String(auditRow).trim(), 'exactly one tenant.identity_set audit event').toBe('1');

    // ── Resubmit OMITTING serviceAreaRadius — the UI never does this (it
    //    always sends a number), so this leg drives the real route directly,
    //    proving the omit-vs-null tri-state (#874) reachable through the
    //    live API + Postgres, not just the mocked-DB unit test. ─────────────
    const resubmitNoRadius = await page.request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...ownerA.authHeaders },
      data: JSON.stringify({
        businessName: 'Onboarding Browser E2E HVAC',
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 15000,
        timezone: 'America/New_York',
        // serviceAreaRadius omitted entirely — must KEEP the stored 42.
      }),
    });
    expect(resubmitNoRadius.ok(), `resubmit (omit radius) -> ${resubmitNoRadius.status()}`).toBeTruthy();

    const afterOmit = await page.request.get(`${API_URL}/api/settings`, { headers: ownerA.authHeaders });
    const afterOmitBody = (await afterOmit.json()) as { serviceAreaRadius?: number };
    expect(afterOmitBody.serviceAreaRadius, 'omitting serviceAreaRadius must KEEP the stored value').toBe(42);

    // ── T2 — tenant B's identity, seeded before any of tenant A's work,
    //    must be completely untouched by it. ────────────────────────────────
    const settingsB = await page.request.get(`${API_URL}/api/settings`, { headers: ownerB.authHeaders });
    const settingsBBody = (await settingsB.json()) as {
      businessName?: string;
      hourlyRateCents?: number;
      serviceAreaRadius?: number;
    };
    expect(settingsBBody.businessName).toBe('Tenant B Untouched HVAC');
    expect(settingsBBody.hourlyRateCents).toBe(9900);
    expect(settingsBBody.serviceAreaRadius).toBe(99);

    // ── Browser reachability: reload and confirm the onboarding gate has
    //    moved past the identity step onto a CONCRETE next step (not just
    //    "the identity form is gone", which a loading spinner or an error
    //    screen would also satisfy) — a full-page reload re-derives status
    //    from Postgres, not client-side state. `OnboardingShell` derives the
    //    active step from `/api/onboarding/status`'s polled `currentStep`;
    //    after identity that's `pack`, rendering `PackStep`'s "Pick your
    //    trade" heading. ─────────────────────────────────────────────────────
    await page.reload();
    await expect(page.getByLabel('Business name')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Pick your trade' })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({
      path: 'docs/audit/lane-reports/owner-surfaces-r5/1.2-onboarding-identity-after-reload.png',
      fullPage: true,
    });

    expect(pageErrors, 'no uncaught page errors during the onboarding identity journey').toEqual([]);
  });
});
