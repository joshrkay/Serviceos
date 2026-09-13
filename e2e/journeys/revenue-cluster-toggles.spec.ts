import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 8.3 / 8.11 — revenue-cluster settings client controls.
 *
 * `autoInvoiceOnCompletion`, `billLaborFromTimeEntries`, `batchInvoiceEnabled`,
 * and `milestoneBillingEnabled` were already accepted by PUT /api/settings
 * and referenced by zero UI files. This spec proves an owner can flip all
 * four in the real "Payments & billing" Settings section and have them
 * durably persist through the real API against real Postgres — UI +
 * persistence only, no change to what any of the four flags do.
 *
 * Bootstrap pattern mirrors e2e/journeys/signup-to-first-estimate.hermetic.spec.ts
 * and e2e/journeys/digest-toggle.spec.ts.
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

const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

test.describe('revenue-cluster toggles (8.3/8.11) — real Postgres', () => {
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

  test('an owner flips all four revenue-cluster toggles in Settings and they persist through PUT /api/settings', async ({
    page,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const ownerSub = `user_e2e_revcluster_${randomUUID().replace(/-/g, '')}`;
    const ownerEmail = `owner-${Date.now()}@serviceos-hermetic.test`;
    const jwt = unsignedJwt(ownerSub);
    const authHeaders = { Authorization: `Bearer ${jwt}` };

    const svixId = `evt_${randomUUID()}`;
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      type: 'user.created',
      data: { id: ownerSub, email_addresses: [{ email_address: ownerEmail }] },
    });
    const webhookRes = await page.request.post(`${API_URL}/webhooks/clerk`, {
      headers: {
        'content-type': 'application/json',
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
      },
      data: rawBody,
    });
    expect(webhookRes.status(), `webhook rejected: ${await webhookRes.text()}`).toBe(200);

    const meRes = await page.request.get(`${API_URL}/api/me`, { headers: authHeaders });
    expect(meRes.status()).toBe(200);
    const me = (await meRes.json()) as { tenant_id?: string };
    expect(me.tenant_id).toMatch(UUID_RE);

    const identityRes = await page.request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...authHeaders },
      data: JSON.stringify({
        businessName: 'Revenue Cluster E2E HVAC',
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 12500,
        timezone: 'America/Chicago',
      }),
    });
    expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

    // Sanity: all four default to false/unset for a fresh tenant.
    const before = await page.request.get(`${API_URL}/api/settings`, { headers: authHeaders });
    expect(before.ok()).toBeTruthy();
    const beforeBody = (await before.json()) as Record<string, unknown>;
    expect(beforeBody.autoInvoiceOnCompletion ?? false).toBe(false);
    expect(beforeBody.billLaborFromTimeEntries ?? false).toBe(false);
    expect(beforeBody.batchInvoiceEnabled ?? false).toBe(false);
    expect(beforeBody.milestoneBillingEnabled ?? false).toBe(false);

    await installClerkStub(page, { signedIn: true, sub: ownerSub, token: jwt });
    await page.addInitScript(
      ({ welcomeKey, whatsNewKey }) => {
        try {
          localStorage.setItem(welcomeKey, '1');
          localStorage.setItem(whatsNewKey, '2026-06-21-onboarding');
        } catch {
          /* private mode — ignore */
        }
      },
      { welcomeKey: WELCOME_SEEN_KEY, whatsNewKey: WHATS_NEW_SEEN_KEY },
    );
    await blockExternalHosts(page, baseURL!);

    await page.goto('/settings');

    const rows: Array<[string, string]> = [
      ['Auto-draft invoice on completion', 'autoInvoiceOnCompletion'],
      ['Bill labor from time entries', 'billLaborFromTimeEntries'],
      ['Daily batch invoicing', 'batchInvoiceEnabled'],
      ['Milestone billing', 'milestoneBillingEnabled'],
    ];

    for (const [name] of rows) {
      const toggle = page.getByRole('switch', { name });
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      const putPromise = page.waitForResponse(
        (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/settings',
      );
      await toggle.click();
      const putRes = await putPromise;
      expect(putRes.status(), `PUT /api/settings (${name}) -> ${putRes.status()}`).toBeLessThan(300);
    }

    // ── Read back through the REAL API — the durable proof. ────────────────
    const after = await page.request.get(`${API_URL}/api/settings`, { headers: authHeaders });
    expect(after.ok()).toBeTruthy();
    const afterBody = (await after.json()) as Record<string, unknown>;
    expect(afterBody.autoInvoiceOnCompletion).toBe(true);
    expect(afterBody.billLaborFromTimeEntries).toBe(true);
    expect(afterBody.batchInvoiceEnabled).toBe(true);
    expect(afterBody.milestoneBillingEnabled).toBe(true);

    expect(pageErrors, 'no uncaught page errors while flipping the revenue-cluster toggles').toEqual([]);
  });
});
