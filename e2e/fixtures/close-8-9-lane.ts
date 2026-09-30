/**
 * Shared helpers for the §8.9 Close rung-5 reachability specs (#1013):
 * thank-you SMS (9.1), review request (9.2), weekly summary (9.7) and the
 * correction-lesson undo (9.8 / 9.9). The bootstrap/signing idioms are the
 * ones every hermetic journey in this suite uses (see
 * e2e/journeys/digest-toggle.spec.ts's header): a real Clerk-webhook
 * provisioning, a real onboarding identity, and an owner browser session
 * bound to that SAME tenant through e2e/helpers/clerk-stub.ts.
 */
import { APIRequestContext, Page, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';
import { hasViteClerkKey } from '../helpers/clerk-key';
import type { Pool } from 'pg';
import { PgProposalRepository } from '../../packages/api/src/proposals/pg-proposal';
import { createProposal } from '../../packages/api/src/proposals/proposal';

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ?? 'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

/** The local webServer pair against a real Postgres (never a deployed env). */
export function canRunAgainstRealPostgres(): boolean {
  return (
    (!process.env.E2E_BASE_URL || /^https?:\/\/(127\.0\.0\.1|localhost)/.test(process.env.E2E_BASE_URL)) &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!process.env.DATABASE_URL
  );
}

export const SKIP_REASON =
  'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset (or localhost), ' +
  'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), E2E_USE_TEST_DB=true, and DATABASE_URL pointing at ' +
  'the test container (also used directly here to run the worker tick).';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function unsignedJwt(sub: string): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub, sid: 'dev-session', role: 'owner' })}.x`;
}

function signSvix(rawBody: string, svixId: string, svixTimestamp: string): string {
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret).update(`${svixId}.${svixTimestamp}.${rawBody}`).digest('base64');
  return `v1,${sig}`;
}

export interface Owner {
  tenantId: string;
  sub: string;
  jwt: string;
  email: string;
  businessName: string;
  authHeaders: { Authorization: string };
}

/** A real owner: Clerk `user.created` webhook → tenant, then onboarding identity. */
export async function bootstrapOwner(
  request: APIRequestContext,
  label: string,
  opts: { timezone?: string; businessName?: string } = {},
): Promise<Owner> {
  const sub = `user_e2e_close89_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `owner-${label}-${Date.now()}@serviceos-hermetic.test`;
  const jwt = unsignedJwt(sub);
  const authHeaders = { Authorization: `Bearer ${jwt}` };
  const businessName = opts.businessName ?? `Close 8.9 ${label} Co`;

  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({ type: 'user.created', data: { id: sub, email_addresses: [{ email_address: email }] } });
  const webhookRes = await request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
  });
  expect(webhookRes.status(), `${label} webhook -> ${await webhookRes.text()}`).toBe(200);

  const meRes = await request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);

  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName,
      businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: opts.timezone ?? 'America/Chicago',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity (${label}) -> ${identityRes.status()}`).toBeTruthy();

  return { tenantId: me.tenant_id!, sub, jwt, email, businessName, authHeaders };
}

async function postJson<T>(request: APIRequestContext, url: string, owner: Owner, body: unknown): Promise<T> {
  const res = await request.post(url, {
    headers: { 'content-type': 'application/json', ...owner.authHeaders },
    data: JSON.stringify(body),
  });
  expect(res.ok(), `POST ${url} -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

export interface CompletedJob {
  customerId: string;
  jobId: string;
  phone: string;
}

/**
 * A texting-consented customer + location + job, walked to `completed`
 * through the real authenticated API (new → scheduled → in_progress →
 * completed, one hop at a time — job-lifecycle.ts). No SQL.
 */
export async function createCompletedJob(
  request: APIRequestContext,
  owner: Owner,
  label: string,
  phone: string,
): Promise<CompletedJob> {
  const customer = await postJson<{ id: string }>(request, `${API_URL}/api/customers`, owner, {
    firstName: label,
    lastName: 'Customer',
    primaryPhone: phone,
    preferredChannel: 'sms',
    smsConsent: true,
  });
  const location = await postJson<{ id: string }>(request, `${API_URL}/api/locations`, owner, {
    customerId: customer.id,
    street1: `1 ${label} St`,
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    isPrimary: true,
  });
  const job = await postJson<{ id: string }>(request, `${API_URL}/api/jobs`, owner, {
    customerId: customer.id,
    locationId: location.id,
    summary: `${label} close-8.9 job`,
  });
  for (const status of ['scheduled', 'in_progress', 'completed']) {
    await postJson(request, `${API_URL}/api/jobs/${job.id}/transition`, owner, { status });
  }
  return { customerId: customer.id, jobId: job.id, phone };
}

