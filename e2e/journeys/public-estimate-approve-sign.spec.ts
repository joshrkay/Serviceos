import { Page, APIRequestContext } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { hasViteClerkKey } from '../helpers/clerk-key';

const SCREENSHOT_DIR = join(process.cwd(), 'docs/audit/lane-reports/public-surfaces-r5');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

/**
 * 7.6 — rung-5 reachability: the customer approves a tiered estimate and
 * signs, from the public token link, with no login, at real Postgres.
 *
 * Bootstrap pattern mirrors e2e/journeys/digest-toggle.spec.ts and
 * e2e/journeys/revenue-cluster-toggles.spec.ts (signed Clerk webhook +
 * PUT /api/onboarding/identity to clear the soft onboarding gate). Every
 * setup step (customer/location/job/estimate/send/revise/convert) goes
 * through the REAL authenticated API — no SQL, no platform-admin route, no
 * env-var shortcut. Only the read-back assertions (audit rows; the
 * signature/IP/UA columns the public view never echoes back) query
 * Postgres directly, RLS-scoped via `SET LOCAL app.current_tenant_id`,
 * exactly like e2e/qa-matrix/helpers/rw-db.ts does.
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

interface Tenant {
  tenantId: string;
  authHeaders: { Authorization: string };
}

/** Bootstrap a fresh owner + tenant exactly like a real signup would. */
async function bootstrapOwner(
  request: APIRequestContext,
  label: string,
  businessName: string,
): Promise<Tenant> {
  const ownerSub = `user_e2e_estapprove_${label}_${randomUUID().replace(/-/g, '')}`;
  const ownerEmail = `owner-${label}-${Date.now()}@serviceos-hermetic.test`;
  const jwt = unsignedJwt(ownerSub);
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({
    type: 'user.created',
    data: { id: ownerSub, email_addresses: [{ email_address: ownerEmail }] },
  });
  const webhookRes = await request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
  });
  expect(webhookRes.status(), `webhook rejected: ${await webhookRes.text()}`).toBe(200);

  const meRes = await request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);
  const tenantId = me.tenant_id!;

  const identityRes = await request.put(`${API_URL}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...authHeaders },
    data: JSON.stringify({
      businessName,
      businessHours: { mon: { open: '08:00', close: '17:00' }, sat: null, sun: null },
      jobBufferMinutes: 30,
      hourlyRateCents: 12500,
      timezone: 'America/Chicago',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

  return { tenantId, authHeaders };
}

interface JobRef {
  customerId: string;
  jobId: string;
}

async function seedJob(
  request: APIRequestContext,
  tenant: Tenant,
  customerLabel: string,
): Promise<JobRef> {
  const customerRes = await request.post(`${API_URL}/api/customers`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      firstName: customerLabel,
      lastName: 'Customer',
      email: `${customerLabel.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`,
      preferredChannel: 'email',
    }),
  });
  expect(customerRes.ok(), `create customer -> ${customerRes.status()}`).toBeTruthy();
  const customer = (await customerRes.json()) as { id: string };

  const locationRes = await request.post(`${API_URL}/api/locations`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      customerId: customer.id,
      street1: '1 Estimate Approval Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      isPrimary: true,
    }),
  });
  expect(locationRes.ok(), `create location -> ${locationRes.status()}`).toBeTruthy();
  const location = (await locationRes.json()) as { id: string };

  const jobRes = await request.post(`${API_URL}/api/jobs`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      customerId: customer.id,
      locationId: location.id,
      summary: `${customerLabel} — 7.6 approval journey`,
    }),
  });
  expect(jobRes.ok(), `create job -> ${jobRes.status()}`).toBeTruthy();
  const job = (await jobRes.json()) as { id: string };

  return { customerId: customer.id, jobId: job.id };
}

interface SentEstimate {
  estimateId: string;
  viewToken: string;
}

async function createAndSendTieredEstimate(
  request: APIRequestContext,
  tenant: Tenant,
  job: JobRef,
): Promise<SentEstimate> {
  const estimateRes = await request.post(`${API_URL}/api/estimates`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      jobId: job.jobId,
      lineItems: [
        {
          id: randomUUID(),
          description: 'Basic Package',
          quantity: 1,
          unitPriceCents: 20_000,
          totalCents: 20_000,
          sortOrder: 0,
          taxable: false,
          groupKey: 'tier',
          groupLabel: 'Service Tier',
          isOptional: true,
          isDefaultSelected: true,
        },
        {
          id: randomUUID(),
          description: 'Premium Package',
          quantity: 1,
          unitPriceCents: 35_000,
          totalCents: 35_000,
          sortOrder: 1,
          taxable: false,
          groupKey: 'tier',
          groupLabel: 'Service Tier',
          isOptional: true,
          isDefaultSelected: false,
        },
      ],
      customerMessage: 'Pick the package that works for you.',
    }),
  });
  expect(estimateRes.ok(), `create estimate -> ${estimateRes.status()}`).toBeTruthy();
  const estimate = (await estimateRes.json()) as { id: string };

  const sendRes = await request.post(`${API_URL}/api/estimates/${estimate.id}/send`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({ channel: 'email' }),
  });
  expect(sendRes.ok(), `send estimate -> ${sendRes.status()} ${await sendRes.text()}`).toBeTruthy();
  const sent = (await sendRes.json()) as { viewToken: string };
  expect(sent.viewToken).toBeTruthy();

  return { estimateId: estimate.id, viewToken: sent.viewToken };
}

async function createAndSendSimpleEstimate(
  request: APIRequestContext,
  tenant: Tenant,
  job: JobRef,
): Promise<SentEstimate> {
  const estimateRes = await request.post(`${API_URL}/api/estimates`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      jobId: job.jobId,
      lineItems: [
        {
          id: randomUUID(),
          description: 'Diagnostic visit',
          quantity: 1,
          unitPriceCents: 9_900,
          totalCents: 9_900,
          sortOrder: 0,
          taxable: false,
        },
      ],
    }),
  });
  expect(estimateRes.ok(), `create estimate -> ${estimateRes.status()}`).toBeTruthy();
  const estimate = (await estimateRes.json()) as { id: string };

  const sendRes = await request.post(`${API_URL}/api/estimates/${estimate.id}/send`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({ channel: 'email' }),
  });
  expect(sendRes.ok(), `send estimate -> ${sendRes.status()}`).toBeTruthy();
  const sent = (await sendRes.json()) as { viewToken: string };

  return { estimateId: estimate.id, viewToken: sent.viewToken };
}

/** RLS-scoped read against real Postgres, mirroring e2e/qa-matrix/helpers/rw-db.ts. */
async function queryAsTenant(
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant_id = '${tenantId.replace(/'/g, "''")}'`);
    const res = await client.query(sql, params);
    await client.query('COMMIT');
    return res.rows;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The signature canvas (EstimateApprovalPage.tsx's SignatureCanvas) binds
 * only onMouseDown/onMouseMove/onMouseUp — no pointer events — so it must be
 * driven with real `mousedown`/`mousemove`/`mouseup` DOM events, not
 * `page.mouse.*`'s OS-level virtual-input trajectory. `page.mouse` proved
 * flaky in review (a real bug report, not a planted one): its stroke can
 * land while the approval sheet's own slide-up transition is still running,
 * or simply miss the canvas's attached listeners in headless Chromium.
 * Dispatching the events directly on the element — same technique the
 * component itself listens for, just skipping the OS input layer — is
 * deterministic instead of retried.
 */
async function drawSignature(page: Page): Promise<void> {
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  // Let the sheet's own CSS transition (sheetUp, 0.3s) finish before the
  // canvas's bounding box is read — a stroke computed mid-transition can
  // target coordinates the canvas hasn't settled into yet.
  await page.waitForTimeout(350);
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const points = [
    { x: box!.x + box!.width * 0.2, y: box!.y + box!.height * 0.5 },
    { x: box!.x + box!.width * 0.35, y: box!.y + box!.height * 0.35 },
    { x: box!.x + box!.width * 0.5, y: box!.y + box!.height * 0.65 },
    { x: box!.x + box!.width * 0.65, y: box!.y + box!.height * 0.4 },
  ];
  await canvas.dispatchEvent('mousedown', {
    clientX: points[0].x,
    clientY: points[0].y,
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 1,
  });
  for (const p of points.slice(1)) {
    await canvas.dispatchEvent('mousemove', {
      clientX: p.x,
      clientY: p.y,
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
    });
  }
  await canvas.dispatchEvent('mouseup', {
    clientX: points[points.length - 1].x,
    clientY: points[points.length - 1].y,
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: 0,
  });
  await expect(page.getByRole('button', { name: /^Clear$/i })).toBeVisible({ timeout: 5_000 });
}

test.describe('public estimate approve + sign (7.6) — real Postgres', () => {
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
  test.use({ viewport: { width: 390, height: 844 } });

  test('a customer picks a tier, signs, and approves from the token link; a stale-version approve is refused; a neighbour tenant token never opens this estimate', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // ── Tenant A: the tiered estimate under test ────────────────────────────
    const tenantA = await bootstrapOwner(request, 'a', 'Acme HVAC 7.6');
    const jobA = await seedJob(request, tenantA, 'Sarah');
    const tiered = await createAndSendTieredEstimate(request, tenantA, jobA);

    // A second, simple estimate on tenant A for the stale-revision guard.
    const jobA2 = await seedJob(request, tenantA, 'StaleGuard');
    const staleTarget = await createAndSendSimpleEstimate(request, tenantA, jobA2);

    // ── Tenant B: a wholly independent estimate, for the T2 isolation check ─
    const tenantB = await bootstrapOwner(request, 'b', 'Bexar Plumbing 7.6');
    const jobB = await seedJob(request, tenantB, 'Jordan');
    const otherTenant = await createAndSendSimpleEstimate(request, tenantB, jobB);

    // ── T2 — tenant B's token opens ONLY tenant B's estimate, never A's ─────
    await page.goto(`/e/${otherTenant.viewToken}`);
    await expect(page.getByText('Bexar Plumbing 7.6', { exact: true })).toBeVisible();
    await expect(page.getByText('Acme HVAC 7.6', { exact: true })).toHaveCount(0);

    // ── Main flow: open tenant A's tiered estimate as the customer ──────────
    await page.goto(`/e/${tiered.viewToken}`);
    await expect(page.getByText('Acme HVAC 7.6', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.6-estimate-before.png') });

    // Pick the Premium tier (default is Basic).
    await page.getByRole('button', { name: /Premium Package/i }).click();
    await expect(page.getByText('$350.00').first()).toBeVisible();

    await page.getByRole('button', { name: /Accept this estimate/i }).click();

    const nameInput = page.getByPlaceholder('Your full name');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('Pat Playwright Signer');
    await drawSignature(page);

    const submit = page.getByRole('button', { name: /^Accept estimate$/ });
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByRole('heading', { name: /Estimate accepted!/i })).toBeVisible({
      timeout: 15_000,
    });

    // Reload — the acceptance must be durable, not just optimistic client state.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /Estimate accepted!/i })).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: join(SCREENSHOT_DIR, '7.6-estimate-after-reload.png') });

    // ── Durable proof: the acceptance AND the signature persisted ───────────
    const ownerView = await request.get(`${API_URL}/api/estimates/${tiered.estimateId}`, {
      headers: tenantA.authHeaders,
    });
    expect(ownerView.ok()).toBeTruthy();
    const estimateRow = (await ownerView.json()) as {
      status: string;
      acceptedSelection?: string[];
      acceptedByName?: string;
      acceptedByIp?: string;
      acceptedUserAgent?: string;
      acceptedSignatureData?: string;
      totals: { totalCents: number };
    };
    expect(estimateRow.status).toBe('accepted');
    expect(estimateRow.acceptedByName).toBe('Pat Playwright Signer');
    expect(estimateRow.totals.totalCents).toBe(35_000);
    expect(estimateRow.acceptedSignatureData, 'signature must persist, not stay fixture data').toMatch(
      /^data:image\/png;base64,/,
    );
    expect(estimateRow.acceptedByIp).toBeTruthy();
    expect(estimateRow.acceptedUserAgent).toBeTruthy();

    const approvedAudit = await queryAsTenant(
      tenantA.tenantId,
      `SELECT event_type, metadata FROM audit_events WHERE tenant_id = $1 AND entity_type = 'estimate' AND entity_id = $2 AND event_type = 'public_estimate.approved'`,
      [tenantA.tenantId, tiered.estimateId],
    );
    expect(approvedAudit).toHaveLength(1);

    // ── estimate.converted — the natural owner-side next step, still reachable
    //    with no SQL/platform-admin/env var (a normal authenticated API call) ─
    const convertRes = await request.post(
      `${API_URL}/api/estimates/${tiered.estimateId}/convert-to-invoice`,
      { headers: tenantA.authHeaders },
    );
    expect(convertRes.ok(), `convert-to-invoice -> ${convertRes.status()}`).toBeTruthy();
    const invoice = (await convertRes.json()) as { id: string; totalCents?: number };
    expect(invoice.id).toBeTruthy();

    const convertedAudit = await queryAsTenant(
      tenantA.tenantId,
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_type = 'estimate' AND entity_id = $2 AND event_type = 'estimate.converted'`,
      [tenantA.tenantId, tiered.estimateId],
    );
    expect(convertedAudit).toHaveLength(1);

    // ── Stale-version approve is refused ─────────────────────────────────────
    await page.goto(`/e/${staleTarget.viewToken}`);
    await expect(page.getByText('Acme HVAC 7.6', { exact: true })).toBeVisible();

    // The business revises the estimate WHILE the customer's page is open —
    // the browser still holds the pre-revision version in React state.
    const reviseRes = await request.post(
      `${API_URL}/api/estimates/${staleTarget.estimateId}/revise`,
      {
        headers: { 'content-type': 'application/json', ...tenantA.authHeaders },
        data: JSON.stringify({ customerMessage: 'Scope updated after you opened this link.' }),
      },
    );
    expect(reviseRes.ok(), `revise -> ${reviseRes.status()}`).toBeTruthy();

    await page.getByRole('button', { name: /Accept this estimate/i }).click();
    await page.getByPlaceholder('Your full name').fill('Too Late Customer');
    await drawSignature(page);
    await page.getByRole('button', { name: /^Accept estimate$/ }).click();

    // The stale 409 bounces the customer back to the page with a revised banner
    // — never the success screen.
    await expect(
      page.getByText(/This estimate was updated by the business/i),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: /Estimate accepted!/i })).toHaveCount(0);

    const staleRow = await request.get(`${API_URL}/api/estimates/${staleTarget.estimateId}`, {
      headers: tenantA.authHeaders,
    });
    const staleEstimate = (await staleRow.json()) as { status: string; acceptedAt?: string };
    expect(staleEstimate.status).toBe('sent');
    expect(staleEstimate.acceptedAt).toBeUndefined();

    expect(pageErrors, 'no uncaught page errors during the approval journey').toEqual([]);
  });
});
