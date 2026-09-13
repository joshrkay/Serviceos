import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';

/**
 * 2.6 / 2.7 — owner-facing Capabilities client control (#1011 C8, rows 2.6/2.7).
 *
 * `GET/PUT /api/settings/capabilities[/:key]` (PR-2, #1041) is the owner-role
 * write path for the two tenant-ramped flags `dropped_call_recovery`
 * ("Text back callers who hang up") and `voice_vulnerability_triage`
 * ("Extra care for callers in distress"), closed-allowlisted via
 * `capabilityKeySchema` (routes/settings.ts). This spec proves an owner can
 * turn each ON from the real "Capabilities" block in Settings and have it
 * land a `tenant_feature_flags` row through the real API against real
 * Postgres, that a second tenant bootstrapped in the same run still reads
 * disabled (T3 — no cross-tenant bleed), and that the allowlist itself
 * refuses an unlisted key with 400 — reachability + isolation only, no
 * change to what either capability does.
 *
 * Bootstrap pattern mirrors e2e/journeys/signup-to-first-estimate.hermetic.spec.ts,
 * e2e/journeys/digest-toggle.spec.ts and e2e/journeys/revenue-cluster-toggles.spec.ts.
 * Run on the real-Postgres Playwright shape (docs/testing-strategy.md
 * "Real-Postgres Playwright locally"), NOT chromium-devauth or qa-matrix.
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

interface CapabilityState {
  enabled: boolean;
  source: 'tenant' | 'platform' | 'default';
  platformFrozen?: boolean;
}

async function bootstrapOwner(
  page: import('@playwright/test').Page,
  label: string,
): Promise<{ sub: string; jwt: string; authHeaders: Record<string, string>; tenantId: string }> {
  const ownerSub = `user_e2e_cap_${label}_${randomUUID().replace(/-/g, '')}`;
  const ownerEmail = `owner-${label}-${Date.now()}@serviceos-hermetic.test`;
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
      businessName: `Capabilities E2E HVAC (${label})`,
      businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'America/Chicago',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

  return { sub: ownerSub, jwt, authHeaders, tenantId: me.tenant_id! };
}

test.describe('capabilities toggle (2.6/2.7) — real Postgres', () => {
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

  test('an owner turns on both capabilities in Settings; a second tenant (T3) stays untouched; an unlisted key is refused', async ({
    page,
    baseURL,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant A (T1): the owner who flips the switches ─────────────────────
    const ownerA = await bootstrapOwner(page, 'a');

    const beforeA = await page.request.get(`${API_URL}/api/settings/capabilities`, {
      headers: ownerA.authHeaders,
    });
    expect(beforeA.ok(), `GET /api/settings/capabilities -> ${beforeA.status()}`).toBeTruthy();
    const beforeABody = (await beforeA.json()) as Record<string, CapabilityState>;
    expect(beforeABody.dropped_call_recovery?.enabled ?? false).toBe(false);
    expect(beforeABody.voice_vulnerability_triage?.enabled ?? false).toBe(false);

    await installClerkStub(page, { signedIn: true, sub: ownerA.sub, token: ownerA.jwt });
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

    const toggles: Array<[string, string]> = [
      ['Text back callers who hang up', 'dropped_call_recovery'],
      ['Extra care for callers in distress', 'voice_vulnerability_triage'],
    ];

    const droppedCallToggle = page.getByRole('switch', { name: 'Text back callers who hang up' });
    await expect(droppedCallToggle).toBeVisible({ timeout: 15_000 });
    // The Capabilities block sits inside a scrolling content pane below the
    // fold — scroll it into view so the evidence screenshot actually shows
    // the switches, not just the top of the page.
    await droppedCallToggle.scrollIntoViewIfNeeded();

    await page.screenshot({
      path: 'docs/audit/lane-reports/1011-pr3/capabilities-before.png',
      fullPage: true,
    });

    for (const [name, key] of toggles) {
      const toggle = page.getByRole('switch', { name });
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      const putPromise = page.waitForResponse(
        (r) =>
          r.request().method() === 'PUT' &&
          new URL(r.url()).pathname === `/api/settings/capabilities/${key}`,
      );
      await toggle.click();
      const putRes = await putPromise;
      expect(putRes.status(), `PUT /api/settings/capabilities/${key} -> ${putRes.status()}`).toBeLessThan(300);
    }

    // ── Read back through the REAL API after a reload — the durable proof:
    //    a tenant_feature_flags row, not just optimistic client state. The
    //    "after" screenshot is taken post-reload so it reflects the
    //    server-persisted state (not a client render still mid-transition
    //    from the sequential clicks above). ─────────────────────────────────
    await page.reload();
    await expect(droppedCallToggle).toBeVisible({ timeout: 15_000 });
    await expect(droppedCallToggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Extra care for callers in distress' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await droppedCallToggle.scrollIntoViewIfNeeded();

    await page.screenshot({
      path: 'docs/audit/lane-reports/1011-pr3/capabilities-after.png',
      fullPage: true,
    });

    const afterA = await page.request.get(`${API_URL}/api/settings/capabilities`, {
      headers: ownerA.authHeaders,
    });
    expect(afterA.ok()).toBeTruthy();
    const afterABody = (await afterA.json()) as Record<string, CapabilityState>;
    expect(afterABody.dropped_call_recovery).toMatchObject({ enabled: true, source: 'tenant' });
    expect(afterABody.voice_vulnerability_triage).toMatchObject({ enabled: true, source: 'tenant' });

    // ── Tenant B (T3): a second tenant bootstrapped in the SAME run must
    //    still read disabled — proves the write above did not bleed across
    //    tenants. ──────────────────────────────────────────────────────────
    const ownerB = await bootstrapOwner(page, 'b');
    const afterB = await page.request.get(`${API_URL}/api/settings/capabilities`, {
      headers: ownerB.authHeaders,
    });
    expect(afterB.ok()).toBeTruthy();
    const afterBBody = (await afterB.json()) as Record<string, CapabilityState>;
    expect(afterBBody.dropped_call_recovery?.enabled ?? false).toBe(false);
    expect(afterBBody.voice_vulnerability_triage?.enabled ?? false).toBe(false);

    // ── Unlisted-key refusal through the browser's own API client. ─────────
    const unlisted = await page.request.put(`${API_URL}/api/settings/capabilities/supervisor_gate`, {
      headers: { 'content-type': 'application/json', ...ownerA.authHeaders },
      data: JSON.stringify({ enabled: true }),
    });
    expect(unlisted.status()).toBe(400);
    const unlistedBody = (await unlisted.json()) as { error?: string };
    expect(unlistedBody.error).toBe('UNKNOWN_CAPABILITY');

    expect(pageErrors, 'no uncaught page errors while flipping the capability toggles').toEqual([]);
  });
});
