/**
 * Mint HMAC JWTs for full-QA roles (owner/dispatcher/technician × tenants).
 * Requires CLERK_DEV_HMAC_TOKENS=true on the target API.
 *
 * Usage (after sourcing .env.qa.full.local):
 *   E2E_CLERK_HMAC_SECRET=... npx tsx scripts/qa-full-mint.ts
 */
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function mint(
  secret: string,
  tenantId: string,
  sub: string,
  role: string,
  label: string,
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      sub,
      sid: `qa-full-${label}-${now}`,
      tenant_id: tenantId,
      role,
      iat: now,
      exp: now + 60 * 60 * 8,
    }),
  );
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function main(): void {
  const secret = process.env.E2E_CLERK_HMAC_SECRET ?? process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error('Set E2E_CLERK_HMAC_SECRET or CLERK_SECRET_KEY');

  const pairs: Array<[string, string, string, string]> = [
    ['E2E_TOKEN_A_OWNER', req('E2E_TENANT_A_ID'), process.env.E2E_TENANT_A_OWNER_CLERK ?? 'qa-full-a-owner', 'owner'],
    ['E2E_TOKEN_A_DISPATCHER', req('E2E_TENANT_A_ID'), process.env.E2E_TENANT_A_DISPATCHER_CLERK ?? 'qa-full-a-dispatcher', 'dispatcher'],
    ['E2E_TOKEN_A_TECH', req('E2E_TENANT_A_ID'), process.env.E2E_TENANT_A_TECH_CLERK ?? 'qa-full-a-tech', 'technician'],
    ['E2E_TOKEN_B_OWNER', req('E2E_TENANT_B_ID'), process.env.E2E_TENANT_B_OWNER_CLERK ?? 'qa-full-b-owner', 'owner'],
    ['E2E_TOKEN_C_OWNER', req('E2E_TENANT_C_ID'), process.env.E2E_TENANT_C_OWNER_CLERK ?? 'qa-full-c-owner', 'owner'],
  ];

  const lines: string[] = [
    `# Minted ${new Date().toISOString()} — DO NOT COMMIT`,
  ];
  for (const [envName, tenantId, sub, role] of pairs) {
    const jwt = mint(secret, tenantId, sub, role, envName);
    lines.push(`export ${envName}=${jwt}`);
    console.log(`export ${envName}=<redacted len=${jwt.length} role=${role} tenant=${tenantId.slice(0, 8)}…>`);
  }

  const out = resolve(process.cwd(), '.env.qa.full.tokens');
  writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(`\nWrote tokens to ${out} (gitignored). Source it for API probes.`);
  // Also print real exports for shell eval when QA_PRINT_TOKENS=1 (local only)
  if (process.env.QA_PRINT_TOKENS === '1') {
    for (const line of lines) {
      if (line.startsWith('export ')) console.log(line);
    }
  }
}

main();
