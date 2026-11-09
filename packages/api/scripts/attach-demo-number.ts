/**
 * Attach ONE real Twilio number to an existing, seeded demo tenant — the
 * number that is published as the public demo line (see docs/demo-line.md).
 *
 * What it does, for the demo tenant you name (`tenants.demo = true`, from
 * scripts/seed-demo-tenants.ts):
 *   1. refuses anything that is not a demo tenant (a real tenant, the
 *      platform tenant, an unknown id) before any Twilio call or write;
 *   2. searches Twilio for a purchasable local US number in --area-code (or
 *      the --region's area code; default region AZ);
 *   3. creates the tenant's Twilio subaccount (the same one normal
 *      provisioning creates — inbound webhooks verify against it);
 *   4. buys the number into it, with its voice webhook on the normal inbound
 *      voice path (/api/telephony/voice) plus the LCR-04 voice fallback and
 *      the status callback — the same URLs `buildPhoneNumberWebhooks` gives
 *      every provisioned number;
 *   5. records it on the tenant exactly as provisioning does:
 *      `tenant_integrations` (provider twilio, status full_readiness,
 *      provider_data.phoneE164/phoneNumberSid) and `tenant_settings.business_phone`.
 *
 * What it does NOT do: create a tenant, a Clerk user, a Stripe checkout or a
 * subscription; attach a Messaging Service (the demo line is voice-only, no
 * SMS) or create a Vapi assistant. The caps that make the line safe to
 * publish (3 calls/day per caller, a daily total, 3 minutes a call) live in
 * the API, not here: src/demo/inbound-limits.ts.
 *
 * Idempotent: a tenant that already has its number is reported and left
 * alone; a re-run after a crash reuses the saved subaccount and recovers a
 * number already bought into it instead of buying a second.
 *
 * --dry-run searches Twilio (read-only) and the database (read-only), prints
 * exactly what it would buy and where it would point it, and buys and writes
 * NOTHING. A real run spends real money (a number is recurring): run
 * --dry-run first.
 *
 * Usage:
 *   DATABASE_URL=... TENANT_ENCRYPTION_KEY=... \
 *   TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... \
 *   VOICE_PUBLIC_URL=https://voice.example.com   # or PUBLIC_API_URL / APP_PUBLIC_URL \
 *     npx tsx packages/api/scripts/attach-demo-number.ts \
 *       --tenant-id <demo-tenant-uuid> [--area-code 602 | --region AZ] [--dry-run]
 *
 * Required environment:
 *   DATABASE_URL            the database the demo tenant lives in
 *   TWILIO_ACCOUNT_SID      master account (searches, creates the subaccount)
 *   TWILIO_AUTH_TOKEN
 *   TENANT_ENCRYPTION_KEY   encrypts the new subaccount's auth token at rest
 *   VOICE_PUBLIC_URL        public https base of the service that answers calls
 *     (else PUBLIC_API_URL, else APP_PUBLIC_URL) — a non-https base is refused,
 *     because it would be baked into a number you are paying for
 *
 * The tenant must be the one pool tenant you intend to publish. Note it is
 * still a member of the outbound demo-call pool (src/demo/lease.ts leases any
 * `demo = true` tenant of a trade, and src/demo/reset.ts then purges every
 * tenant-owned table, `tenant_integrations` included) — see docs/demo-line.md,
 * "Known hazard", before enabling DEMO_CALLS_ENABLED alongside this number.
 */
import type { Pool } from 'pg';
import { createPool } from '../src/db/pool';
import { decrypt, encrypt } from '../src/integrations/crypto';
import {
  areaCodeForRegion,
  buildPhoneNumberWebhooks,
  createTwilioSubaccountWithCreds,
  listSubaccountPhoneNumbers,
  purchasePhoneNumber,
  searchAvailableNumbers,
  type AvailableNumber,
  type PhoneNumberWebhooks,
  type PurchasedNumber,
} from '../src/integrations/twilio/provisioning';
import { isTwilioTestNumber } from '../src/telephony/phone-policy';
import { tenantQuery } from '../src/workers/tenant-query';

// tenant_integrations.status values (migration 071), the same two provisioning writes.
const STATUS_PROVISIONING = 't0_requested';
const STATUS_ACTIVE = 'full_readiness';

/** How many candidates a search asks for; the first is the one bought. */
const SEARCH_LIMIT = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AttachError extends Error {}

export interface AttachArgs {
  tenantId: string;
  areaCode?: string;
  region: string;
  dryRun: boolean;
}