/** Bind the browser to `owner` (Clerk stub + dismissed walkthroughs + external hosts blocked). */
export async function signInAs(page: Page, owner: Owner, baseURL: string): Promise<void> {
  await installClerkStub(page, { signedIn: true, sub: owner.sub, token: owner.jwt });
  await page.addInitScript(
    ({ welcomeKey, whatsNewKey }) => {
      try {
        localStorage.setItem(welcomeKey, '1');
        localStorage.setItem(whatsNewKey, '2026-06-21-onboarding');
      } catch {
        /* private mode */
      }
    },
    { welcomeKey: WELCOME_SEEN_KEY, whatsNewKey: WHATS_NEW_SEEN_KEY },
  );
  await blockExternalHosts(page, baseURL);
}

/**
 * Flip one Settings › Quick settings switch (by its visible label) in the
 * real browser and wait for the real `PUT /api/settings` to land.
 */
export async function flipQuickSetting(page: Page, label: string): Promise<void> {
  // Click only once the page holds the tenant's real settings — a click on
  // the pre-load default would flip nothing server-side.
  const loaded = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/settings' && r.ok(),
    { timeout: 30_000 },
  );
  await page.goto('/settings', { timeout: 45_000 });
  const crashed = page.getByText('Something went wrong');
  if (await crashed.isVisible({ timeout: 3_000 }).catch(() => false)) await page.reload();
  await loaded;
  const toggle = page.locator(
    `xpath=//p[normalize-space(text())="${label}"]/ancestor::div[contains(@class,"justify-between")][1]//button`,
  );
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await toggle.scrollIntoViewIfNeeded();
  const putPromise = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/settings',
    { timeout: 30_000 },
  );
  await toggle.click();
  const putRes = await putPromise;
  expect(putRes.status(), `PUT /api/settings (${label}) -> ${putRes.status()}`).toBeLessThan(300);
}

/** Poll `fn` until it returns a non-null value (rows written by the running app's own workers). */
export async function pollFor<T>(fn: () => Promise<T | null | undefined>, message: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The AI's draft estimate for a job — one labor line at `laborCents`.
 *
 * Seeded through the real proposal repository + domain constructor (the same
 * seam `correction-loop-reachability-9-8-9-9.test.ts` uses): drafting it for
 * real needs a live model (#1119), and the draft is the AI's output, not an
 * owner action. Every OWNER step after it (edit, approve, undo) goes through
 * the running app.
 */
export async function seedAiDraftEstimate(
  pool: Pool,
  owner: Owner,
  job: { jobId: string; customerId: string },
  laborCents: number,
): Promise<string> {
  const draft = createProposal({
    tenantId: owner.tenantId,
    proposalType: 'draft_estimate',
    payload: {
      jobId: job.jobId,
      customerId: job.customerId,
      lineItems: [laborLine(laborCents)],
    },
    summary: 'Estimate for the completed job',
    createdBy: owner.sub,
  });
  await new PgProposalRepository(pool).create({ ...draft, status: 'ready_for_review' });
  return draft.id;
}

/** One estimate labor line at `cents` (estimate payloads carry `unitPrice` in integer cents). */
export function laborLine(cents: number): Record<string, unknown> {
  return {
    id: 'l1',
    description: 'Standard Labor',
    category: 'labor',
    quantity: 1,
    unitPrice: cents,
    unitPriceCents: cents,
    totalCents: cents,
    sortOrder: 0,
    taxable: true,
  };
}

/** The owner's correction through the real edit route: `PUT /api/proposals/:id { edits }`. */
export async function editProposalAsOwner(
  request: APIRequestContext,
  owner: Owner,
  proposalId: string,
  edits: Record<string, unknown>,
): Promise<void> {
  const res = await request.put(`${API_URL}/api/proposals/${proposalId}`, {
    headers: { 'content-type': 'application/json', ...owner.authHeaders },
    data: JSON.stringify({ edits }),
  });
  expect(res.ok(), `PUT /api/proposals/${proposalId} -> ${res.status()}: ${await res.text()}`).toBeTruthy();
}
