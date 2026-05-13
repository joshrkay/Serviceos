#!/usr/bin/env tsx
/**
 * qa-mint-tokens — mint HMAC-signed JWTs for the QA runbook.
 *
 * The deployed API verifies JWTs with HMAC-SHA256 using its CLERK_SECRET_KEY
 * (see packages/api/src/auth/clerk.ts — not the real Clerk SDK). The QA
 * matrix already mints its own tokens via e2e/qa-matrix/fixtures/tokens.ts;
 * this script does the same thing for the **qa-runner** harness, which
 * powers Sections 1–17 of docs/beta-verification-runbook.md and expects
 * `AUTH_BEARER_TOKEN` (Tenant A) and `TENANT_B_TOKEN` (Tenant B).
 *
 * Required env:
 *   E2E_CLERK_HMAC_SECRET   same value the deployed API reads as CLERK_SECRET_KEY
 *   E2E_TENANT_A_ID         Tenant A UUID (from the seed)
 *   E2E_TENANT_B_ID         Tenant B UUID (from the seed)
 *
 * Output (stdout, paste-into-shell shape):
 *   export AUTH_BEARER_TOKEN=<jwt-for-tenant-A>
 *   export TENANT_B_TOKEN=<jwt-for-tenant-B>
 *   export TENANT_ID=<tenant-A-uuid>
 *   export TENANT_A_CUSTOMER_ID=<from env if set>
 *   export TENANT_A_JOB_ID=<from env if set>
 *   export TENANT_A_ESTIMATE_ID=<from env if set>
 *
 * Usage:
 *   npx tsx scripts/qa-mint-tokens.ts
 *   # or with eval to apply directly:
 *   eval "$(npx tsx scripts/qa-mint-tokens.ts)"
 */

import * as crypto from 'node:crypto';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`Missing required env var: ${name}\n`);
    process.stderr.write(
      'Set it from Railway → serviceosapi-development → Variables (for E2E_CLERK_HMAC_SECRET = CLERK_SECRET_KEY), ' +
        'or from the seed output (for E2E_TENANT_*_ID).\n'
    );
    process.exit(1);
  }
  return v;
}

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function mintToken(secret: string, tenantId: string, label: string, role = 'owner'): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: `qa-runbook-user-${label}`,
    sid: `qa-runbook-session-${label}-${Date.now()}`,
    tenant_id: tenantId,
    role,
    exp: Math.floor(Date.now() / 1000) + 60 * 60, // 1h
    iat: Math.floor(Date.now() / 1000),
  };
  const input = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}`;
  const sig = crypto.createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${sig}`;
}

function main(): void {
  const secret = requireEnv('E2E_CLERK_HMAC_SECRET');
  const tenantAId = requireEnv('E2E_TENANT_A_ID');
  const tenantBId = requireEnv('E2E_TENANT_B_ID');

  const tokenA = mintToken(secret, tenantAId, 'A');
  const tokenB = mintToken(secret, tenantBId, 'B');

  // Lines the qa-runner expects (see qa-runner/config/env.example).
  // We re-export the seed's E2E_TENANT_A_*_ID values under the names
  // qa-runner reads (TENANT_A_*_ID), so a single seed feeds both harnesses.
  const lines = [
    `export AUTH_BEARER_TOKEN=${tokenA}`,
    `export TENANT_B_TOKEN=${tokenB}`,
    `export TENANT_ID=${tenantAId}`,
  ];

  // Optional pass-throughs. The qa-runner skips its cross-tenant rows
  // cleanly when these are absent, so we only emit them when present.
  const passthroughs: Array<[string, string]> = [
    ['TENANT_A_CUSTOMER_ID', 'E2E_TENANT_A_CUSTOMER_ID'],
    ['TENANT_A_JOB_ID', 'E2E_TENANT_A_JOB_ID'],
    ['TENANT_A_ESTIMATE_ID', 'E2E_TENANT_A_ESTIMATE_ID'],
    ['TENANT_A_INVOICE_ID', 'E2E_TENANT_A_INVOICE_ID'],
  ];
  for (const [outName, inName] of passthroughs) {
    const v = process.env[inName];
    if (v) lines.push(`export ${outName}=${v}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

main();
