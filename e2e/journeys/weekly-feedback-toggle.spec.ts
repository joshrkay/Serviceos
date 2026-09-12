import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 9.7 — Weekly summary email client control (#1011 C8, row 9.7).
 *
 * `weeklyFeedbackEnabled` is one of the five owner-toggle keys PR-1 (#1038)
 * added to `updateSettingsSchema`/PUT /api/settings; the row's own gap was the
 * "unlit-able" claim ("a tenant cannot turn OFF a recurring email"). This
 * spec proves an owner can flip the "Weekly summary email" toggle in Settings
 * › Quick settings OFF and have it durably persist through the real API
 * against real Postgres — reachability only, no change to what the weekly
 * digest sends.
 *
 * Bootstrap pattern mirrors e2e/journeys/signup-to-first-estimate.hermetic.spec.ts
 * and e2e/journeys/digest-toggle.spec.ts. Run on the real-Postgres Playwright
 * shape (docs/testing-strategy.md "Real-Postgres Playwright locally"), NOT
 * chromium-devauth, which forces in-memory repositories.
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

test.describe('weekly summary email toggle (9.7) — real Postgres', () => {
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

  test('an owner flips Weekly summary email OFF in Settings and it persists through PUT /api/settings', async ({
    page,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Bootstrap the owner's tenant (hermetic webhook, DEV_AUTH_BYPASS) ────
    const ownerSub = `user_e2e_weeklyfb_${randomUUID().replace(/-/g, '')}`;
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

    // Clear the onboarding soft gate.
    const identityRes = await page.request.put(`${API_URL}/api/onboarding/identity`, {
      headers: { 'content-type': 'application/json', ...authHeaders },
      data: JSON.stringify({
        businessName: 'Weekly Feedback E2E HVAC',
        businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
        jobBufferMinutes: 30,
        hourlyRateCents: 12500,
        timezone: 'America/Chicago',
      }),
    });
    expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

    // Sanity: weeklyFeedbackEnabled defaults to TRUE (recurring, opt-out) —
    // pg-settings.ts:213 `?? true`. The row's whole point is a tenant cannot
    // turn this OFF today.
    const before = await page.request.get(`${API_URL}/api/settings`, { headers: authHeaders });
    expect(before.ok()).toBeTruthy();
    const beforeBody = (await before.json()) as { weeklyFeedbackEnabled?: boolean };
    expect(beforeBody.weeklyFeedbackEnabled ?? true).toBe(true);

    // ── Bind the browser session to this real tenant owner ─────────────────
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
    const toggle = page.locator(
      'xpath=//p[normalize-space(text())="Weekly summary email"]/ancestor::div[contains(@class,"justify-between")][1]//button',
    );
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await toggle.scrollIntoViewIfNeeded();

    await page.screenshot({
      path: 'docs/audit/lane-reports/1011-pr3/weekly-feedback-before.png',
      fullPage: true,
    });

    const putPromise = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/settings',
    );
    await toggle.click();
    const putRes = await putPromise;
    expect(putRes.status(), `PUT /api/settings -> ${putRes.status()}`).toBeLessThan(300);

    // ── Read back through the REAL API after a reload — the durable proof,
    //    not just the optimistic client-side toggle state. The "after"
    //    screenshot is taken post-reload (not right after the click) so it
    //    shows the settled, server-persisted render rather than a frame
    //    mid-CSS-transition. ───────────────────────────────────────────────
    await page.reload();
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await toggle.scrollIntoViewIfNeeded();

    await page.screenshot({
      path: 'docs/audit/lane-reports/1011-pr3/weekly-feedback-after.png',
      fullPage: true,
    });

    const after = await page.request.get(`${API_URL}/api/settings`, { headers: authHeaders });
    expect(after.ok()).toBeTruthy();
    const afterBody = (await after.json()) as { weeklyFeedbackEnabled?: boolean };
    expect(afterBody.weeklyFeedbackEnabled).toBe(false);

    expect(pageErrors, 'no uncaught page errors while flipping the weekly-feedback toggle').toEqual([]);
  });
});
