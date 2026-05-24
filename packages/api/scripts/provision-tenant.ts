/**
 * End-to-end tenant provisioning CLI (live infra). Drives the full sequence
 * a tenant goes through during onboarding, against the real database and real
 * Twilio/Stripe:
 *   1. tenant row        (bootstrapTenant)
 *   2. business identity (tenant_settings)
 *   3. vertical pack      (hvac | plumbing)
 *   4. phone (Twilio)     — creates a REAL subaccount + buys a REAL number
 *   5. billing (Stripe)   — mints the trial Checkout URL (card entry is manual)
 *   6. verify             — prints the derived onboarding status
 *
 * PREREQUISITE: a Clerk user must already exist for --owner-id (the tenants
 * table keys off it). Create the Clerk user first, then pass its id here. The
 * Stripe trial requires opening the printed Checkout URL and entering a card;
 * the Stripe webhook then flips billing → trialing.
 *
 * Usage:
 *   DATABASE_URL=... TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... \
 *   TENANT_ENCRYPTION_KEY=... STRIPE_SECRET_KEY=... STRIPE_PRICE_ID=... \
 *     npx ts-node packages/api/scripts/provision-tenant.ts \
 *       --owner-id <clerk-user-id> --owner-email you@co.com \
 *       --business-name "QA HVAC Co" --pack hvac --region CA
 */
import { createPool } from '../src/db/pool';
import { createLogger } from '../src/logging/logger';
import { PgTenantRepository } from '../src/auth/pg-tenant';
import { PgSettingsRepository } from '../src/settings/pg-settings';
import { PgPackActivationRepository } from '../src/settings/pg-pack-activation';
import { bootstrapTenant } from '../src/auth/clerk';
import { activatePack } from '../src/settings/pack-activation';
import { loadOnboardingFacts } from '../src/onboarding/load-facts';
import { deriveOnboardingStatus } from '../src/onboarding/derive-status';
import { BillingService } from '../src/billing/subscription';
import {
  createProvisionTwilioWorker,
  PROVISION_TWILIO_JOB_TYPE,
} from '../src/workers/provision-twilio';

interface ParsedArgs {
  ownerId?: string;
  ownerEmail?: string;
  businessName?: string;
  pack?: string;
  region?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    const take = (k: keyof ParsedArgs) => {
      if (next) {
        out[k] = next;
        i++;
      }
    };
    if (arg === '--owner-id') take('ownerId');
    else if (arg === '--owner-email') take('ownerEmail');
    else if (arg === '--business-name') take('businessName');
    else if (arg === '--pack') take('pack');
    else if (arg === '--region') take('region');
  }
  return out;
}

function fail(msg: string): never {
  process.stderr.write(`provision-tenant: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ownerId) fail('--owner-id <clerk-user-id> is required');
  if (!args.ownerEmail) fail('--owner-email <email> is required');
  if (!args.businessName) fail('--business-name <name> is required');
  if (args.pack !== 'hvac' && args.pack !== 'plumbing') {
    fail('--pack must be "hvac" or "plumbing"');
  }
  if (!args.region) fail('--region <US state, e.g. CA> is required');
  if (!process.env.DATABASE_URL) fail('DATABASE_URL must be set');

  const pack = args.pack;
  const region = args.region!;
  const pool = createPool();
  const logger = createLogger({ service: 'provision-cli', environment: 'cli', level: 'info' });
  const out = (s: string) => process.stdout.write(s + '\n');

  try {
    const tenantRepo = new PgTenantRepository(pool);
    const settingsRepo = new PgSettingsRepository(pool);
    const packRepo = new PgPackActivationRepository(pool);

    // 1 — tenant row
    const boot = await bootstrapTenant(args.ownerId!, args.ownerEmail!, tenantRepo, {
      settingsRepository: settingsRepo,
      provisioningRequested: true,
      onboardingLocation: { country: 'US', region },
    });
    const tenantId = boot.tenantId;
    out(`1/6 tenant ${boot.created ? 'created' : 'exists'}: ${tenantId}`);

    // 2 — business identity (mirrors PUT /api/onboarding/identity)
    await pool.query(
      `INSERT INTO tenant_settings (
         id, tenant_id, business_name, business_hours, job_buffer_minutes, hourly_rate_cents,
         timezone, estimate_prefix, invoice_prefix, next_estimate_number,
         next_invoice_number, default_payment_term_days
       )
       VALUES (gen_random_uuid(), $1, $2, $3::jsonb, $4, $5,
               'America/New_York', 'EST-', 'INV-', 1001, 1001, 30)
       ON CONFLICT (tenant_id) DO UPDATE SET
         business_name      = EXCLUDED.business_name,
         business_hours     = EXCLUDED.business_hours,
         job_buffer_minutes = EXCLUDED.job_buffer_minutes,
         hourly_rate_cents  = EXCLUDED.hourly_rate_cents,
         updated_at         = now()`,
      [
        tenantId,
        args.businessName,
        JSON.stringify({
          mon: { open: '08:00', close: '17:00' },
          tue: { open: '08:00', close: '17:00' },
          wed: { open: '08:00', close: '17:00' },
          thu: { open: '08:00', close: '17:00' },
          fri: { open: '08:00', close: '17:00' },
        }),
        30,
        12500,
      ],
    );
    out('2/6 identity set');

    // 3 — vertical pack
    try {
      await activatePack({ tenantId, packId: pack }, packRepo);
      out(`3/6 pack activated: ${pack}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already activated')) out(`3/6 pack already active: ${pack}`);
      else throw err;
    }

    // 4 — Twilio provisioning (REAL subaccount + number), run worker inline
    const worker = createProvisionTwilioWorker({ pool });
    const baseUrl =
      process.env.PUBLIC_API_URL ?? process.env.APP_PUBLIC_URL ?? 'http://localhost:3000';
    out('4/6 provisioning Twilio (this buys a real number)...');
    await worker.handle(
      {
        id: `cli-${tenantId}`,
        type: PROVISION_TWILIO_JOB_TYPE,
        payload: { tenantId, region, baseUrl },
        attempts: 1,
        maxAttempts: 1,
        idempotencyKey: `provision-twilio-${tenantId}`,
        createdAt: new Date().toISOString(),
      },
      logger,
    );
    out('4/6 Twilio provisioning done');

    // 5 — Stripe trial checkout (card entry is manual)
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (stripeKey && process.env.STRIPE_PRICE_ID) {
      const billing = new BillingService({ pool, config: { apiKey: stripeKey } });
      const webUrl = process.env.WEB_URL ?? 'http://localhost:5173';
      const { url } = await billing.createTrialCheckoutSession({
        tenantId,
        ownerEmail: args.ownerEmail!,
        successUrl: `${webUrl}/onboarding?billing=ok`,
        cancelUrl: `${webUrl}/onboarding?billing=cancel`,
      });
      out(`5/6 Stripe trial checkout — open this to enter a card:\n     ${url}`);
    } else {
      out('5/6 Stripe skipped (STRIPE_SECRET_KEY / STRIPE_PRICE_ID not set)');
    }

    // 6 — verify derived status
    const facts = await loadOnboardingFacts({ pool, settingsRepo }, tenantId);
    const status = deriveOnboardingStatus(facts);
    out('6/6 onboarding status:');
    for (const step of status.steps) out(`     ${step.id.padEnd(10)} ${step.status}`);
    out(`     isComplete: ${status.isComplete}`);
    out(`\ntenantId=${tenantId}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`provision-tenant failed: ${message}\n`);
  process.exit(1);
});
