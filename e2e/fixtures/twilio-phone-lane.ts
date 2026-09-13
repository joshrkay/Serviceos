/**
 * Shared helpers for the #1015 §8.3 Book phone-surface rung-5 specs (3.1,
 * 3.7, 3.10). Copies the idioms of e2e/telephony-e1-signed-webhook.spec.ts
 * verbatim (provisioning shape, signedPost, sessionIdFromTwiml) so the three
 * new specs don't each re-derive them — see that file's own header for why
 * each piece is shaped the way it is (trailing-slash stripping, the DID
 * LIMIT-1-no-ORDER-BY note, the "why not chromium-devauth" note).
 */
import { expect, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import crypto from 'node:crypto';
import twilio from 'twilio';
import { encrypt } from '../../packages/api/src/integrations/crypto';

export const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

export const API_URL = stripTrailingSlash(process.env.E2E_API_URL ?? 'http://localhost:3000');
export const SIGNING_BASE = stripTrailingSlash(process.env.PUBLIC_API_URL ?? API_URL);

export interface ProvisionedTenant {
  tenantId: string;
  userId: string;
  did: string;
  subaccountSid: string;
  authToken: string;
  /** #1017 §8.4 — the business_name actually written to tenant_settings. */
  businessName: string;
}

/**
 * Provision a tenant exactly as e2e/telephony-e1-signed-webhook.spec.ts's
 * `provision()` does: an owner, business settings (with
 * `voice_agent_live_at` so `createVoiceGate` lets the call through), and one
 * `tenant_integrations` row carrying the DID, subaccount SID, and encrypted
 * auth token. Returns `userId` too (the pattern spec doesn't need it — this
 * lane does, to mint a dev-auth-bypass bearer token for the SAME owner so
 * the approve route resolves this exact tenant via `PgTenantRepository
 * .findByOwner(sub)`, never bootstrapping a fresh one).
 */
export async function provisionTenant(
  pool: Pool,
  encKey: string,
  opts: {
    did: string;
    subaccountSid: string;
    authToken: string;
    ownerPhone?: string;
    /**
     * #1017 §8.4 — override the tenant's `business_name` (default kept as
     * 'Book 8.3 Phone Shop' so every pre-existing §8.3 phone-lane spec is
     * byte-identical). The SMS legs pass a DISTINCT name per tenant so a
     * brand-voice/business-name assertion can tell tenant A's rows from
     * tenant B's.
     */
    businessName?: string;
  },
): Promise<ProvisionedTenant> {
  const tenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const businessName = opts.businessName ?? 'Book 8.3 Phone Shop';
  await pool.query(
    `INSERT INTO tenants (id, owner_id, owner_email, name, subscription_status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [tenantId, userId, `owner+${tenantId.slice(0, 8)}@example.com`, businessName],
  );
  await pool.query(
    `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name)
     VALUES ($1, $2, $3, $4, 'owner', 'Dev', 'Owner')`,
    [userId, tenantId, userId, `owner+${tenantId.slice(0, 8)}@example.com`],
  );
  await pool.query(
    `INSERT INTO tenant_settings (id, tenant_id, business_name, timezone, region, voice_agent_live_at${
      opts.ownerPhone ? ', owner_phone' : ''
    })
     VALUES ($1, $2, $3, 'America/Chicago', 'TX', NOW()${
       opts.ownerPhone ? ', $4' : ''
     })`,
    opts.ownerPhone
      ? [crypto.randomUUID(), tenantId, businessName, opts.ownerPhone]
      : [crypto.randomUUID(), tenantId, businessName],
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    await client.query(
      `INSERT INTO tenant_integrations
         (tenant_id, provider, status, provider_data, subaccount_sid, auth_token_primary_enc)
       VALUES ($1, 'twilio', 'full_readiness', $2::jsonb, $3, $4)`,
      [
        tenantId,
        JSON.stringify({ phoneE164: opts.did }),
        opts.subaccountSid,
        encrypt(opts.authToken, encKey),
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return {
    tenantId,
    userId,
    did: opts.did,
    subaccountSid: opts.subaccountSid,
    authToken: opts.authToken,
    businessName,
  };
}

/** A Twilio-shaped, self-signed webhook POST — see the pattern spec's header. */
export async function signedPost(
  request: APIRequestContext,
  path: string,
  params: Record<string, string>,
  authToken: string,
) {
  const signature = twilio.getExpectedTwilioSignature(authToken, `${SIGNING_BASE}${path}`, params);
  return request.post(`${API_URL}${path}`, {
    headers: {
      'X-Twilio-Signature': signature,
      'content-type': 'application/x-www-form-urlencoded',
    },
    form: params,
  });
}

/** The `<Gather action="…?sid=X">` the /voice or /gather TwiML hands back. */
export function sessionIdFromTwiml(twiml: string): string {
  const m = /[?&]sid=([0-9a-f-]{36})/i.exec(twiml);
  expect(m, `no ?sid= in TwiML: ${twiml}`).not.toBeNull();
  return m![1]!;
}

/**
 * An unsigned Clerk-shaped bearer token for `dev-auth-bypass`
 * (packages/api/src/auth/dev-auth-bypass.ts). The bypass middleware is
 * mounted BEFORE `requireAuth` (app.ts:4572/4592) and decodes the JWT body
 * WITHOUT verifying its signature (hard-gated on
 * NODE_ENV=dev + DEV_AUTH_BYPASS=true, both of which the harness sets) — so
 * this only ever works because the harness runs in that dev mode, same as
 * every other `chromium`-project spec that hits an authenticated route.
 * `sub` must equal the tenant's `owner_id` / the owner user's
 * `clerk_user_id` (both set to the same value by `provisionTenant` above),
 * so `PgTenantRepository.findByOwner(sub)` resolves the SAME tenant instead
 * of bootstrapping a fresh one.
 */
export function devAuthBearerToken(ownerUserId: string, role: 'owner' | 'dispatcher' | 'technician' = 'owner'): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64url({ alg: 'none', typ: 'JWT' });
  const payload = b64url({ sub: ownerUserId, role, sid: `dev-sess-${ownerUserId.slice(0, 8)}` });
  return `${header}.${payload}.unsigned`;
}

/**
 * Poll a query until it returns at least one row (or `timeoutMs` elapses).
 * Proposal APPROVAL only flips `status`; EXECUTION (the appointment write +
 * audit event) runs on a separate sweep/worker in this same process, so
 * asserting on the post-approval side effect requires waiting for it rather
 * than reading immediately after the approve response returns.
 */
export async function pollFor<T extends Record<string, unknown>>(
  pool: Pool,
  sql: string,
  params: unknown[],
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T[]> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<T>(sql, params);
    if (rows.length > 0) return rows;
    if (Date.now() >= deadline) return rows;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
