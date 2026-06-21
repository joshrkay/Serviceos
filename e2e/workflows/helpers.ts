/**
 * Shared helpers for the 50-workflow Playwright suite (e2e/workflows/).
 *
 * Lighter than the QA matrix harness — enough for UI navigation checks and
 * simple API assertions. Matrix-backed workflows delegate to e2e:qa-matrix.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { setupClerkTestingToken, hasClerkTestingCreds } from '../helpers/clerk-testing';
import { mintToken } from '../qa-matrix/fixtures/tokens';

export function apiBase(): string {
  return (process.env.E2E_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

/** SPA renders (Clerk pk locally or deployed E2E_BASE_URL). */
export function hasClerkUi(): boolean {
  return !!process.env.E2E_BASE_URL || !!process.env.VITE_CLERK_PUBLISHABLE_KEY;
}

/** HMAC tokens + seeded tenant A for API-level workflow checks. */
export function hasMatrixEnv(): boolean {
  return !!(
    process.env.E2E_CLERK_HMAC_SECRET &&
    process.env.E2E_TENANT_A_ID &&
    process.env.E2E_TENANT_B_ID &&
    process.env.E2E_TENANT_B_CUSTOMER_ID
  );
}

export function matrixTenantAToken(): string {
  return mintToken(process.env.E2E_TENANT_A_ID!, 'A');
}

export function matrixTenantBToken(): string {
  return mintToken(process.env.E2E_TENANT_B_ID!, 'B');
}

/** Register Clerk testing token before navigating authed routes. */
export async function prepareAuthedPage(page: Page): Promise<void> {
  if (hasClerkTestingCreds()) {
    await setupClerkTestingToken(page).catch(() => undefined);
  }
}

/** Visit a route and assert the SPA shell renders without page errors. */
export async function assertRouteLoads(page: Page, path: string, heading?: RegExp): Promise<void> {
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  if (heading) {
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({
      timeout: 15_000,
    });
  }
  expect(consoleErrors, `console errors on ${path}`).toEqual([]);
}

export async function apiGet(
  request: APIRequestContext,
  path: string,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await request.get(`${apiBase()}${path}`, { headers });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status(), body };
}

export const MANUAL_SKIP =
  'Manual workflow — run staging operator checklist or see docs/superpowers/specs/2026-05-24-platform-assessment-and-e2e-qa-50-workflows.md';

export const MATRIX_SKIP =
  'Matrix-backed workflow — run `npm run e2e:qa-matrix` with Railway dev env (see qa/README.md)';

export const JOURNEY_SKIP =
  'Journey-backed workflow — run the matching spec under e2e/journeys/ with Clerk + test DB';

export const SWEEP_SKIP =
  'Route sweep workflow — run `npm run e2e:coverage-sweep` against a live stack';
