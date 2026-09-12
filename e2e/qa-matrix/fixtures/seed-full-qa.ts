/**
 * Full Manual-QA seeder for the 107-item ledger.
 *
 * Seeds:
 *   - Tenant A — primary lifecycle (owner + supervisor/dispatcher + technician users)
 *   - Tenant B — isolation peer (owner + technician)
 *   - Tenant C — fresh onboarding owner (minimal fixtures)
 *
 * Plus controlled fixtures on A/B: customers, locations, jobs, appointments,
 * estimates (draft/sent with view tokens), invoices (draft/issued with tokens),
 * leads, portal session token hash placeholder, catalog item.
 *
 * Idempotent on QA_FULL_SEED_PREFIX (default: qa-full).
 *
 * Safety:
 *   - Refuses production hostnames / db names unless QA_TARGET_ENV is set and
 *     E2E_DB_ALLOW_UNSAFE=1 is explicitly provided for Railway Development
 *     (db name is often literally "railway").
 *
 * Usage:
 *   E2E_DB_URL_READWRITE=postgres://... QA_TARGET_ENV=development \
 *     E2E_DB_ALLOW_UNSAFE=1 npx tsx e2e/qa-matrix/fixtures/seed-full-qa.ts
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

const PREFIX = process.env.QA_FULL_SEED_PREFIX ?? 'qa-full';
const OUT_DIR = resolve(process.cwd(), 'qa/manual-107');
const MANIFEST_PATH = join(OUT_DIR, 'fixture-manifest.json');
const LOCAL_ENV_PATH = resolve(process.cwd(), '.env.qa.full.local');

interface RoleUser {
  userId: string;
  clerkUserId: string;
  email: string;
  role: 'owner' | 'dispatcher' | 'technician';
}

interface TenantBundle {
  slug: string;
  purpose: string;
  tenantId: string;
  users: RoleUser[];
  customerId?: string;
  locationId?: string;
  secondLocationId?: string;
  jobId?: string;
  appointmentId?: string;
  estimateDraftId?: string;
  estimateSentId?: string;
  estimateViewToken?: string;
  invoiceIssuedId?: string;
  invoiceViewToken?: string;
  leadId?: string;
  portalToken?: string;
  invalidEstimateToken: string;
  invalidInvoiceToken: string;
}

function token(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function assertTargetSafety(connectionString: string): void {
  const host = (() => {
    try {
      return new URL(connectionString).hostname.toLowerCase();
    } catch {
      throw new Error('E2E_DB_URL_READWRITE is not a valid URL');
    }
  })();
  const dbName = (() => {
    try {
      return new URL(connectionString).pathname.replace(/^\//, '').toLowerCase();
    } catch {
      return '';
    }
  })();

  if (/prod|production|live/.test(`${host} ${dbName}`)) {
    throw new Error(
      `Refusing to seed: URL looks like production (${host}/${dbName}). ` +
        `Use a dedicated QA/Development database.`,
    );
  }

  const target = (process.env.QA_TARGET_ENV ?? '').toLowerCase();
  if (!['development', 'qa', 'dev'].includes(target)) {
    throw new Error('Set QA_TARGET_ENV=development|qa before seeding full QA fixtures.');
  }

  // Railway shared DB name is often "railway" — require explicit opt-in.
  if (!/test|e2e|qa|ephemeral|ci/.test(dbName) && process.env.E2E_DB_ALLOW_UNSAFE !== '1') {
    throw new Error(
      `Database name '${dbName}' is not an explicit test/qa name. ` +
        `For Railway Development, set E2E_DB_ALLOW_UNSAFE=1 after confirming this is NOT production.`,
    );
  }
}

async function ensureUser(
  client: Client,
  tenantId: string,
  role: RoleUser['role'],
  slug: string,
): Promise<RoleUser> {
  const clerkUserId = `qa:${PREFIX}:${slug}:${role}`;
  const email = `${slug}-${role}@qa.serviceos.local`;
  const existing = await client.query(
    `SELECT id, clerk_user_id, email, role FROM users
     WHERE tenant_id = $1 AND clerk_user_id = $2 LIMIT 1`,
    [tenantId, clerkUserId],
  );
  if (existing.rows[0]) {
    return {
      userId: existing.rows[0].id,
      clerkUserId: existing.rows[0].clerk_user_id,
      email: existing.rows[0].email,
      role: existing.rows[0].role,
    };
  }
  const inserted = await client.query(
    `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
     RETURNING id`,
    [randomUUID(), tenantId, clerkUserId, email, role, 'QA', role],
  );
  return { userId: inserted.rows[0].id, clerkUserId, email, role };
}

async function ensureTenant(client: Client, slug: string, purpose: string): Promise<TenantBundle> {
  const systemUser = `${PREFIX}-seeder`;
  const ownerId = `qa:${PREFIX}:${slug}`;
  const ownerEmail = `${slug}-owner@qa.serviceos.local`;

  const existingTenant = await client.query(`SELECT id FROM tenants WHERE owner_id = $1 LIMIT 1`, [
    ownerId,
  ]);
  const tenantId =
    existingTenant.rows[0]?.id ??
    (
      await client.query(
        `INSERT INTO tenants (id, owner_id, owner_email, name, created_at, updated_at)
         VALUES ($1,$2,$3,$4,now(),now()) RETURNING id`,
        [randomUUID(), ownerId, ownerEmail, `QA Full ${slug} (${purpose})`],
      )
    ).rows[0].id;

  // tenant_settings if table exists
  await client.query(
    `INSERT INTO tenant_settings (tenant_id, created_at, updated_at)
     VALUES ($1, now(), now())
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  ).catch(() => undefined);

  const users: RoleUser[] = [];
  users.push(await ensureUser(client, tenantId, 'owner', slug));
  if (slug.endsWith('-A')) {
    users.push(await ensureUser(client, tenantId, 'dispatcher', slug));
    users.push(await ensureUser(client, tenantId, 'technician', slug));
  } else if (slug.endsWith('-B')) {
    users.push(await ensureUser(client, tenantId, 'technician', slug));
  }

  const bundle: TenantBundle = {
    slug,
    purpose,
    tenantId,
    users,
    invalidEstimateToken: `${PREFIX}_invalid_est_${slug}`,
    invalidInvoiceToken: `${PREFIX}_invalid_inv_${slug}`,
  };

  // Tenant C stays minimal (onboarding).
  if (slug.endsWith('-C')) {
    return bundle;
  }

  const customerDisplay = `${slug}-customer`;
  const existingCustomer = await client.query(
    `SELECT id FROM customers WHERE tenant_id = $1 AND display_name = $2 LIMIT 1`,
    [tenantId, customerDisplay],
  );
  const customerId =
    existingCustomer.rows[0]?.id ??
    (
      await client.query(
        `INSERT INTO customers
           (id, tenant_id, first_name, last_name, display_name, primary_phone, email,
            preferred_channel, sms_consent, is_archived, created_by, created_at, updated_at)
         VALUES ($1,$2,'QA',$3,$4,$5,$6,'sms',true,false,$7,now(),now())
         RETURNING id`,
        [
          randomUUID(),
          tenantId,
          slug,
          customerDisplay,
          slug.endsWith('-A') ? '+15550100100' : '+15550100200',
          `${slug}-customer@qa.serviceos.local`,
          systemUser,
        ],
      )
    ).rows[0].id;
  bundle.customerId = customerId;

  const loc1 = `${slug}-location-primary`;
  const loc1Existing = await client.query(
    `SELECT id FROM service_locations WHERE tenant_id=$1 AND customer_id=$2 AND label=$3 LIMIT 1`,
    [tenantId, customerId, loc1],
  );
  const locationId =
    loc1Existing.rows[0]?.id ??
    (
      await client.query(
        `INSERT INTO service_locations
           (id, tenant_id, customer_id, label, street1, city, state, postal_code, country, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'100 QA Primary St','Testville','CA','90001','US',now(),now())
         RETURNING id`,
        [randomUUID(), tenantId, customerId, loc1],
      )
    ).rows[0].id;
  bundle.locationId = locationId;

  const loc2 = `${slug}-location-secondary`;
  const loc2Existing = await client.query(
    `SELECT id FROM service_locations WHERE tenant_id=$1 AND customer_id=$2 AND label=$3 LIMIT 1`,
    [tenantId, customerId, loc2],
  );
  bundle.secondLocationId =
    loc2Existing.rows[0]?.id ??
    (
      await client.query(
        `INSERT INTO service_locations
           (id, tenant_id, customer_id, label, street1, city, state, postal_code, country, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'200 QA Secondary Ave','Testville','CA','90002','US',now(),now())
         RETURNING id`,
        [randomUUID(), tenantId, customerId, loc2],
      )
    ).rows[0].id;

  const jobNumber = `${slug}-job-1`;
  const jobExisting = await client.query(
    `SELECT id FROM jobs WHERE tenant_id=$1 AND job_number=$2 LIMIT 1`,
    [tenantId, jobNumber],
  );
  const jobId =
    jobExisting.rows[0]?.id ??
    (
      await client.query(
        `INSERT INTO jobs
           (id, tenant_id, customer_id, location_id, job_number, summary, status, priority, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'scheduled','normal',$7,now(),now())
         RETURNING id`,
        [randomUUID(), tenantId, customerId, locationId, jobNumber, `QA Full job for ${slug}`, systemUser],
      )
    ).rows[0].id;
  bundle.jobId = jobId;

  const apptNote = `${PREFIX}:${slug}:appt-1`;
  const apptExisting = await client.query(
    `SELECT id FROM appointments WHERE tenant_id=$1 AND notes=$2 LIMIT 1`,
    [tenantId, apptNote],
  );
  bundle.appointmentId =
    apptExisting.rows[0]?.id ??
    (
      await client.query(
        `INSERT INTO appointments
           (id, tenant_id, job_id, scheduled_start, scheduled_end, timezone, status, notes, created_by, created_at, updated_at)
         VALUES ($1,$2,$3, now() + interval '24 hours', now() + interval '26 hours',
                 'America/Los_Angeles', 'scheduled', $4, $5, now(), now())
         RETURNING id`,
        [randomUUID(), tenantId, jobId, apptNote, systemUser],
      )
    ).rows[0].id;

  // Draft estimate
  const draftNum = `${slug}-est-draft`;
  const draftExisting = await client.query(
    `SELECT id FROM estimates WHERE tenant_id=$1 AND estimate_number=$2 LIMIT 1`,
    [tenantId, draftNum],
  );
  bundle.estimateDraftId =
    draftExisting.rows[0]?.id ??
    (
      await client.query(
        `INSERT INTO estimates
           (id, tenant_id, job_id, estimate_number, status,
            subtotal_cents, taxable_subtotal_cents, tax_cents, total_cents,
            created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'draft',15000,15000,0,15000,$5,now(),now())
         RETURNING id`,
        [randomUUID(), tenantId, jobId, draftNum, systemUser],
      )
    ).rows[0].id;

  // Sent estimate with view token
  const sentNum = `${slug}-est-sent`;
  const sentToken = token(`${PREFIX}_est`);
  const sentExisting = await client.query(
    `SELECT id, view_token FROM estimates WHERE tenant_id=$1 AND estimate_number=$2 LIMIT 1`,
    [tenantId, sentNum],
  );
  if (sentExisting.rows[0]) {
    bundle.estimateSentId = sentExisting.rows[0].id;
    bundle.estimateViewToken = sentExisting.rows[0].view_token ?? sentToken;
    if (!sentExisting.rows[0].view_token) {
      await client.query(
        `UPDATE estimates SET status='sent', view_token=$1, view_token_expires_at=now()+interval '30 days', updated_at=now()
         WHERE id=$2`,
        [sentToken, bundle.estimateSentId],
      );
      bundle.estimateViewToken = sentToken;
    }
  } else {
    const row = await client.query(
      `INSERT INTO estimates
         (id, tenant_id, job_id, estimate_number, status,
          subtotal_cents, taxable_subtotal_cents, tax_cents, total_cents,
          view_token, view_token_expires_at, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'sent',22000,22000,0,22000,$5,now()+interval '30 days',$6,now(),now())
       RETURNING id, view_token`,
      [randomUUID(), tenantId, jobId, sentNum, sentToken, systemUser],
    );
    bundle.estimateSentId = row.rows[0].id;
    bundle.estimateViewToken = row.rows[0].view_token;
  }

  // Issued invoice with view token (if invoices table shape allows)
  const invToken = token(`${PREFIX}_inv`);
  try {
    const invNum = `${slug}-inv-1`;
    const invExisting = await client.query(
      `SELECT id, view_token FROM invoices WHERE tenant_id=$1 AND invoice_number=$2 LIMIT 1`,
      [tenantId, invNum],
    );
    if (invExisting.rows[0]) {
      bundle.invoiceIssuedId = invExisting.rows[0].id;
      bundle.invoiceViewToken = invExisting.rows[0].view_token ?? invToken;
      if (!invExisting.rows[0].view_token) {
        await client.query(
          `UPDATE invoices SET view_token=$1, view_token_expires_at=now()+interval '30 days', updated_at=now() WHERE id=$2`,
          [invToken, bundle.invoiceIssuedId],
        );
        bundle.invoiceViewToken = invToken;
      }
    } else {
      const inv = await client.query(
        `INSERT INTO invoices
           (id, tenant_id, customer_id, job_id, invoice_number, status,
            subtotal_cents, tax_cents, total_cents, amount_due_cents, amount_paid_cents,
            view_token, view_token_expires_at, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'issued',22000,0,22000,22000,0,$6,now()+interval '30 days',$7,now(),now())
         RETURNING id, view_token`,
        [randomUUID(), tenantId, customerId, jobId, invNum, invToken, systemUser],
      );
      bundle.invoiceIssuedId = inv.rows[0].id;
      bundle.invoiceViewToken = inv.rows[0].view_token;
    }
  } catch (err) {
    console.warn(`[seed-full-qa] invoice seed skipped for ${slug}:`, (err as Error).message);
  }

  // Lead
  try {
    const leadKey = `${slug}-lead-1`;
    const leadExisting = await client.query(
      `SELECT id FROM leads WHERE tenant_id=$1 AND notes=$2 LIMIT 1`,
      [tenantId, leadKey],
    ).catch(async () =>
      client.query(
        `SELECT id FROM leads WHERE tenant_id=$1 AND source=$2 LIMIT 1`,
        [tenantId, leadKey],
      ),
    );
    if (leadExisting.rows[0]) {
      bundle.leadId = leadExisting.rows[0].id;
    } else {
      const lead = await client.query(
        `INSERT INTO leads
           (id, tenant_id, first_name, last_name, primary_phone, status, source, notes, created_by, created_at, updated_at)
         VALUES ($1,$2,'QA','Lead',$3,'new','phone',$4,$5,now(),now())
         RETURNING id`,
        [randomUUID(), tenantId, '+15550100999', leadKey, systemUser],
      );
      bundle.leadId = lead.rows[0].id;
    }
  } catch (err) {
    console.warn(`[seed-full-qa] lead seed skipped for ${slug}:`, (err as Error).message);
  }

  // Portal session (token_hash)
  try {
    const rawPortal = token(`${PREFIX}_portal`);
    const th = hashToken(rawPortal);
    const portalExisting = await client.query(
      `SELECT id FROM portal_sessions WHERE tenant_id=$1 AND customer_id=$2 LIMIT 1`,
      [tenantId, customerId],
    );
    if (!portalExisting.rows[0]) {
      await client.query(
        `INSERT INTO portal_sessions (id, tenant_id, customer_id, token_hash, expires_at, created_at)
         VALUES ($1,$2,$3,$4, now()+interval '30 days', now())`,
        [randomUUID(), tenantId, customerId, th],
      );
    }
    bundle.portalToken = rawPortal;
  } catch (err) {
    console.warn(`[seed-full-qa] portal session skipped for ${slug}:`, (err as Error).message);
  }

  return bundle;
}

async function main(): Promise<void> {
  const connectionString = process.env.E2E_DB_URL_READWRITE ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Set E2E_DB_URL_READWRITE (service-role) before seeding.');
    process.exit(1);
  }
  assertTargetSafety(connectionString);

  const client = new Client({
    connectionString,
    ssl: /railway|rlwy|supabase|amazonaws/i.test(connectionString)
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await client.connect();

  try {
    const tenantA = await ensureTenant(client, `${PREFIX}-A`, 'primary-lifecycle');
    const tenantB = await ensureTenant(client, `${PREFIX}-B`, 'isolation-peer');
    const tenantC = await ensureTenant(client, `${PREFIX}-C`, 'fresh-onboarding');

    const manifest = {
      generatedAt: new Date().toISOString(),
      prefix: PREFIX,
      targetEnv: process.env.QA_TARGET_ENV,
      tenants: { A: tenantA, B: tenantB, C: tenantC },
      notes: [
        'Tokens in this manifest are disposable QA tokens — rotate by re-seeding.',
        'HMAC JWTs must be minted separately via npm run qa:full:mint using clerk_user_id + role.',
        'Never point this seeder at production customer data.',
      ],
    };

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

    const envLines = [
      `# Auto-generated by seed-full-qa.ts at ${manifest.generatedAt}`,
      `export QA_TARGET_ENV=${process.env.QA_TARGET_ENV}`,
      `export QA_FULL_SEED_PREFIX=${PREFIX}`,
      `export E2E_TENANT_A_ID=${tenantA.tenantId}`,
      `export E2E_TENANT_A_CUSTOMER_ID=${tenantA.customerId ?? ''}`,
      `export E2E_TENANT_A_JOB_ID=${tenantA.jobId ?? ''}`,
      `export E2E_TENANT_A_ESTIMATE_ID=${tenantA.estimateSentId ?? tenantA.estimateDraftId ?? ''}`,
      `export E2E_TENANT_A_INVOICE_ID=${tenantA.invoiceIssuedId ?? ''}`,
      `export E2E_TENANT_A_ESTIMATE_VIEW_TOKEN=${tenantA.estimateViewToken ?? ''}`,
      `export E2E_TENANT_A_INVOICE_VIEW_TOKEN=${tenantA.invoiceViewToken ?? ''}`,
      `export E2E_TENANT_A_PORTAL_TOKEN=${tenantA.portalToken ?? ''}`,
      `export E2E_TENANT_A_OWNER_CLERK=${tenantA.users.find((u) => u.role === 'owner')?.clerkUserId ?? ''}`,
      `export E2E_TENANT_A_DISPATCHER_CLERK=${tenantA.users.find((u) => u.role === 'dispatcher')?.clerkUserId ?? ''}`,
      `export E2E_TENANT_A_TECH_CLERK=${tenantA.users.find((u) => u.role === 'technician')?.clerkUserId ?? ''}`,
      `export E2E_TENANT_B_ID=${tenantB.tenantId}`,
      `export E2E_TENANT_B_CUSTOMER_ID=${tenantB.customerId ?? ''}`,
      `export E2E_TENANT_B_JOB_ID=${tenantB.jobId ?? ''}`,
      `export E2E_TENANT_B_OWNER_CLERK=${tenantB.users.find((u) => u.role === 'owner')?.clerkUserId ?? ''}`,
      `export E2E_TENANT_C_ID=${tenantC.tenantId}`,
      `export E2E_TENANT_C_OWNER_CLERK=${tenantC.users.find((u) => u.role === 'owner')?.clerkUserId ?? ''}`,
      '',
    ];
    writeFileSync(LOCAL_ENV_PATH, envLines.join('\n'));

    console.log('\n# Full QA fixtures ready. Source:');
    console.log(`#   source ${LOCAL_ENV_PATH}`);
    console.log(`# Manifest: ${MANIFEST_PATH}`);
    for (const line of envLines) {
      if (line.startsWith('export ')) console.log(line);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[seed-full-qa] failed:', err);
  process.exit(1);
});
