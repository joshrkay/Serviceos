/**
 * Bootstrap a Clerk user + tenant for mobile web QA against a live API (e.g.
 * Railway PR preview). Unblocks signed-in visual QA when the Clerk
 * `user.created` webhook did not fire (API-created users, ticket-only sign-in).
 *
 * What it does:
 *   1. Find or create a Clerk user (Backend API) and verify email.
 *   2. bootstrapTenant() on the target Postgres (same DB the API uses).
 *   3. Insert the owner `users` row if missing (webhook only does this for invitees).
 *   4. PATCH Clerk `public_metadata` with `{ tenant_id, role: 'owner' }` so the
 *      `serviceos` JWT template mints a token the API accepts.
 *   5. Optionally seed one customer with a phone for messaging/call QA.
 *
 * Usage (Railway PR preview example):
 *   DATABASE_URL='postgres://...' \
 *   CLERK_SECRET_KEY='sk_test_...' \
 *   npx ts-node packages/api/scripts/bootstrap-mobile-qa-user.ts \
 *     --email 'mobile-qa+clerk_test@serviceos-test.com' \
 *     --password 'MobileQATest!123'
 *
 * Then sign in on the mobile web export (Clerk ticket or password if verification
 * UI is enabled). Point EXPO_PUBLIC_API_URL at the preview API before export.
 */
import { randomUUID } from 'crypto';
import { createPool } from '../src/db/pool';
import { PgTenantRepository } from '../src/auth/pg-tenant';
import { PgSettingsRepository } from '../src/settings/pg-settings';
import { bootstrapTenant } from '../src/auth/clerk';

interface Args {
  email?: string;
  password?: string;
  skipCustomer?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--email' && next) {
      out.email = next;
      i++;
    } else if (arg === '--password' && next) {
      out.password = next;
      i++;
    } else if (arg === '--skip-customer') out.skipCustomer = true;
  }
  return out;
}

function fail(msg: string): never {
  process.stderr.write(`bootstrap-mobile-qa-user: ${msg}\n`);
  process.exit(1);
}

async function clerkFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) fail('CLERK_SECRET_KEY is required');
  return fetch(`https://api.clerk.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function ensureClerkUser(email: string, password: string): Promise<string> {
  const listed = await clerkFetch(
    `/users?email_address=${encodeURIComponent(email)}`,
  ).then((r) => r.json() as Promise<Array<{ id: string; primary_email_address_id: string }>>);

  let user = listed[0];
  if (!user) {
    const created = await clerkFetch('/users', {
      method: 'POST',
      body: JSON.stringify({
        email_address: [email],
        password,
        skip_password_checks: true,
        skip_password_requirement: true,
      }),
    }).then(async (r) => {
      if (!r.ok) fail(`Clerk create user failed: ${r.status} ${await r.text()}`);
      return r.json() as Promise<{ id: string; primary_email_address_id: string }>;
    });
    user = created;
    process.stdout.write(`Created Clerk user ${user.id}\n`);
  } else {
    process.stdout.write(`Reusing Clerk user ${user.id}\n`);
  }

  await clerkFetch(`/email_addresses/${user.primary_email_address_id}`, {
    method: 'PATCH',
    body: JSON.stringify({ verified: true }),
  }).then(async (r) => {
    if (!r.ok) fail(`Clerk verify email failed: ${r.status} ${await r.text()}`);
  });

  return user.id;
}

async function syncClerkMetadata(userId: string, tenantId: string): Promise<void> {
  const res = await clerkFetch(`/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      public_metadata: { tenant_id: tenantId, role: 'owner' },
    }),
  });
  if (!res.ok) fail(`Clerk metadata sync failed: ${res.status} ${await res.text()}`);
  process.stdout.write(`Synced Clerk public_metadata tenant_id=${tenantId}\n`);
}

async function ensureOwnerUserRow(
  pool: ReturnType<typeof createPool>,
  tenantId: string,
  clerkUserId: string,
  email: string,
): Promise<void> {
  const existing = await pool.query(
    `SELECT id FROM users WHERE tenant_id = $1 AND clerk_user_id = $2 LIMIT 1`,
    [tenantId, clerkUserId],
  );
  if ((existing.rowCount ?? 0) > 0) {
    process.stdout.write('Owner users row already exists\n');
    return;
  }

  await pool.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  await pool.query(
    `INSERT INTO users (
       id, tenant_id, clerk_user_id, email, role, can_field_serve, current_mode, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'owner', true, 'supervisor', now(), now())`,
    [randomUUID(), tenantId, clerkUserId, email],
  );
  process.stdout.write('Inserted owner users row\n');
}

async function seedQaCustomer(
  pool: ReturnType<typeof createPool>,
  tenantId: string,
  clerkUserId: string,
): Promise<string | null> {
  const displayName = 'QA Mobile Customer';
  const existing = await pool.query(
    `SELECT id FROM customers WHERE tenant_id = $1 AND display_name = $2 LIMIT 1`,
    [tenantId, displayName],
  );
  if (existing.rows[0]?.id) {
    process.stdout.write(`Reusing QA customer ${existing.rows[0].id}\n`);
    return String(existing.rows[0].id);
  }

  const customerId = randomUUID();
  await pool.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  await pool.query(
    `INSERT INTO customers (
       id, tenant_id, display_name, first_name, last_name, primary_phone, email,
       preferred_channel, sms_consent, is_archived, created_by, created_at, updated_at
     ) VALUES (
       $1, $2, $3, 'QA', 'Customer', '+15551234567', 'qa-customer@example.com',
       'sms', true, false, $4, now(), now()
     )`,
    [customerId, tenantId, displayName, clerkUserId],
  );
  process.stdout.write(`Seeded QA customer ${customerId} (phone +15551234567)\n`);
  return customerId;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const email = args.email ?? `mobile-qa+clerk_test+${Date.now()}@serviceos-test.com`;
  const password = args.password ?? 'MobileQATest!123';

  if (!process.env.DATABASE_URL) fail('DATABASE_URL is required (Railway Postgres connection string)');

  const clerkUserId = await ensureClerkUser(email, password);

  const pool = createPool();
  try {
    const tenantRepo = new PgTenantRepository(pool);
    const settingsRepo = new PgSettingsRepository(pool);

    const boot = await bootstrapTenant(clerkUserId, email, tenantRepo, {
      settingsRepository: settingsRepo,
    });
    process.stdout.write(`${boot.created ? 'Created' : 'Reused'} tenant ${boot.tenantId}\n`);

    await ensureOwnerUserRow(pool, boot.tenantId, clerkUserId, email);
    await syncClerkMetadata(clerkUserId, boot.tenantId);

    let customerId: string | null = null;
    if (!args.skipCustomer) {
      customerId = await seedQaCustomer(pool, boot.tenantId, clerkUserId);
    }

    process.stdout.write('\n--- Mobile QA credentials ---\n');
    process.stdout.write(`email=${email}\n`);
    process.stdout.write(`password=${password}\n`);
    process.stdout.write(`clerk_user_id=${clerkUserId}\n`);
    process.stdout.write(`tenant_id=${boot.tenantId}\n`);
    if (customerId) process.stdout.write(`qa_customer_id=${customerId}\n`);
    process.stdout.write('\nNext: re-export mobile web with EXPO_PUBLIC_API_URL, serve -s, sign in.\n');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