export function parseAttachArgs(argv: string[]): AttachArgs {
  let tenantId: string | undefined;
  let areaCode: string | undefined;
  let region = 'AZ';
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new AttachError(`${arg} requires a value`);
      i++;
      return next;
    };
    if (arg === '--tenant-id') tenantId = value();
    else if (arg === '--area-code') areaCode = value();
    else if (arg === '--region') region = value().toUpperCase();
    else if (arg === '--dry-run') dryRun = true;
    else throw new AttachError(`unknown argument ${arg}`);
  }

  if (!tenantId || !UUID.test(tenantId)) throw new AttachError('--tenant-id <demo-tenant-uuid> is required');
  if (areaCode !== undefined && !/^\d{3}$/.test(areaCode)) throw new AttachError('--area-code must be 3 digits, e.g. 602');
  if (areaCodeForRegion(region) === undefined) throw new AttachError(`--region must be a US state code, e.g. AZ (got ${region})`);

  return { tenantId, ...(areaCode ? { areaCode } : {}), region, dryRun };
}

export interface AttachTenantRow {
  id: string;
  name: string;
  demo: boolean;
  platform: boolean;
}

export interface ExistingTwilioIntegration {
  status: string;
  subaccountSid: string | null;
  authTokenEnc: string | null;
  phoneNumberSid: string | null;
  phoneE164: string | null;
}

export interface AttachStore {
  getTenant(tenantId: string): Promise<AttachTenantRow | null>;
  getTwilioIntegration(tenantId: string): Promise<ExistingTwilioIntegration | null>;
  /** Persist the subaccount BEFORE any purchase, so a crash leaves a number the next run can find. */
  saveSubaccount(tenantId: string, sub: { subaccountSid: string; authTokenEnc: string }): Promise<void>;
  /** Mark the integration active with its number, and set the tenant's business phone. */
  recordNumber(tenantId: string, num: { phoneNumberSid: string; phoneE164: string }): Promise<void>;
}

export interface AttachTwilio {
  /** Master-account search; read-only. */
  searchAvailableNumbers(areaCode: string, limit: number): Promise<AvailableNumber[]>;
  createSubaccount(friendlyName: string): Promise<{ sid: string; authToken: string }>;
  listNumbers(subaccountSid: string, authToken: string): Promise<PurchasedNumber[]>;
  purchase(subaccountSid: string, authToken: string, phoneNumber: string, webhooks: PhoneNumberWebhooks): Promise<PurchasedNumber>;
}

export interface AttachDeps {
  store: AttachStore;
  twilio: AttachTwilio;
  encrypt(plain: string): string;
  decrypt(enc: string): string;
  voiceBaseUrl: string;
  log(line: string): void;
}

export type AttachResult =
  | { outcome: 'already_attached'; phoneE164: string }
  | { outcome: 'dry_run'; candidate: AvailableNumber; areaCode: string; webhooks: PhoneNumberWebhooks }
  | { outcome: 'attached'; phoneE164: string; phoneNumberSid: string; subaccountSid: string };

