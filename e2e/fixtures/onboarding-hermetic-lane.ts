/**
 * Shared bootstrap primitives for the §8.1 Setup rung-5 reachability specs
 * (1.1, 1.3, 1.4, 1.5, 1.7, 1.9). Extracted from the exact pattern already
 * proven in e2e/journeys/onboarding-identity.spec.ts (1.2/1.8) — copied
 * verbatim rather than imported from that file so the already-landed 1.2/1.8
 * spec is never touched by this lane (zero regression risk to a spec another
 * lane's rung-5 grade already depends on).
 *
 * Every helper here drives the REAL running Playwright webServer (real
 * Express app, real Postgres via DATABASE_URL) — never a mock.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

export const CLERK_WEBHOOK_SECRET =
  process.env.E2E_CLERK_WEBHOOK_SECRET ??
  'whsec_dGVzdC1zaWdudXAtY3JpdGljYWwtcGF0aA==';

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

/**
 * Posts a Clerk-shaped `user.created` webhook signed exactly like real
 * Clerk/svix signs it. `svixId`/`svixTimestamp` are overridable so callers
 * can drive genuine-redelivery (distinct svix id, same Clerk user) and
 * stale-timestamp (1.1) scenarios against the real `/webhooks/clerk` router.
 */
export async function postSignedWebhook(
  request: APIRequestContext,
  body: Record<string, unknown>,
  opts?: { svixId?: string; svixTimestamp?: string },
) {
  const svixId = opts?.svixId ?? `evt_${randomUUID()}`;
  const svixTimestamp = opts?.svixTimestamp ?? String(Math.floor(Date.now() / 1000));
  const rawBody = JSON.stringify(body);
  return request.post(`${API_URL}/webhooks/clerk`, {
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': signSvix(rawBody, svixId, svixTimestamp),
    },
    data: rawBody,
  });
}

export interface BootstrappedOwner {
  sub: string;
  jwt: string;
  authHeaders: Record<string, string>;
  tenantId: string;
}

/** Bootstraps a brand-new tenant/owner through the real signed Clerk webhook. */
export async function bootstrapOwner(page: Page, label: string): Promise<BootstrappedOwner> {
  const sub = `user_e2e_${label}_${randomUUID().replace(/-/g, '')}`;
  const email = `${label}-${Date.now()}@serviceos-hermetic.test`;
  const jwt = unsignedJwt(sub);
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const webhookRes = await postSignedWebhook(page.request, {
    type: 'user.created',
    data: { id: sub, email_addresses: [{ email_address: email }] },
  });
  expect(webhookRes.status(), `${label} bootstrap webhook -> ${await webhookRes.text()}`).toBe(200);

  const meRes = await page.request.get(`${API_URL}/api/me`, { headers: authHeaders });
  expect(meRes.status()).toBe(200);
  const me = (await meRes.json()) as { tenant_id?: string };
  expect(me.tenant_id).toMatch(UUID_RE);

  return { sub, jwt, authHeaders, tenantId: me.tenant_id! };
}

/** Writes a psql SELECT's raw output under docs/audit/lane-reports/<dir>/<label>.snapshot.txt. */
export function pollDbSnapshot(dir: string, label: string, sql: string): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;
  const outDir = `docs/audit/lane-reports/${dir}`;
  try {
    mkdirSync(outDir, { recursive: true });
  } catch {
    // best-effort
  }
  try {
    const out = execFileSync('psql', [databaseUrl, '-c', sql], { encoding: 'utf8' });
    writeFileSync(`${outDir}/${label}.snapshot.txt`, out);
  } catch (err) {
    writeFileSync(
      `${outDir}/${label}.snapshot.txt`,
      `psql poll failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Single scalar value (tab/aligned-off), trimmed. Null when DATABASE_URL is unset. */
export function queryOne(sql: string): string | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const out = execFileSync(
    'psql',
    [databaseUrl, '-t', '-A', '-F', '\t', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
  return out || null;
}

/** All rows of a single-column psql query, trimmed, non-empty lines only. */
export function queryColumn(sql: string): string[] {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return [];
  return execFileSync('psql', [databaseUrl, '-t', '-A', '-c', sql], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
}
