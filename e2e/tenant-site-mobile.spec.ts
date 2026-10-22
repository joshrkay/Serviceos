import { test, expect, skipUnlessAuthedStack, dismissWhatsNewModal } from './helpers/dev-auth';

/**
 * #1768 (D-044) — the hosted tenant site at 320px, and the Settings → Website
 * card that publishes it.
 *
 * The jsdom class contracts live in tenant-site/render.test.ts (API) and
 * WebsiteCard.test.tsx (web); this measures the rendered layout: nothing
 * scrolls sideways, tap-to-call / booking / request links and the chat bubble
 * are ≥44px targets inside the viewport, and the bubble opens the lead form.
 *
 * The site is served by the dev-auth API by Host header
 * (TENANT_SITE_BASE_DOMAIN=sites.e2e.test in playwright.config.ts); Chromium
 * maps *.sites.e2e.test to that API with --host-resolver-rules, so the
 * browser sends the real Host. Seeded over HTTP as the dev owner.
 */

const BASE_DOMAIN = 'sites.e2e.test';
const SLUG = 'e2e-joes-plumbing';

const apiUrl = process.env.E2E_DEVAUTH_API_URL ?? 'http://127.0.0.1:3001';
const apiHostPort = new URL(apiUrl).host;

function ownerToken(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = { sub: process.env.E2E_DEVAUTH_SUB ?? 'dev_owner', role: 'owner', exp: Math.floor(Date.now() / 1000) + 3600 };
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`;
}

async function horizontalOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

// launchOptions cannot be set inside a describe group (it forces a new worker).
test.use({
  launchOptions: {
    args: [`--host-resolver-rules=MAP *.${BASE_DOMAIN} ${apiHostPort}`],
    ...(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {}),
  },
});

test.describe('tenant site — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(devAuthActive, false, 'Runs under the chromium-devauth project (needs the dev-auth API with TENANT_SITE_BASE_DOMAIN)');
  });

  test.use({ viewport: { width: 320, height: 690 } });

  test.beforeEach(async ({ request }) => {
    const headers = { Authorization: `Bearer ${ownerToken()}`, 'Content-Type': 'application/json' };
    const settings = await request.put(`${apiUrl}/api/settings`, {
      headers,
      data: {
        businessName: "Joe's Plumbing and Very Long Named Heating & Air Conditioning Services",
        businessPhone: '+15125550100',
        serviceAreaText: 'Austin, Round Rock, Cedar Park and surrounding Travis County neighborhoods',
      },
    });
    expect(settings.ok()).toBeTruthy();
    const address = await request.put(`${apiUrl}/api/tenant-site/address`, { headers, data: { slug: SLUG } });
    expect(address.ok()).toBeTruthy();
    const publish = await request.post(`${apiUrl}/api/tenant-site/publish`, { headers, data: {} });
    expect(publish.ok()).toBeTruthy();
  });

  test('the published page fits 320px with glove-sized targets, and the bubble opens the lead form', async ({ page }) => {
    await page.goto(`http://${SLUG}.${BASE_DOMAIN}:${new URL(apiUrl).port}/`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText("Joe's Plumbing");

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    const links = page.locator('a.btn, a.chat');
    const count = await links.count();
    expect(count).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < count; i++) {
      const box = await links.nth(i).boundingBox();
      expect(box).not.toBeNull();
      expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
      expect(Math.round(box!.width)).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    }

    await expect(page.locator('a.btn-primary').first()).toHaveAttribute('href', 'tel:+15125550100');
    await expect(page.getByRole('link', { name: 'Book online' })).toHaveAttribute('href', /\/book\?t=/);
    await expect(page.locator('a.chat')).toHaveAttribute('href', /\/intake\?t=/);
  });
});

test.describe('Settings → Website card — mobile layout', () => {
  test.beforeEach(async ({ devAuthActive }) => {
    skipUnlessAuthedStack(devAuthActive, false, 'Runs under the chromium-devauth project');
  });

  test.use({ viewport: { width: 320, height: 690 } });

  test.beforeEach(async ({ request }) => {
    // The about draft needs a business name to draw on.
    const res = await request.put(`${apiUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${ownerToken()}`, 'Content-Type': 'application/json' },
      data: { businessName: "Joe's Plumbing" },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('the card fits 320px with ≥44px fields and buttons', async ({ page }) => {
    await page.goto('/settings?open=website');
    await dismissWhatsNewModal(page);
    const card = page.getByTestId('website-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.scrollIntoViewIfNeeded();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    const controls = card.locator('button, input');
    const count = await controls.count();
    expect(count).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < count; i++) {
      const control = controls.nth(i);
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    }
  });

  test('a drafted about text opens as an editable proposal that fits 320px', async ({ page }) => {
    await page.goto('/settings?open=website');
    await dismissWhatsNewModal(page);
    const about = page.getByTestId('website-about');
    await about.scrollIntoViewIfNeeded();
    await expect(page.getByTestId('website-about-empty').or(page.getByTestId('website-about-current'))).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: /Draft (with AI|a new one)/ }).click();
    const box = page.getByLabel(/Draft \(edit it/);
    await expect(box).toBeVisible({ timeout: 20_000 });
    await expect(box).not.toHaveValue('');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    for (const control of [box, ...(await about.getByRole('button').all())]) {
      await control.scrollIntoViewIfNeeded();
      const rect = await control.boundingBox();
      expect(rect).not.toBeNull();
      expect(Math.round(rect!.height)).toBeGreaterThanOrEqual(44);
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(320);
    }
  });
});
