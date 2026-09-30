/**
 * Real-stack tenant bootstrap for the rung-5 reachability specs (#1015 /
 * #1018 rows 3.7, 3.12, 5.1, 5.2, 5.3). Everything goes through the running
 * API's own routes — the signed Clerk `user.created` webhook creates the
 * tenant + owner, `/api/users/invitations` + the invitee-join webhook create
 * a technician, onboarding identity sets the timezone — the same pattern as
 * e2e/journeys/technician-day-view.spec.ts, factored out so each spec does
 * not carry its own copy. The only direct DB access is a read-only SELECT of
 * the new tenant's id (the HMAC session token must carry it).
 *
 * Sessions are HMAC-signed (CLERK_DEV_HMAC_TOKENS=true), which both the
 * `chromium` pair (DEV_AUTH_BYPASS) and the `chromium-noauthbypass` pair
 * verify, so a spec works on either.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { installClerkStub } from './clerk-stub';
import { blockExternalHosts } from './api-mocks/shell';

const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ?? 'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function hmacToken(sub: string, tenantId: string, role: string): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub,
    sid: `e2e-session-${sub}`,
    tenant_id: tenantId,
    role,
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  };
  const input = `${b64url(header)}.${b64url(payload)}`;
  const sig = createHmac('sha256', Buffer.from('')).update(input).digest('base64url');
  return `${input}.${sig}`;
}

async function postSignedWebhook(request: APIRequestContext, apiUrl: string, body: Record<string, unknown>) {
  const svixId = `evt_${randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(body);
  const secret = Buffer.from(CLERK_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', secret).update(`${svixId}.${svixTimestamp}.${rawBody}`).digest('base64');
  return request.post(`${apiUrl}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': `v1,${sig}`,
    },
    data: rawBody,
  });
}

export async function postJson<T = { id: string }>(
  request: APIRequestContext,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<T> {
  const res = await request.post(url, {
    headers: { 'content-type': 'application/json', ...headers },
    data: JSON.stringify(body),
  });
  expect(res.ok(), `POST ${url} -> ${res.status()}: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

export interface RealOwner {
  tenantId: string;
  sub: string;
  token: string;
  headers: Record<string, string>;
}

/** A fresh tenant + owner through the real Clerk webhook and onboarding identity. */
export async function bootstrapOwner(
  request: APIRequestContext,
  apiUrl: string,
  pool: Pool,
  label: string,
  timezone = 'America/Chicago',
): Promise<RealOwner> {
  const sub = `user_e2e_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `${label}-${Date.now()}@serviceos-hermetic.test`;
  const webhookRes = await postSignedWebhook(request, apiUrl, {
    type: 'user.created',
    data: { id: sub, email_addresses: [{ email_address: email }] },
  });
  expect(webhookRes.status(), `${label} bootstrap webhook -> ${await webhookRes.text()}`).toBe(200);

  let tenantId = '';
  await expect
    .poll(async () => {
      const { rows } = await pool.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM users WHERE clerk_user_id = $1 LIMIT 1`,
        [sub],
      );
      tenantId = rows[0]?.tenant_id ?? '';
      return tenantId;
    })
    .toMatch(UUID_RE);

  const token = hmacToken(sub, tenantId, 'owner');
  const headers = { Authorization: `Bearer ${token}` };
  const identityRes = await request.put(`${apiUrl}/api/onboarding/identity`, {
    headers: { 'content-type': 'application/json', ...headers },
    data: JSON.stringify({
      businessName: `Rung5 ${label.toUpperCase()} Co`,
      businessHours: Object.fromEntries(
        ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: '00:00', close: '23:59' }]),
      ),
      jobBufferMinutes: 0,
      hourlyRateCents: 12500,
      timezone,
    }),
  });
  expect(identityRes.ok(), `PUT /api/onboarding/identity (${label}) -> ${identityRes.status()}`).toBeTruthy();
  return { tenantId, sub, token, headers };
}

export interface RealTechnician {
  sub: string;
  token: string;
  techId: string;
  headers: Record<string, string>;
}

/** A technician invited by the owner and joined through the invitee webhook. */
export async function inviteTechnician(
  request: APIRequestContext,
  apiUrl: string,
  owner: RealOwner,
  label: string,
): Promise<RealTechnician> {
  const email = `${label}-${Date.now()}@serviceos-hermetic.test`;
  const invite = await postJson<{ id: string }>(request, `${apiUrl}/api/users/invitations`, owner.headers, {
    email,
    role: 'technician',
  });
  const sub = `user_e2e_${label}_${randomUUID().replace(/-/g, '')}`;
  const joinRes = await postSignedWebhook(request, apiUrl, {
    type: 'user.created',
    data: {
      id: sub,
      email_addresses: [{ email_address: email }],
      public_metadata: { invitation_id: invite.id, tenant_id: owner.tenantId, role: 'technician' },
    },
  });
  expect(joinRes.status(), `invitee-join webhook (${label}) -> ${await joinRes.text()}`).toBe(200);
  const token = hmacToken(sub, owner.tenantId, 'technician');
  const headers = { Authorization: `Bearer ${token}` };
  const meRes = await request.get(`${apiUrl}/api/me`, { headers });
  expect(meRes.status(), `technician /api/me (${label}) -> ${await meRes.text()}`).toBe(200);
  const me = (await meRes.json()) as { internal_user_id?: string };
  expect(me.internal_user_id).toMatch(UUID_RE);
  return { sub, token, techId: me.internal_user_id!, headers };
}

/** Sign the browser in as `sub` (HMAC session) and silence the walkthrough modals. */
export async function signInBrowser(page: Page, baseURL: string, sub: string, token: string): Promise<void> {
  await installClerkStub(page, { signedIn: true, sub, token });
  await page.addInitScript(() => {
    try {
      localStorage.setItem('walkthrough.welcome.v1', '1');
      localStorage.setItem('walkthrough.whatsnew.lastSeen', '2026-06-21-onboarding');
    } catch {
      /* private mode */
    }
  });
  await blockExternalHosts(page, baseURL);
}

/** Tenant-local wall clock → UTC instant (same arithmetic as technician-day-view.spec.ts). */
export function tenantWallClockToUtc(date: string, time: string, timezone: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h = 0, mi = 0] = time.split(':').map(Number);
  const wallClockAsUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offsetAt = (ts: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ts));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - ts;
  };
  let ts = wallClockAsUtc - offsetAt(wallClockAsUtc);
  ts = wallClockAsUtc - offsetAt(ts);
  return new Date(ts);
}

export function todayInTz(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}
