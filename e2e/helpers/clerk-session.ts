/**
 * Signed-in Clerk session helpers for Playwright UI tests.
 *
 * Combines Clerk testing tokens + (optional) password sign-in or fresh
 * +clerk_test signup, then mocks `/api/me` and onboarding status so the
 * authed shell renders without a live Postgres webhook bootstrap.
 *
 * See qa/reports/2026-05-11/clerk-testing-tokens-runbook.md
 */
import { clerk } from '@clerk/testing/playwright';
import { createClerkClient } from '@clerk/backend';
import { expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { setupClerkTestingToken, hasClerkTestingCreds } from './clerk-testing';
import { UI_FLOW_FIXTURE } from '../fixtures/ui-flow-ids';

export const OWNER_AUTH_FILE = 'e2e/fixtures/.auth/owner.json';
const OWNER_CREDS_FILE = 'e2e/fixtures/.auth/owner-creds.json';

export type OwnerCreds = { email: string; password: string };

export function loadOwnerCreds(): OwnerCreds | null {
  if (hasClerkUserPassword()) {
    return { email: clerkTestUserEmail(), password: clerkTestUserPassword() };
  }
  if (!existsSync(OWNER_CREDS_FILE)) return null;
  const parsed = JSON.parse(readFileSync(OWNER_CREDS_FILE, 'utf8')) as Partial<OwnerCreds>;
  if (!parsed.email || !parsed.password) return null;
  return { email: parsed.email, password: parsed.password };
}

export function defaultOwnerEmail(): string {
  return (
    process.env.E2E_CLERK_USER_USERNAME ??
    process.env.E2E_CLERK_USER_EMAIL ??
    `e2e+clerk_test+owner+${Date.now()}@serviceos-test.com`
  );
}

export function hasClerkUserPassword(): boolean {
  return !!(
    (process.env.E2E_CLERK_USER_USERNAME || process.env.E2E_CLERK_USER_EMAIL) &&
    process.env.E2E_CLERK_USER_PASSWORD
  );
}

export function clerkTestUserEmail(): string {
  return loadOwnerCreds()?.email ?? defaultOwnerEmail();
}

export function clerkTestUserPassword(): string {
  return process.env.E2E_CLERK_USER_PASSWORD ?? 'E2ETestPassword!123';
}

function clerkSecretKey(): string {
  return process.env.E2E_CLERK_SECRET_KEY ?? process.env.CLERK_SECRET_KEY ?? '';
}

/** Create (or reuse) a password user via Clerk Backend API — avoids OAuth UI. */
export async function ensureClerkTestUser(
  email: string,
  password: string,
  opts?: { recreate?: boolean },
): Promise<void> {
  const secretKey = clerkSecretKey();
  if (!secretKey) {
    throw new Error('CLERK_SECRET_KEY required to provision E2E users');
  }
  const client = createClerkClient({ secretKey });
  const existing = await client.users.getUserList({ emailAddress: [email] });
  if (existing.data.length > 0 && !opts?.recreate) {
    await client.users.updateUser(existing.data[0].id, {
      password,
      skipPasswordChecks: true,
    });
    return;
  }
  for (const user of existing.data) {
    await client.users.deleteUser(user.id);
  }
  await client.users.createUser({
    emailAddress: [email],
    password,
    skipPasswordChecks: true,
  });
}

/** Mock tenant-scoped API reads the authed shell needs before list pages render. */
export async function installAuthedShellMocks(page: Page): Promise<void> {
  const tenantId = UI_FLOW_FIXTURE.tenantId;

  await page.route('**/api/me', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user_id: 'e2e-owner-user',
          tenant_id: tenantId,
          role: 'owner',
          can_field_serve: true,
          current_mode: 'both',
          mode_changed_at: null,
          permissions: ['*'],
          backup_supervisor_user_id: null,
          unsupervised_proposal_routing: 'queue_and_sms',
          timezone: 'America/Los_Angeles',
        }),
      });
      return;
    }
    if (method === 'POST' && route.request().url().includes('/api/me/mode')) {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.continue();
  });

  await page.route('**/api/onboarding/status', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        steps: [
          { id: 'signup', status: 'done' },
          { id: 'identity', status: 'done' },
          { id: 'pack', status: 'done' },
          { id: 'phone', status: 'done' },
          { id: 'billing', status: 'done' },
          { id: 'test_call', status: 'done' },
        ],
        currentStep: null,
        isComplete: true,
        tenantId,
        subscriptionStatus: null,
      }),
    });
  });

  // List endpoints return empty arrays so pages render their chrome + CTAs.
  await page.route('**/api/estimates**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });
  await page.route('**/api/invoices**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });
  await page.route('**/api/jobs**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });
  await page.route('**/api/leads**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });
}

async function signInExistingOwner(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await clerk.signIn({
    page,
    signInParams: { strategy: 'password', identifier: email, password },
  });
}

export async function signInWithCreds(
  page: Page,
  creds: OwnerCreds,
  opts?: { skipProvision?: boolean },
): Promise<void> {
  await setupClerkTestingToken(page);
  await installAuthedShellMocks(page);
  if (!opts?.skipProvision && !hasClerkUserPassword()) {
    await ensureClerkTestUser(creds.email, creds.password);
  }
  await signInExistingOwner(page, creds.email, creds.password);
  await assertAuthedShell(page);
}

/**
 * Establish a signed-in owner session in the browser.
 * Prefers E2E_CLERK_USER_USERNAME/PASSWORD when set; otherwise provisions a
 * fresh +clerk_test user via the Clerk Backend API and signs in with password.
 */
export async function signInAsOwner(page: Page): Promise<{ email: string; password: string }> {
  if (!hasClerkTestingCreds()) {
    throw new Error('Clerk testing creds missing — set E2E_CLERK_* / CLERK_SECRET_KEY');
  }
  await setupClerkTestingToken(page);
  await installAuthedShellMocks(page);

  const email = hasClerkUserPassword()
    ? (process.env.E2E_CLERK_USER_USERNAME ?? process.env.E2E_CLERK_USER_EMAIL!)
    : (loadOwnerCreds()?.email ?? defaultOwnerEmail());
  const password = clerkTestUserPassword();

  if (!hasClerkUserPassword()) {
    await ensureClerkTestUser(email, password, { recreate: true });
  }
  await signInExistingOwner(page, email, password);

  await assertAuthedShell(page);
  return { email, password };
}

/** Confirms Clerk session landed past /login (browser fetch uses route mocks). */
export async function assertAuthedShell(page: Page): Promise<void> {
  await page.goto('/estimates');
  await page.waitForLoadState('domcontentloaded');
  expect(page.url(), 'expected authenticated shell, not /login').not.toContain('/login');
}

/** Use in specs/tests — re-applies route mocks; relies on setup storageState. */
export async function prepareAuthenticatedPage(page: Page): Promise<void> {
  await installAuthedShellMocks(page);
}