export async function runAttachDemoNumber(args: AttachArgs, deps: AttachDeps): Promise<AttachResult> {
  const { store, twilio, log } = deps;
  if (!deps.voiceBaseUrl.startsWith('https://')) {
    throw new AttachError(
      `voice base URL must be https (got ${JSON.stringify(deps.voiceBaseUrl)}): it is baked into a number you pay for — set VOICE_PUBLIC_URL`,
    );
  }

  // 1 — only ever a demo tenant, decided before anything else is touched.
  const tenant = await store.getTenant(args.tenantId);
  if (!tenant) throw new AttachError(`tenant ${args.tenantId} not found`);
  if (tenant.platform) throw new AttachError(`tenant ${tenant.id} is the platform tenant, not a demo pool tenant — refusing`);
  if (!tenant.demo) throw new AttachError(`tenant ${tenant.id} (${tenant.name}) is not a demo tenant (tenants.demo is false) — refusing`);

  const existing = await store.getTwilioIntegration(tenant.id);
  if (existing?.status === STATUS_ACTIVE && existing.phoneE164) {
    log(`tenant ${tenant.id} already has its demo number ${existing.phoneE164} — nothing to do`);
    return { outcome: 'already_attached', phoneE164: existing.phoneE164 };
  }

  const webhooks = buildPhoneNumberWebhooks(deps.voiceBaseUrl, tenant.id);
  const dry = args.dryRun;
  log(`${dry ? 'DRY RUN — nothing will be bought or written' : 'REAL RUN — this buys a number'}: demo tenant ${tenant.id} (${tenant.name})`);

  // 2 — a number a crashed earlier run already bought into this tenant's own subaccount.
  let subaccountSid = existing?.subaccountSid ?? null;
  let authToken = subaccountSid && existing?.authTokenEnc ? deps.decrypt(existing.authTokenEnc) : null;
  if (subaccountSid && authToken) {
    const owned = await twilio.listNumbers(subaccountSid, authToken);
    if (owned.length > 0) {
      const orphan = owned[0];
      log(`${dry ? 'would record' : 'recovering'} ${orphan.phoneNumber}, already bought into subaccount ${subaccountSid} — no new purchase`);
      if (dry) {
        return {
          outcome: 'dry_run',
          candidate: { phoneNumber: orphan.phoneNumber },
          areaCode: args.areaCode ?? areaCodeForRegion(args.region) ?? '',
          webhooks,
        };
      }
      return finish(deps, tenant.id, subaccountSid, orphan);
    }
  }

  // 3 — search before creating or buying anything, so "no inventory" costs nothing.
  const areaCode = args.areaCode ?? areaCodeForRegion(args.region);
  if (!areaCode) throw new AttachError(`no area code known for region ${args.region}; pass --area-code`);
  const candidates = await twilio.searchAvailableNumbers(areaCode, SEARCH_LIMIT);
  if (candidates.length === 0) {
    throw new AttachError(`no numbers available in area code ${areaCode}; try another --area-code or --region`);
  }
  const candidate = candidates[0];

  if (dry) {
    log(`area code ${areaCode}: ${candidates.length} candidate(s): ${candidates.map((c) => c.phoneNumber).join(', ')}`);
    log(`would buy ${candidate.phoneNumber}${candidate.locality ? ` (${candidate.locality}, ${candidate.region ?? ''})` : ''}`);
    log(`  voice webhook    ${webhooks.voiceUrl}`);
    log(`  voice fallback   ${webhooks.voiceFallbackUrl}`);
    log(`  status callback  ${webhooks.statusCallbackUrl}`);
    log(`would record it on tenant ${tenant.id}: tenant_integrations (twilio, ${STATUS_ACTIVE}) and tenant_settings.business_phone`);
    log('dry run complete: nothing was bought and nothing was written');
    return { outcome: 'dry_run', candidate, areaCode, webhooks };
  }

  // 4 — subaccount (saved first), then the purchase.
  if (!subaccountSid || !authToken) {
    const sub = await twilio.createSubaccount(`serviceos-tenant-${tenant.id}`);
    subaccountSid = sub.sid;
    authToken = sub.authToken;
    await store.saveSubaccount(tenant.id, { subaccountSid, authTokenEnc: deps.encrypt(authToken) });
    log(`created subaccount ${subaccountSid}`);
  }
  const purchased = await twilio.purchase(subaccountSid, authToken, candidate.phoneNumber, webhooks);
  log(`bought ${purchased.phoneNumber}`);
  return finish(deps, tenant.id, subaccountSid, purchased);
}

async function finish(
  deps: AttachDeps,
  tenantId: string,
  subaccountSid: string,
  num: PurchasedNumber,
): Promise<AttachResult> {
  // #880 — a Twilio magic test number means TEST credentials; never publish it as the line.
  if (isTwilioTestNumber(num.phoneNumber)) {
    throw new AttachError(
      `Twilio returned the magic test number ${num.phoneNumber}: the configured credentials are TEST credentials, so this is not a real line — nothing recorded`,
    );
  }
  await deps.store.recordNumber(tenantId, { phoneNumberSid: num.sid, phoneE164: num.phoneNumber });
  deps.log(`recorded ${num.phoneNumber} on tenant ${tenantId}: inbound calls to it now answer as that demo tenant`);
  deps.log(
    'REMINDER: set DEMO_INBOUND_* caps if the defaults (3 calls/day per caller, 50/day total, 180 s a call) do not suit, and read docs/demo-line.md "Known hazard" before enabling DEMO_CALLS_ENABLED',
  );
  return { outcome: 'attached', phoneE164: num.phoneNumber, phoneNumberSid: num.sid, subaccountSid };
}

