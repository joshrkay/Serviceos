/**
 * Shared helpers for the §8.8 Bill rung-5 reachability specs (map #995,
 * ticket #1022/#1023). Copies e2e/journeys/public-invoice-pay-link.spec.ts's
 * bootstrap/signing idioms verbatim (that file's own header documents why
 * each piece is shaped the way it is) so every spec in this lane doesn't
 * re-derive them.
 */
import { APIRequestContext, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { Client } from 'pg';

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

export const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function unsignedJwt(sub: string): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    sub,
    sid: 'dev-session',
    role: 'owner',
  })}.x`;
}

export function signSvix(rawBody: string, svixId: string, svixTimestamp: string): string {
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest('base64');
  return `v1,${sig}`;
}

/** Stripe-shaped webhook signature — same recipe as webhook-handler.ts's createWebhookSignature. */
export function stripeSignature(rawBody: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

export interface Tenant {
  tenantId: string;
  authHeaders: { Authorization: string };
  /** For e2e/helpers/clerk-stub.ts's installClerkStub({ sub, token }) — drives an authenticated owner browser session bound to this SAME tenant. */
  ownerSub: string;
  jwt: string;
}

export async function bootstrapOwner(
  request: APIRequestContext,
  label: string,
  businessName: string,
): Promise<Tenant> {
  const ownerSub = `user_e2e_888_${label}_${randomUUID().replace(/-/g, '')}`;
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

  return { tenantId, authHeaders, ownerSub, jwt };
}

export interface SeededJob {
  customerId: string;
  locationId: string;
  jobId: string;
}

export async function seedCustomerJob(
  request: APIRequestContext,
  tenant: Tenant,
  customerLabel: string,
  jobSummary: string,
): Promise<SeededJob> {
  const customerRes = await request.post(`${API_URL}/api/customers`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      firstName: customerLabel,
      lastName: 'Customer',
      email: `${customerLabel.toLowerCase().replace(/[^a-z0-9]/g, '')}-${randomUUID().slice(0, 8)}@example.test`,
      preferredChannel: 'email',
    }),
  });
  expect(customerRes.ok(), `create customer -> ${customerRes.status()}`).toBeTruthy();
  const customer = (await customerRes.json()) as { id: string };
  // #1133 workaround — the create transaction commits on res.finish, after
  // the 201 is flushed; poll before the dependent (FK-referencing) call.
  await pollUntilOk(request, `${API_URL}/api/customers/${customer.id}`, tenant.authHeaders);

  const locationRes = await request.post(`${API_URL}/api/locations`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      customerId: customer.id,
      street1: '1 Bill Section Way',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      isPrimary: true,
    }),
  });
  expect(locationRes.ok(), `create location -> ${locationRes.status()}`).toBeTruthy();
  const location = (await locationRes.json()) as { id: string };
  // #1133 workaround (see the comment above).
  await pollUntilOk(request, `${API_URL}/api/locations/${location.id}`, tenant.authHeaders);

  const jobRes = await request.post(`${API_URL}/api/jobs`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      customerId: customer.id,
      locationId: location.id,
      summary: jobSummary,
    }),
  });
  expect(jobRes.ok(), `create job -> ${jobRes.status()}`).toBeTruthy();
  const job = (await jobRes.json()) as { id: string };
  // #1133 workaround (see the comment above) — callers immediately create
  // an estimate/invoice referencing this job.
  await pollUntilOk(request, `${API_URL}/api/jobs/${job.id}`, tenant.authHeaders);

  return { customerId: customer.id, locationId: location.id, jobId: job.id };
}

export interface SeededInvoice {
  invoiceId: string;
  totalCents: number;
}

/** Create + issue a real invoice (draft -> open) at the given total. */
export async function seedIssuedInvoice(
  request: APIRequestContext,
  tenant: Tenant,
  jobId: string,
  totalCents: number,
  opts?: { paymentTermDays?: number; description?: string },
): Promise<SeededInvoice> {
  const invoiceRes = await request.post(`${API_URL}/api/invoices`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({
      jobId,
      lineItems: [
        {
          id: randomUUID(),
          description: opts?.description ?? 'Service call',
          quantity: 1,
          unitPriceCents: totalCents,
          totalCents,
          sortOrder: 0,
          taxable: false,
        },
      ],
    }),
  });
  expect(invoiceRes.ok(), `create invoice -> ${invoiceRes.status()} ${await invoiceRes.text()}`).toBeTruthy();
  const invoice = (await invoiceRes.json()) as { id: string };
  // #1133 workaround (see seedCustomerJob's identical comment).
  await pollUntilOk(request, `${API_URL}/api/invoices/${invoice.id}`, tenant.authHeaders);

  const issueRes = await request.post(`${API_URL}/api/invoices/${invoice.id}/issue`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify(
      opts?.paymentTermDays !== undefined ? { paymentTermDays: opts.paymentTermDays } : {},
    ),
  });
  expect(issueRes.ok(), `issue invoice -> ${issueRes.status()} ${await issueRes.text()}`).toBeTruthy();

  return { invoiceId: invoice.id, totalCents };
}

/** #1133 workaround — poll a GET route until it 200s (commit lands after res.finish). */
export async function pollUntilOk(
  request: APIRequestContext,
  url: string,
  headers: Record<string, string>,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const res = await request.get(url, { headers });
    if (res.ok()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`#1133 poll timed out: ${url} never 200'd (last ${res.status()})`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** RLS-scoped read against real Postgres, mirroring e2e/qa-matrix/helpers/rw-db.ts. */
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

/**
 * Narrow, precedented exception (see e2e/qa-matrix/invoices.spec.ts:369 and
 * e2e/qa-matrix/payments-edge.spec.ts:212, both of which do exactly this):
 * there is NO product route that back-dates a due date — no real owner
 * action ever should — so simulating "N days overdue" without moving the
 * wall clock has no other honest path. Scoped to the CLOCK field only, on a
 * row this same test already created/issued through the real API; no
 * money/audit state is touched by this call.
 */
export async function backdateInvoiceDueDate(
  tenantId: string,
  invoiceId: string,
  daysPastDue: number,
): Promise<void> {
  await queryAsTenant(
    tenantId,
    `UPDATE invoices SET due_date = now() - interval '${daysPastDue} days' WHERE id = $1 AND tenant_id = $2`,
    [invoiceId, tenantId],
  );
}

/** Poll a query until it returns at least one row (or timeoutMs elapses). */
export async function pollRows(
  tenantId: string,
  sql: string,
  params: unknown[],
  opts: { timeoutMs?: number; minRows?: number } = {},
): Promise<Record<string, unknown>[]> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const minRows = opts.minRows ?? 1;
  const start = Date.now();
  for (;;) {
    const rows = await queryAsTenant(tenantId, sql, params);
    if (rows.length >= minRows) return rows;
    if (Date.now() - start > timeoutMs) return rows;
    await new Promise((r) => setTimeout(r, 300));
  }
}
