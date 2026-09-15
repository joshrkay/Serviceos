import { test, expect, type Page } from '@playwright/test';
import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright';
import { randomUUID } from 'node:crypto';
import { submitClerkEmailForm, enterClerkTestCode } from '../helpers/clerk-email-form';

// Real Clerk + deployed Development API. No auth bypass, synthetic webhook,
// database seed, provider purchase, invoice send or payment submission.
async function token(page: Page): Promise<string> {
  await expect.poll(() => page.evaluate(() => {
    const auth = (window as unknown as { Clerk?: { loaded?: boolean; session?: unknown } }).Clerk;
    return Boolean(auth?.loaded && auth.session);
  }), { timeout: 30000, message: 'Clerk must restore the authenticated session after navigation' }).toBe(true);
  const value = await page.evaluate(async () => {
    const auth = (window as unknown as { Clerk?: { session?: { getToken(options: { template: string; skipCache: boolean }): Promise<string | null> } } }).Clerk;
    return await auth?.session?.getToken({ template: 'serviceos', skipCache: true });
  });
  expect(value, 'a real Clerk session must exist').toBeTruthy();
  return value!;
}
async function api(page: Page, method: string, path: string, data?: unknown) {
  const response = await page.request.fetch(path, {
    method, headers: { Authorization: `Bearer ${await token(page)}` }, data,
  });
  expect(response.ok(), `${method} ${path} returned ${response.status()}`).toBeTruthy();
  return response.json();
}

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  // Diagnostic structure only: no input values, emails, tokens or passwords.
  const form = await page.locator('input').evaluateAll(inputs => inputs.map(input => ({
    name: input.getAttribute('name'), type: input.getAttribute('type'),
    label: input.getAttribute('aria-label'), autocomplete: input.getAttribute('autocomplete'),
  })));
  const signup = await page.evaluate(() => {
    const signup = (window as unknown as { Clerk?: { client?: { signUp?: {
      status?: string; missingFields?: string[]; unverifiedFields?: string[];
    } } } }).Clerk?.client?.signUp;
    return signup && { status: signup.status, missingFields: signup.missingFields, unverifiedFields: signup.unverifiedFields };
  });
  console.log('[release-signup-diagnostic]', JSON.stringify({ path: new URL(page.url()).pathname, form, signup }));
});

test('real signup -> tenant -> identity -> first draft estimate -> returning login', async ({ page }) => {
  const email = `rivet-release-${randomUUID()}+clerk_test@example.com`;
  const password = `RivetQA!${randomUUID()}`;
  await setupClerkTestingToken({ page });
  await page.goto('/signup');
  await page.getByLabel(/email/i).first().fill(email);
  await page.getByLabel(/password/i).first().fill(password);
  await submitClerkEmailForm(page);
  const code = page.getByRole('textbox', { name: /code|verification/i }).first();
  // Wait for the actual auth state; route changes can precede Clerk's form.
  await expect.poll(async () => {
    if (await code.isVisible()) return 'code';
    return page.evaluate(() => (
      (window as unknown as { Clerk?: { session?: unknown } }).Clerk?.session ? 'session' : 'waiting'
    ));
  }, { timeout: 30000 }).not.toBe('waiting');
  if (await code.isVisible()) await enterClerkTestCode(page);
  await expect.poll(async () => page.evaluate(() => Boolean(
    (window as unknown as { Clerk?: { session?: unknown } }).Clerk?.session
  )), { timeout: 30000 }).toBe(true);

  let tenantId = '';
  await expect.poll(async () => {
    const response = await page.request.get('/api/me', { headers: { Authorization: `Bearer ${await token(page)}` } });
    if (!response.ok()) return '';
    tenantId = (await response.json()).tenant_id;
    return tenantId;
  }, { timeout: 30000 }).toMatch(/^[0-9a-f-]{36}$/i);

  await api(page, 'PUT', '/api/onboarding/identity', {
    businessName: `Rivet Release QA ${Date.now()}`,
    businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
    jobBufferMinutes: 30, hourlyRateCents: 12500, timezone: 'America/Phoenix',
  });
  const status = await api(page, 'GET', '/api/onboarding/status');
  expect(status.steps.find((step: { id: string }) => step.id === 'identity')?.status).toBe('done');
  const customer = await api(page, 'POST', '/api/customers', { firstName: 'Release', lastName: 'QA', email, smsConsent: false });
  const location = await api(page, 'POST', '/api/locations', {
    customerId: customer.id, label: 'QA fixture', street1: '123 Test Street', city: 'Phoenix', state: 'AZ', postalCode: '85001', isPrimary: true,
  });
  const job = await api(page, 'POST', '/api/jobs', {
    customerId: customer.id, locationId: location.id, summary: 'Release verification fixture — do not dispatch', priority: 'normal',
  });
  const estimate = await api(page, 'POST', '/api/estimates', {
    jobId: job.id,
    lineItems: [{ id: 'qa-labor', description: 'QA diagnostic fixture', category: 'labor', quantity: 1, unitPriceCents: 12900, totalCents: 12900, sortOrder: 0, taxable: false }],
    discountCents: 0, taxRateBps: 0,
  });
  expect(estimate.status).toBe('draft');
  await page.goto('/estimates');
  await expect(page.getByText(estimate.estimateNumber, { exact: true }).first()).toBeVisible();
  await page.reload();
  expect((await api(page, 'GET', '/api/me')).tenant_id).toBe(tenantId);

  await clerk.signOut({ page });
  await page.goto('/login');
  await clerk.signIn({ page, signInParams: { strategy: 'password', identifier: email, password } });
  expect((await api(page, 'GET', '/api/me')).tenant_id).toBe(tenantId);
  await page.goto('/estimates');
  await expect(page.getByText(estimate.estimateNumber, { exact: true }).first()).toBeVisible();
});
