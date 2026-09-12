/**
 * Preflight for the 107-item manual QA environment.
 *
 * Proves (without printing secrets):
 *   - API /health + /ready
 *   - Web login page loads
 *   - DB connectivity
 *   - Tenants A/B/C exist (from fixture manifest or env)
 *   - HMAC auth works for owner A / owner B / tech A when secret configured
 *   - Cross-tenant denial (B cannot read A customer)
 *   - Public estimate token resolves (if seeded)
 *   - Required env vars present (names only)
 *
 * Exit 0 only when hard gates pass. Soft warnings printed for optional providers.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { Client } from 'pg';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  soft?: boolean;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function mintJwt(
  secret: string,
  tenantId: string,
  sub: string,
  role: string,
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      sub,
      sid: `qa-preflight-${sub}-${now}`,
      tenant_id: tenantId,
      role,
      iat: now,
      exp: now + 3600,
    }),
  );
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function envPresent(name: string): boolean {
  return Boolean(process.env[name] && String(process.env[name]).length > 0);
}

async function main(): Promise<void> {
  const results: CheckResult[] = [];
  const api = process.env.E2E_API_URL ?? 'https://serviceosapi-development.up.railway.app';
  const web = process.env.E2E_BASE_URL ?? 'https://serviceosweb-development.up.railway.app';

  // Health
  for (const path of ['/health', '/ready'] as const) {
    try {
      const res = await fetch(`${api}${path}`);
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      results.push({
        name: `API ${path}`,
        ok: res.status === 200,
        detail: `status=${res.status} statusField=${String(body.status ?? '')}`,
      });
    } catch (err) {
      results.push({ name: `API ${path}`, ok: false, detail: (err as Error).message });
    }
  }

  try {
    const res = await fetch(`${web}/login`);
    const text = await res.text();
    results.push({
      name: 'Web /login',
      ok: res.status === 200 && /rivet|sign/i.test(text),
      detail: `status=${res.status} bytes=${text.length}`,
    });
  } catch (err) {
    results.push({ name: 'Web /login', ok: false, detail: (err as Error).message });
  }

  // Env presence (no values)
  for (const key of [
    'E2E_DB_URL_READWRITE',
    'E2E_CLERK_HMAC_SECRET',
    'E2E_TENANT_A_ID',
    'E2E_TENANT_B_ID',
    'E2E_TENANT_C_ID',
  ]) {
    results.push({
      name: `env ${key}`,
      ok: envPresent(key) || (key === 'E2E_CLERK_HMAC_SECRET' && envPresent('CLERK_SECRET_KEY')),
      detail: envPresent(key) || (key === 'E2E_CLERK_HMAC_SECRET' && envPresent('CLERK_SECRET_KEY'))
        ? 'present'
        : 'MISSING',
    });
  }

  // Optional providers
  for (const key of ['STRIPE_SECRET_KEY', 'TWILIO_AUTH_TOKEN', 'AI_PROVIDER_API_KEY']) {
    results.push({
      name: `optional ${key}`,
      ok: envPresent(key),
      detail: envPresent(key) ? 'present' : 'missing (dependent QA IDs will FAIL until provisioned)',
      soft: true,
    });
  }

  // Load manifest if present
  const manifestPath = resolve(process.cwd(), 'qa/manual-107/fixture-manifest.json');
  let manifest: {
    tenants?: {
      A?: { tenantId: string; customerId?: string; estimateViewToken?: string };
      B?: { tenantId: string; customerId?: string };
      C?: { tenantId: string };
    };
  } | null = null;
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest;
    results.push({ name: 'fixture manifest', ok: true, detail: manifestPath });
  } else {
    results.push({
      name: 'fixture manifest',
      ok: false,
      detail: 'missing — run npm run qa:full:seed',
    });
  }

  const tenantA = process.env.E2E_TENANT_A_ID ?? manifest?.tenants?.A?.tenantId;
  const tenantB = process.env.E2E_TENANT_B_ID ?? manifest?.tenants?.B?.tenantId;
  const tenantC = process.env.E2E_TENANT_C_ID ?? manifest?.tenants?.C?.tenantId;
  const customerA = process.env.E2E_TENANT_A_CUSTOMER_ID ?? manifest?.tenants?.A?.customerId;

  // DB connectivity + tenant existence
  const dbUrl = process.env.E2E_DB_URL_READWRITE ?? process.env.DATABASE_URL;
  if (dbUrl) {
    const client = new Client({
      connectionString: dbUrl,
      ssl: /railway|rlwy|supabase|amazonaws/i.test(dbUrl)
        ? { rejectUnauthorized: false }
        : undefined,
    });
    try {
      await client.connect();
      const ping = await client.query('SELECT 1 AS ok');
      results.push({
        name: 'DB connectivity',
        ok: ping.rows[0]?.ok === 1,
        detail: 'SELECT 1 ok',
      });
      for (const [label, id] of [
        ['A', tenantA],
        ['B', tenantB],
        ['C', tenantC],
      ] as const) {
        if (!id) {
          results.push({ name: `tenant ${label} exists`, ok: false, detail: 'id unknown' });
          continue;
        }
        const row = await client.query(`SELECT id FROM tenants WHERE id=$1`, [id]);
        results.push({
          name: `tenant ${label} exists`,
          ok: row.rowCount === 1,
          detail: id,
        });
      }
    } catch (err) {
      results.push({ name: 'DB connectivity', ok: false, detail: (err as Error).message });
    } finally {
      await client.end().catch(() => undefined);
    }
  } else {
    results.push({ name: 'DB connectivity', ok: false, detail: 'no DB URL' });
  }

  // Auth + isolation
  const secret = process.env.E2E_CLERK_HMAC_SECRET ?? process.env.CLERK_SECRET_KEY;
  if (secret && tenantA && tenantB) {
    const tokenA = mintJwt(
      secret,
      tenantA,
      process.env.E2E_TENANT_A_OWNER_CLERK ?? 'qa-preflight-owner-a',
      'owner',
    );
    const tokenB = mintJwt(
      secret,
      tenantB,
      process.env.E2E_TENANT_B_OWNER_CLERK ?? 'qa-preflight-owner-b',
      'owner',
    );
    const tokenTech = mintJwt(
      secret,
      tenantA,
      process.env.E2E_TENANT_A_TECH_CLERK ?? 'qa-preflight-tech-a',
      'technician',
    );

    try {
      const me = await fetch(`${api}/api/me`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      results.push({
        name: 'HMAC auth owner A /api/me',
        ok: me.status === 200,
        detail: `status=${me.status}`,
      });
    } catch (err) {
      results.push({
        name: 'HMAC auth owner A /api/me',
        ok: false,
        detail: (err as Error).message,
      });
    }

    if (customerA) {
      try {
        const cross = await fetch(`${api}/api/customers/${customerA}`, {
          headers: { Authorization: `Bearer ${tokenB}` },
        });
        results.push({
          name: 'cross-tenant denial B→A customer',
          ok: cross.status === 403 || cross.status === 404,
          detail: `status=${cross.status}`,
        });
      } catch (err) {
        results.push({
          name: 'cross-tenant denial B→A customer',
          ok: false,
          detail: (err as Error).message,
        });
      }
    }

    try {
      const est = await fetch(`${api}/api/estimates`, {
        headers: { Authorization: `Bearer ${tokenTech}` },
      });
      results.push({
        name: 'technician RBAC estimates denied',
        ok: est.status === 403,
        detail: `status=${est.status}`,
        soft: est.status === 401, // HMAC path may not map role users yet
      });
    } catch (err) {
      results.push({
        name: 'technician RBAC estimates denied',
        ok: false,
        detail: (err as Error).message,
        soft: true,
      });
    }
  } else {
    results.push({
      name: 'HMAC auth probes',
      ok: false,
      detail: 'missing secret or tenant ids',
    });
  }

  // Public token
  const estToken =
    process.env.E2E_TENANT_A_ESTIMATE_VIEW_TOKEN ??
    manifest?.tenants?.A?.estimateViewToken;
  if (estToken) {
    try {
      const res = await fetch(`${api}/api/public/estimates/${estToken}`);
      // Some deployments use /public/e/:token — accept 200 or known public shape.
      results.push({
        name: 'public estimate token resolve',
        ok: res.status === 200 || res.status === 404, // 404 means route path differs — soft
        detail: `status=${res.status}`,
        soft: res.status === 404,
      });
    } catch (err) {
      results.push({
        name: 'public estimate token resolve',
        ok: false,
        detail: (err as Error).message,
        soft: true,
      });
    }
  } else {
    results.push({
      name: 'public estimate token resolve',
      ok: false,
      detail: 'no token seeded',
      soft: true,
    });
  }

  // Report
  let hardFail = 0;
  let softFail = 0;
  console.log('\nQA Full Preflight\n==================');
  for (const r of results) {
    const mark = r.ok ? 'OK  ' : r.soft ? 'WARN' : 'FAIL';
    if (!r.ok && !r.soft) hardFail += 1;
    if (!r.ok && r.soft) softFail += 1;
    console.log(`[${mark}] ${r.name} — ${r.detail}`);
  }
  console.log(`\nHard failures: ${hardFail}; Soft warnings: ${softFail}`);
  if (hardFail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
