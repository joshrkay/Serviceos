/**
 * Clerk test-mode token + tenant fixture loader.
 *
 * The matrix needs two tenants (A and B) with independent Clerk sessions to
 * exercise cross-tenant isolation. Tokens are loaded from env at test time so
 * rotation does not touch source.
 *
 * Required env (per qa/README.md):
 *   E2E_CLERK_TEST_TOKEN_A, E2E_TENANT_A_ID, E2E_TENANT_A_CUSTOMER_ID, E2E_TENANT_A_JOB_ID
 *   E2E_CLERK_TEST_TOKEN_B, E2E_TENANT_B_ID, E2E_TENANT_B_CUSTOMER_ID, E2E_TENANT_B_JOB_ID
 */

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

export function tenantA(): TenantFixture {
  return {
    label: 'A',
    token: requireEnv('E2E_CLERK_TEST_TOKEN_A'),
    tenantId: requireEnv('E2E_TENANT_A_ID'),
    customerId: requireEnv('E2E_TENANT_A_CUSTOMER_ID'),
    jobId: requireEnv('E2E_TENANT_A_JOB_ID'),
  };
}

export function tenantB(): TenantFixture {
  return {
    label: 'B',
    token: requireEnv('E2E_CLERK_TEST_TOKEN_B'),
    tenantId: requireEnv('E2E_TENANT_B_ID'),
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
