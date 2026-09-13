/**
 * Shared helpers for the #995 §8.7 Quote rung-5 reachability specs
 * (7.1, 7.3, 7.4, 7.5, 7.7, 7.8, 7.9, 7.10, 7.12).
 *
 * `bootstrapOwner` / `seedJob` / `queryAsTenant` are copied verbatim (with
 * additive extensions — `sub`/`jwt` on the returned tenant, so a real
 * browser page can `installClerkStub` as the SAME owner; per-tenant
 * timezone/rate opts) from `e2e/journeys/public-estimate-approve-sign.spec.ts`
 * (the 7.6 rung-5 spec, Fable-gated, PR #1087) so every §8.7 spec
 * bootstraps a tenant the exact same way: a real Clerk `user.created`
 * webhook (HMAC-signed) mints the owner + tenant, then
 * `PUT /api/onboarding/identity` clears the soft onboarding gate. No SQL
 * writes to reach a state the product should produce.
 */
import { Page, APIRequestContext, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { installClerkStub } from '../helpers/clerk-stub';
import { blockExternalHosts } from '../helpers/api-mocks/shell';

/** Copied verbatim from e2e/journeys/digest-toggle.spec.ts — skip the
 * welcome/what's-new walkthrough overlays so they never intercept a click. */
export const WELCOME_SEEN_KEY = 'walkthrough.welcome.v1';
export const WHATS_NEW_SEEN_KEY = 'walkthrough.whatsnew.lastSeen';

/**
 * Sign the REAL browser in as a bootstrapped owner — the recipe
 * e2e/journeys/digest-toggle.spec.ts and dispatch-board.spec.ts use:
 * installClerkStub as the SAME sub/jwt the API calls used, the two
 * walkthrough-seen localStorage keys (otherwise the "What's new in Rivet"
 * dialog — data-testid="modal", fixed inset-0 z-50 — intercepts the first
 * click on any authenticated page), and blockExternalHosts. Call BEFORE the
 * first page.goto().
 */
export async function signInOwnerBrowser(page: Page, baseURL: string, tenant: Tenant): Promise<void> {
  await installClerkStub(page, { signedIn: true, sub: tenant.sub, token: tenant.jwt });
  await page.addInitScript(
    ({ welcomeKey, whatsNewKey }) => {
      try {
        localStorage.setItem(welcomeKey, '1');
        localStorage.setItem(whatsNewKey, '2026-06-21-onboarding');
      } catch {
        /* storage unavailable — overlays may show; the assertions still hold */
      }
    },
    { welcomeKey: WELCOME_SEEN_KEY, whatsNewKey: WHATS_NEW_SEEN_KEY },
  );
  await blockExternalHosts(page, baseURL);
}

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

export const UUID_RE =
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

/** Stripe-shaped webhook signature — same recipe as createWebhookSignature
 * in packages/api/src/webhooks/webhook-handler.ts, copied verbatim from
 * e2e/journeys/public-invoice-pay-link.spec.ts. */
export function stripeSignature(rawBody: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

export interface Tenant {
  tenantId: string;
  authHeaders: { Authorization: string };
  /** Clerk `sub` this tenant's owner was bootstrapped with — pass to
   * `installClerkStub(page, { signedIn: true, sub, token: jwt })` so a real
   * browser page authenticates as this SAME owner (DEV_AUTH_BYPASS decodes
   * `sub` from the JWT without verifying — see e2e/helpers/clerk-stub.ts and
   * e2e/journeys/dispatch-board.spec.ts's `bootstrapOwnerTenant`). */
  sub: string;
  jwt: string;
}

/** Bootstrap a fresh owner + tenant exactly like a real signup would. */
export async function bootstrapOwner(
  request: APIRequestContext,
  label: string,
  businessName: string,
  opts: { timezone?: string; hourlyRateCents?: number } = {},
): Promise<Tenant> {
  const ownerSub = `user_e2e_q87_${label}_${randomUUID().replace(/-/g, '')}`;
  const ownerEmail = `owner-${label}-${Date.now()}-${randomUUID().slice(0, 6)}@serviceos-hermetic.test`;
  const jwt = unsignedJwt(ownerSub);
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify({
    type: 'user.created',
    data: { id: ownerSub, email_addresses: [{ email_address: ownerEmail }] },
  });
  // The tenant bootstrap is the heaviest call in any spec (tenant + owner +
  // settings + the provisioning worker's stub twilio row); with three lanes'
  // stacks on one Mac it has exceeded the harness's 10s per-request ceiling
  // right after api boot (7.7 pass 2). A longer wait, never a retry-the-write.
  const webhookRes = await request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
    timeout: 60_000,
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
      hourlyRateCents: opts.hourlyRateCents ?? 12500,
      timezone: opts.timezone ?? 'America/Chicago',
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity -> ${identityRes.status()}`).toBeTruthy();

  return { tenantId, authHeaders, sub: ownerSub, jwt };
}

export interface JobRef {
  customerId: string;
  locationId: string;
  jobId: string;
}

export async function seedJob(
  request: APIRequestContext,
  tenant: Tenant,
  customerLabel: string,
  opts: { firstName?: string; lastName?: string } = {},
): Promise<JobRef> {
  const customerRes = await request.post(`${API_URL}/api/customers`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      firstName: opts.firstName ?? customerLabel,
      lastName: opts.lastName ?? 'Customer',
      email: `${customerLabel.toLowerCase().replace(/[^a-z0-9]/g, '')}-${randomUUID().slice(0, 8)}@example.test`,
      preferredChannel: 'email',
    }),
  });
  expect(customerRes.ok(), `create customer -> ${customerRes.status()}`).toBeTruthy();
  const customer = (await customerRes.json()) as { id: string };
  // #1133 workaround — the create transaction commits on res.finish, after
  // the response is flushed; poll the row by id before the dependent create.
  await pollForRow(async () => {
    const r = await request.get(`${API_URL}/api/customers/${customer.id}`, { headers: tenant.authHeaders });
    return r.ok() ? customer : null;
  });

  const locationRes = await request.post(`${API_URL}/api/locations`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      customerId: customer.id,
      street1: '1 Quote Lane',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      isPrimary: true,
    }),
  });
  expect(locationRes.ok(), `create location -> ${locationRes.status()}`).toBeTruthy();
  const location = (await locationRes.json()) as { id: string };
  // #1133 workaround (same race — POST /api/jobs has 404'd "Location not
  // found" 9ms after the location's own 201 on sibling lanes).
  await pollForRow(async () => {
    const r = await request.get(`${API_URL}/api/locations/${location.id}`, { headers: tenant.authHeaders });
    return r.ok() ? location : null;
  });

  const jobRes = await request.post(`${API_URL}/api/jobs`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      customerId: customer.id,
      locationId: location.id,
      summary: `${customerLabel} — §8.7 quote lane job`,
    }),
  });
  expect(jobRes.ok(), `create job -> ${jobRes.status()}`).toBeTruthy();
  const job = (await jobRes.json()) as { id: string };

  return { customerId: customer.id, locationId: location.id, jobId: job.id };
}

export interface EstLineItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  sortOrder: number;
  taxable: boolean;
  groupKey?: string;
  groupLabel?: string;
  isOptional?: boolean;
  isDefaultSelected?: boolean;
}

export async function createEstimate(
  request: APIRequestContext,
  tenant: Tenant,
  job: JobRef,
  lineItems: EstLineItem[],
  extra: Record<string, unknown> = {},
): Promise<{ estimateId: string }> {
  const res = await request.post(`${API_URL}/api/estimates`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({ jobId: job.jobId, lineItems, ...extra }),
  });
  expect(res.ok(), `create estimate -> ${res.status()} ${await res.text()}`).toBeTruthy();
  const est = (await res.json()) as { id: string };
  return { estimateId: est.id };
}

export interface SentEstimate {
  estimateId: string;
  viewToken: string;
}

export async function sendEstimate(
  request: APIRequestContext,
  tenant: Tenant,
  estimateId: string,
  channel: 'email' | 'sms' = 'email',
): Promise<SentEstimate> {
  const sendRes = await request.post(`${API_URL}/api/estimates/${estimateId}/send`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({ channel }),
  });
  expect(sendRes.ok(), `send estimate -> ${sendRes.status()} ${await sendRes.text()}`).toBeTruthy();
  const sent = (await sendRes.json()) as { viewToken: string };
  expect(sent.viewToken).toBeTruthy();
  return { estimateId, viewToken: sent.viewToken };
}

export async function createAndSendSimpleEstimate(
  request: APIRequestContext,
  tenant: Tenant,
  job: JobRef,
  priceCents = 9_900,
  channel: 'email' | 'sms' = 'email',
): Promise<SentEstimate> {
  const { estimateId } = await createEstimate(request, tenant, job, [
    {
      id: randomUUID(),
      description: 'Diagnostic visit',
      quantity: 1,
      unitPriceCents: priceCents,
      totalCents: priceCents,
      sortOrder: 0,
      taxable: false,
    },
  ]);
  return sendEstimate(request, tenant, estimateId, channel);
}

/**
 * Three tiers (good/better/best) sharing groupKey 'tier' (Basic is
 * isDefaultSelected) plus one standalone add-on (isOptional, no groupKey,
 * unchecked by default) — the shape `resolveSelectedLineItems`
 * (packages/api/src/shared/billing-engine.ts) expects for 7.4/7.5.
 */
export async function createTieredEstimateWithAddOn(
  request: APIRequestContext,
  tenant: Tenant,
  job: JobRef,
): Promise<{ estimateId: string; tierIds: Record<'basic' | 'premium' | 'elite', string>; addOnId: string }> {
  const basicId = randomUUID();
  const premiumId = randomUUID();
  const eliteId = randomUUID();
  const addOnId = randomUUID();
  const { estimateId } = await createEstimate(request, tenant, job, [
    {
      id: basicId,
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
      id: premiumId,
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
    {
      id: eliteId,
      description: 'Elite Package',
      quantity: 1,
      unitPriceCents: 50_000,
      totalCents: 50_000,
      sortOrder: 2,
      taxable: false,
      groupKey: 'tier',
      groupLabel: 'Service Tier',
      isOptional: true,
      isDefaultSelected: false,
    },
    {
      id: addOnId,
      description: 'Extended Warranty Add-on',
      quantity: 1,
      unitPriceCents: 5_000,
      totalCents: 5_000,
      sortOrder: 3,
      taxable: false,
      isOptional: true,
      isDefaultSelected: false,
    },
  ]);
  return { estimateId, tierIds: { basic: basicId, premium: premiumId, elite: eliteId }, addOnId };
}

/**
 * §12.4d evidence — print a read-back verbatim into the Playwright stdout so
 * the PR body / lane report can quote the actual rows the acceptance names
 * (the globalTeardown TRUNCATEs the test DB after every run, so the rows
 * cannot be dumped afterwards). Pure logging; asserts nothing.
 */
export function logRows(label: string, rows: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`[8.7 row-dump] ${label}\n${JSON.stringify(rows, null, 2)}`);
}

/**
 * Tenant-scoped read against real Postgres, mirroring e2e/qa-matrix/helpers/rw-db.ts.
 *
 * NOT an RLS probe under this harness: the Playwright recipe connects as the
 * testcontainer's superuser (`test`), and superusers bypass RLS even under
 * FORCE ROW LEVEL SECURITY (schema.ts:545-548); the app's `SET ROLE
 * rls_app_runtime` path only runs with RLS_RUNTIME_ROLE=true (the vitest-
 * integration recipe). So always scope the SQL itself by `tenant_id = $n`,
 * and prove cross-tenant INVISIBILITY through the real API (a 404 for the
 * other tenant's owner), never by reading "as" the other tenant here.
 */
export async function queryAsTenant(
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

/** Unscoped read (no RLS session var) — for CHECK-constraint / cross-tenant probes.
 * Never throws: a CHECK-constraint violation is returned as `error`, not thrown,
 * so a spec can assert `error.code === '23514'` without a try/catch. */
export async function queryRaw(
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[]; error?: Error & { code?: string } }> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query(sql, params);
    return { rows: res.rows };
  } catch (err) {
    return { rows: [], error: err as Error & { code?: string } };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Seed one catalog item as the owner, through the real authenticated API. */
export async function seedCatalogItem(
  request: APIRequestContext,
  tenant: Tenant,
  args: { name: string; unitPriceCents: number; category?: 'Labor' | 'Parts' | 'Materials'; unit?: string },
): Promise<{ id: string }> {
  const res = await request.post(`${API_URL}/api/catalog/items`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      name: args.name,
      category: args.category ?? 'Labor',
      unit: args.unit ?? 'hour',
      unitPriceCents: args.unitPriceCents,
    }),
  });
  expect(res.ok(), `create catalog item -> ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { id: string };
}

/**
 * Draft an estimate through the REAL owner Assistant chat surface
 * (`POST /api/assistant/chat`), driven from a REAL browser at
 * `/assistant` — the deterministic `matchDraftEstimatePhrase` short-circuit
 * (`packages/api/src/ai/orchestration/intent-classifier.ts:1702`)
 * recognizes the canonical "draft/create/write/prepare/generate an
 * estimate for <customer>: <line items>" imperative with NO gateway call
 * for classification, then dispatches straight to the real
 * `EstimateTaskHandler` — the "spoken description" analog this lane can
 * drive hermetically end-to-end without a live model (see the lane report
 * for why literal browser-simulated speech-to-text is not attempted, and
 * why the "customer photo" / MMS leg is pinned as a product gap instead of
 * driven this way).
 */
export async function draftEstimateViaChat(
  page: Page,
  customerName: string,
  lineDescription: string,
): Promise<void> {
  await page.goto('/assistant');
  const textarea = page.getByPlaceholder(/message|ask|type/i).first();
  await expect(textarea).toBeVisible({ timeout: 15_000 });
  const message = `Draft an estimate for ${customerName}: ${lineDescription}`;
  await textarea.fill(message);
  await textarea.press('Enter');

  const approveBtn = page.getByRole('button', { name: /^Approve$/ }).first();
  await expect(approveBtn).toBeVisible({ timeout: 20_000 });
}

/**
 * Draft-authoring row for `createEstimateViaBrowserRow` — mirrors
 * `LineItemDraft` (packages/web/src/components/forms/LineItemEditor.tsx):
 * dollars (not cents) since that's what the real inputs accept, and the
 * SAME `groupLabel` text on two-or-more rows makes them one mutually-
 * exclusive tier group (the component derives `groupKey` from the trimmed
 * label — see `toLineItemPayload`).
 */
export interface BrowserLineItemRow {
  description: string;
  quantity: string;
  unitPriceDollars: string;
  isOptional?: boolean;
  groupLabel?: string;
  isDefaultSelected?: boolean;
}

/**
 * Drive the REAL `/estimates/new?jobId=…` owner form
 * (packages/web/src/components/estimates/EstimateForm.tsx +
 * forms/LineItemEditor.tsx, `enableOptions`) in a real browser: select the
 * job, fill each line-item row (description/qty/price, and — when present —
 * the "Optional add-on" checkbox, "Tier group" label, and "Pre-selected"
 * checkbox), and submit.
 */
export async function createEstimateViaBrowserRow(
  page: Page,
  jobId: string,
  rows: BrowserLineItemRow[],
): Promise<void> {
  await page.goto(`/estimates/new?jobId=${encodeURIComponent(jobId)}`);
  await expect(page.getByRole('heading', { name: 'New Estimate' })).toBeVisible();
  await page.getByLabel(/^Job \*/).selectOption(jobId);

  for (let i = 0; i < rows.length; i++) {
    if (i > 0) {
      await page.getByRole('button', { name: '+ Add row' }).click();
    }
    const row = rows[i];
    await page.getByLabel(`description-${i}`).fill(row.description);
    await page.getByLabel(`quantity-${i}`).fill(row.quantity);
    await page.getByLabel(`unit-price-${i}`).fill(row.unitPriceDollars);
    if (row.isOptional) {
      await page.getByLabel(`optional-${i}`).check();
    }
    if (row.groupLabel) {
      await page.getByLabel(`group-${i}`).fill(row.groupLabel);
    }
    if (row.isDefaultSelected) {
      await page.getByLabel(`default-selected-${i}`).check();
    }
  }

  await page.getByRole('button', { name: 'Create estimate' }).click();
  await page.waitForURL('**/estimates', { timeout: 15_000 });
}

/**
 * Drive the REAL "Send" sheet
 * (packages/web/src/components/estimates/EstimatesPage.tsx
 * `SendEstimateSheet`, `POST /api/estimates/:id/send`) from the estimate
 * detail view. Assumes `page` is already on `/estimates/:id`.
 */
export async function sendEstimateViaBrowser(page: Page, estimateTerm = 'estimate'): Promise<void> {
  await page.getByRole('button', { name: /Send (to customer|follow-up|reminder)/i }).click();
  // The sheet's submit button's accessible name is `Send ${estimateTerm}`
  // (e.g. "Send estimate") — distinct from the detail view's "Send to
  // customer" trigger clicked above, so an exact match is unambiguous.
  await page.getByRole('button', { name: `Send ${estimateTerm}`, exact: true }).click();
  await expect(page.getByText('Sent!')).toBeVisible({ timeout: 15_000 });
}

/**
 * #1133 workaround — the create-estimate form navigates to the plain
 * `/estimates` list on success (no id in the URL), so poll
 * `GET /api/estimates?jobId=` for the newest row on that job before
 * navigating to its `/estimates/:id` deep link.
 */
export async function findNewestEstimateIdForJob(
  page: Page,
  tenant: Tenant,
  jobId: string,
): Promise<string> {
  const row = await pollForRow(async () => {
    const res = await page.request.get(
      `${API_URL}/api/estimates?jobId=${encodeURIComponent(jobId)}`,
      { headers: tenant.authHeaders },
    );
    if (!res.ok()) return null;
    const list = (await res.json()) as Array<{ id: string; createdAt?: string }>;
    if (list.length === 0) return null;
    return [...list].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
  });
  return row.id;
}

/**
 * Draw a signature on the public approval page's canvas. Copied verbatim
 * from `e2e/journeys/public-estimate-approve-sign.spec.ts` (Codex P1 fix,
 * PR #1087) — see that file's doc-comment for why `page.mouse` (real,
 * hit-tested synthetic input) is used instead of `canvas.dispatchEvent`,
 * and why the bounding box is polled until the sheet's slide-up animation
 * settles before drawing.
 */
export async function drawSignature(page: Page): Promise<void> {
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  let box = await canvas.boundingBox();
  for (let i = 0; i < 40 && box; i++) {
    await page.waitForTimeout(50);
    const next = await canvas.boundingBox();
    if (next && box.x === next.x && box.y === next.y && box.width === next.width) {
      box = next;
      break;
    }
    box = next;
  }
  expect(box).not.toBeNull();
  const points = [
    { x: box!.x + box!.width * 0.2, y: box!.y + box!.height * 0.5 },
    { x: box!.x + box!.width * 0.35, y: box!.y + box!.height * 0.35 },
    { x: box!.x + box!.width * 0.5, y: box!.y + box!.height * 0.65 },
    { x: box!.x + box!.width * 0.65, y: box!.y + box!.height * 0.4 },
  ];
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const p of points.slice(1)) {
    await page.mouse.move(p.x, p.y, { steps: 5 });
  }
  await page.mouse.up();
  await expect(page.getByRole('button', { name: /^Clear$/i })).toBeVisible({ timeout: 5_000 });
}

/** #1133 workaround — poll a just-created resource by id before a dependent
 * call, since the create transaction commits on res.finish (after the
 * response is flushed). */
export async function pollForRow<T>(
  fn: () => Promise<T | null | undefined>,
  // 2s is the #1133 note's expectation; with three lanes' stacks on one Mac
  // a just-created customer's GET 404'd for the whole 2s window (7.10 run
  // 2: seven consecutive 404s). Allow 10s and REPORT anything over 2s so
  // the observed commit lag lands in the PR body as evidence, not silence.
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) {
      const took = Date.now() - start;
      if (took > 2_000) {
        // eslint-disable-next-line no-console
        console.log(`[8.7 #1133] read-after-write lag: row readable after ${took}ms (> the 2s the workaround assumes)`);
      }
      return v;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pollForRow timed out after ${timeoutMs}ms (#1133 workaround)`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