/** The SQL behind the store; pinned at real Postgres in test/integration/attach-demo-number.test.ts. */
export function createPgAttachStore(pool: Pool): AttachStore {
  return {
    async getTenant(tenantId) {
      // `tenants` has no RLS; read as the connection principal, as the demo pool does.
      const { rows } = await pool.query<{ id: string; name: string; demo: boolean; platform: boolean }>(
        `SELECT id, name, demo, platform FROM tenants WHERE id = $1`,
        [tenantId],
      );
      return rows[0] ?? null;
    },

    async getTwilioIntegration(tenantId) {
      const { rows } = await tenantQuery<{
        status: string;
        subaccount_sid: string | null;
        auth_token_primary_enc: string | null;
        provider_data: { phoneNumberSid?: string; phoneE164?: string } | null;
      }>(
        pool,
        tenantId,
        `SELECT status, subaccount_sid, auth_token_primary_enc, provider_data
           FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'twilio'`,
        [tenantId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        status: row.status,
        subaccountSid: row.subaccount_sid,
        authTokenEnc: row.auth_token_primary_enc,
        phoneNumberSid: row.provider_data?.phoneNumberSid ?? null,
        phoneE164: row.provider_data?.phoneE164 ?? null,
      };
    },

    async saveSubaccount(tenantId, { subaccountSid, authTokenEnc }) {
      await tenantQuery(
        pool,
        tenantId,
        `INSERT INTO tenant_integrations (tenant_id, provider, status, subaccount_sid, auth_token_primary_enc)
         VALUES ($1, 'twilio', $2, $3, $4)
         ON CONFLICT (tenant_id, provider) DO UPDATE
           SET subaccount_sid = $3, auth_token_primary_enc = $4, last_error = NULL, updated_at = NOW()`,
        [tenantId, STATUS_PROVISIONING, subaccountSid, authTokenEnc],
      );
    },

    async recordNumber(tenantId, { phoneNumberSid, phoneE164 }) {
      // Same writes as the provisioning worker's final steps: the number into
      // provider_data (what inbound routing reads), the row active, then the
      // tenant's business phone if it has none.
      await tenantQuery(
        pool,
        tenantId,
        `UPDATE tenant_integrations
            SET status = $2, provisioned_at = NOW(), last_error = NULL,
                provider_data = provider_data || $3::jsonb, updated_at = NOW()
          WHERE tenant_id = $1 AND provider = 'twilio'`,
        [tenantId, STATUS_ACTIVE, JSON.stringify({ phoneNumberSid, phoneE164 })],
      );
      await tenantQuery(
        pool,
        tenantId,
        `UPDATE tenant_settings
            SET business_phone = COALESCE(NULLIF(TRIM(business_phone), ''), $1), updated_at = NOW()
          WHERE tenant_id = $2`,
        [phoneE164, tenantId],
      );
    },
  };
}

function fail(msg: string): never {
  process.stderr.write(`attach-demo-number: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let args: AttachArgs;
  try {
    args = parseAttachArgs(process.argv.slice(2));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const missing = ['DATABASE_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TENANT_ENCRYPTION_KEY'].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) fail(`missing required environment: ${missing.join(', ')}`);
  const voiceBaseUrl = (process.env.VOICE_PUBLIC_URL || process.env.PUBLIC_API_URL || process.env.APP_PUBLIC_URL || '').replace(
    /\/+$/,
    '',
  );
  if (!voiceBaseUrl) fail('set VOICE_PUBLIC_URL (or PUBLIC_API_URL / APP_PUBLIC_URL) to the public https base that answers calls');

  const masterSid = process.env.TWILIO_ACCOUNT_SID!;
  const masterToken = process.env.TWILIO_AUTH_TOKEN!;
  const encKey = process.env.TENANT_ENCRYPTION_KEY!;
  const pool = createPool();
  try {
    await runAttachDemoNumber(args, {
      store: createPgAttachStore(pool),
      twilio: {
        searchAvailableNumbers: (areaCode, limit) => searchAvailableNumbers(masterSid, masterToken, { areaCode, limit }),
        createSubaccount: (friendlyName) => createTwilioSubaccountWithCreds(masterSid, masterToken, friendlyName),
        listNumbers: listSubaccountPhoneNumbers,
        // The number is already chosen, so the region is unused: preferredNumber skips the search.
        purchase: (sid, token, phoneNumber, webhooks) => purchasePhoneNumber(sid, token, null, webhooks, phoneNumber),
      },
      encrypt: (plain) => encrypt(plain, encKey),
      decrypt: (enc) => decrypt(enc, encKey),
      voiceBaseUrl,
      log: (line) => process.stdout.write(`${line}\n`),
    });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    fail(err instanceof Error ? err.message : String(err));
  });
}
