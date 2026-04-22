/**
 * Token + tenant fixture loader.
 *
 * The API's auth (packages/api/src/auth/clerk.ts) is NOT the standard Clerk
 * SDK — it's a custom HMAC-SHA256 JWT verifier. Tokens carry their claims
 * (sub, sid, tenant_id, role, exp) directly in the payload and are signed
 * with the API's CLERK_SECRET_KEY.
 *
 * For QA, we mint tokens on demand from the same shared secret. That means
 * no Clerk backend calls and no pre-provisioned users — just the secret
 * plus the two seeded tenant IDs.
 *
 * Required env:
 *   E2E_CLERK_HMAC_SECRET   same value the deployed API reads as CLERK_SECRET_KEY
 *   E2E_TENANT_A_ID / _CUSTOMER_ID / _JOB_ID   (from fixtures/seed.ts)
 *   E2E_TENANT_B_ID / _CUSTOMER_ID / _JOB_ID
 *   E2E_API_URL, E2E_BASE_URL, E2E_DB_URL_READONLY
 */

import * as crypto from 'node:crypto';

export interface TenantFixture {
  label: 'A' | 'B';
  token: string;
  tenantId: string;
  customerId: string;
  jobId: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}. See qa/README.md.`);
  return v;
}

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Build a short-lived JWT matching the shape decodeClerkToken() expects.
 * Roles follow the existing enum: 'owner' | 'dispatcher' | 'technician'.
 */
export function mintToken(tenantId: string, label: 'A' | 'B'): string {
  const secret = requireEnv('E2E_CLERK_HMAC_SECRET');
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: `qa-matrix-user-${label}`,
    sid: `qa-matrix-session-${label}-${Date.now()}`,
    tenant_id: tenantId,
    role: 'owner',
    exp: Math.floor(Date.now() / 1000) + 60 * 60, // 1h
    iat: Math.floor(Date.now() / 1000),
  };
  const input = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}`;
  const sig = crypto.createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${sig}`;
}

export function tenantA(): TenantFixture {
  const tenantId = requireEnv('E2E_TENANT_A_ID');
  return {
    label: 'A',
    token: mintToken(tenantId, 'A'),
    tenantId,
    customerId: requireEnv('E2E_TENANT_A_CUSTOMER_ID'),
    jobId: requireEnv('E2E_TENANT_A_JOB_ID'),
  };
}

export function tenantB(): TenantFixture {
  const tenantId = requireEnv('E2E_TENANT_B_ID');
  return {
    label: 'B',
    token: mintToken(tenantId, 'B'),
    tenantId,
    customerId: requireEnv('E2E_TENANT_B_CUSTOMER_ID'),
    jobId: requireEnv('E2E_TENANT_B_JOB_ID'),
  };
}

export function apiBase(): string {
  return requireEnv('E2E_API_URL');
}

export function dbUrl(): string {
  return requireEnv('E2E_DB_URL_READONLY');
}

export function redactTenant(t: TenantFixture): Record<string, string> {
  return {
    label: t.label,
    tenantId: `${t.tenantId.slice(0, 8)}…`,
    customerId: `${t.customerId.slice(0, 8)}…`,
    jobId: `${t.jobId.slice(0, 8)}…`,
  };
}
