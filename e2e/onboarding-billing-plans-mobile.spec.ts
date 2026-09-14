import { test, expect } from './helpers/offline-app';

// Real SPA layout/selection test, offline Clerk and API fixtures only.
// Stripe charge correctness is covered at the billing service/route boundary.
for (const width of [320, 390]) {
  test(`billing plan selection fits ${width}px and submits only the chosen plan`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const order = ['signup', 'identity', 'pack', 'phone', 'billing', 'verify_ai', 'test_call'];
    await page.route('**/api/onboarding/status', route => route.fulfill({ json: {
      tenantId: '00000000-0000-0000-0000-0000000e2e01',
      currentStep: 'billing', isComplete: false, subscriptionStatus: null,
      steps: order.map((id, i) => ({ id, status: i < 4 ? 'done' : i === 4 ? 'current' : 'pending' })),
    } }));
    await page.route('**/api/onboarding/billing/plans', route => route.fulfill({ json: { plans: [
      { id: 'basic', name: 'Basic', amountCents: 5000, currency: 'usd', interval: 'month' },
      { id: 'enterprise', name: 'Enterprise', amountCents: 15000, currency: 'usd', interval: 'month' },
    ] } }));
    const requests: unknown[] = [];
    await page.route('**/api/onboarding/billing/checkout-session', async route => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ status: 500, json: { message: 'Checkout test failure' } });
    });
    await page.goto('/onboarding');
    const basic = page.getByRole('radio', { name: /basic/i });
    const enterprise = page.getByRole('radio', { name: /enterprise/i });
    await expect(basic).toBeVisible();
    await expect(basic).not.toBeChecked();
    await expect(enterprise).not.toBeChecked();
    const next = page.getByRole('button', { name: /start 14-day free trial/i });
    await expect(next).toBeDisabled();
    for (const radio of [basic, enterprise]) {
      const label = radio.locator('xpath=ancestor::label');
      expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await basic.focus();
    await page.keyboard.press('ArrowRight');
    await expect(enterprise).toBeChecked();
    await next.click();
    await expect.poll(() => requests).toEqual([{ planId: 'enterprise' }]);
    await expect(page.getByRole('alert')).toContainText(/checkout/i);
    await expect(page.getByRole('alert')).not.toContainText('Stripe is temporarily unavailable');
  });
}
