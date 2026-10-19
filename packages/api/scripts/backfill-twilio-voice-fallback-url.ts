/**
 * LCR-04 — backfill `VoiceFallbackUrl` on every live Twilio number.
 *
 * Twilio does not retry a 5xx voice webhook. A number with no
 * `VoiceFallbackUrl` therefore drops the call (Twilio's generic "application
 * error" message) whenever /api/telephony/voice fails — a database brownout,
 * a timeout, a credential-lookup 500. New purchases carry the fallback
 * (`purchasePhoneNumber`); this script brings numbers bought before that up
 * to the same shape, pointing them at the static, database-free voicemail
 * route (`VOICE_FALLBACK_PATH`).
 *
 * Idempotent: a number whose fallback already points at the target is left
 * alone, so re-running is safe. DRY RUN by default — nothing is changed
 * until `--apply` is passed. Only the fallback is written; `VoiceUrl` and
 * `StatusCallback` are never touched.
 *
 * Usage:
 *   DATABASE_URL=postgres://... TENANT_ENCRYPTION_KEY=... \
 *   VOICE_PUBLIC_URL=https://voice.example.com   # or PUBLIC_API_URL \
 *     npx tsx packages/api/scripts/backfill-twilio-voice-fallback-url.ts \
 *       [--apply] [--tenant-id <uuid>]
 *
 * Notes:
 * - Reads `tenant_integrations` cross-tenant under the `app.system_lookup`
 *   escape hatch (migration 074), so it works under the admin role and the
 *   RLS runtime role alike.
 * - Each number is updated with its own subaccount's credential, decrypted
 *   with TENANT_ENCRYPTION_KEY — the master token is never used.
 */
import type { Pool } from 'pg';
import { createPool } from '../src/db/pool';
import { decrypt } from '../src/integrations/crypto';
import {
  buildPhoneNumberWebhooks,
  getPhoneNumberWebhooks,
  setPhoneNumberVoiceFallback,
  type PhoneNumberVoiceConfig,
} from '../src/integrations/twilio/provisioning';

/** One `tenant_integrations` Twilio row, reduced to what the backfill needs. */
export interface BackfillRow {
  tenantId: string;
  subaccountSid: string | null;
  authTokenEnc: string | null;
  phoneNumberSid: string | null;
  phoneE164: string | null;
  /** Dev/test stub integrations (a Twilio magic number) — nothing real to update. */
  stub: boolean;
}

/** The two Twilio calls the backfill makes, injectable for tests. */
export interface BackfillTwilio {
  getVoiceConfig(
    subaccountSid: string,
    authToken: string,
    phoneNumberSid: string,
  ): Promise<PhoneNumberVoiceConfig>;
  setVoiceFallback(
    subaccountSid: string,
    authToken: string,
    phoneNumberSid: string,
    voiceFallbackUrl: string,
  ): Promise<void>;
}

export type BackfillOutcome = 'already_set' | 'would_set' | 'set' | 'skipped' | 'failed';

export interface BackfillReport {
  tenantId: string;
  phoneE164: string | null;
  outcome: BackfillOutcome;
  detail?: string;
}

export interface BackfillResult {
  reports: BackfillReport[];
  counts: Record<BackfillOutcome, number>;
}

export interface BackfillArgs {
  apply: boolean;
  tenantId?: string;
}

export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const out: BackfillArgs = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--apply') {
      out.apply = true;
    } else if (arg === '--tenant-id' && next) {
      out.tenantId = next;
      i++;
    }
  }
  return out;
}

/**
 * Every Twilio integration row that names a number, read cross-tenant under
 * `app.system_lookup` (set LOCAL inside a short transaction, exactly as the
 * webhook credential resolver reads the same table).
 */
export async function listTwilioNumbersForBackfill(
  pool: Pool,
  tenantId?: string,
): Promise<BackfillRow[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.system_lookup', 'true', true)");
    const { rows } = await client.query<{
      tenant_id: string;
      subaccount_sid: string | null;
      auth_token_primary_enc: string | null;
      phone_number_sid: string | null;
      phone_e164: string | null;
      stub: string | null;
    }>(
      `SELECT tenant_id, subaccount_sid, auth_token_primary_enc,
              provider_data->>'phoneNumberSid' AS phone_number_sid,
              provider_data->>'phoneE164'      AS phone_e164,
              provider_data->>'stub'           AS stub
         FROM tenant_integrations
        WHERE provider = 'twilio'
          AND ($1::uuid IS NULL OR tenant_id = $1::uuid)
        ORDER BY tenant_id`,
      [tenantId ?? null],
    );
    await client.query('COMMIT');
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      subaccountSid: r.subaccount_sid,
      authTokenEnc: r.auth_token_primary_enc,
      phoneNumberSid: r.phone_number_sid,
      phoneE164: r.phone_e164,
      stub: r.stub === 'true',
    }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function fallbackIsSet(config: PhoneNumberVoiceConfig, target: string): boolean {
  return (
    config.voiceFallbackUrl === target &&
    (config.voiceFallbackMethod ?? 'POST').toUpperCase() === 'POST'
  );
}

export async function runVoiceFallbackBackfill(opts: {
  rows: BackfillRow[];
  voiceBaseUrl: string;
  decryptToken: (enc: string) => string;
  twilio: BackfillTwilio;
  apply: boolean;
  log: (line: string) => void;
}): Promise<BackfillResult> {
  const counts: Record<BackfillOutcome, number> = {
    already_set: 0,
    would_set: 0,
    set: 0,
    skipped: 0,
    failed: 0,
  };
  const reports: BackfillReport[] = [];
  const record = (report: BackfillReport): void => {
    counts[report.outcome] += 1;
    reports.push(report);
    opts.log(
      `${report.outcome.padEnd(11)} tenant=${report.tenantId} number=${report.phoneE164 ?? '-'}` +
        (report.detail ? ` (${report.detail})` : ''),
    );
  };

  for (const row of opts.rows) {
    const base = { tenantId: row.tenantId, phoneE164: row.phoneE164 };
    if (row.stub) {
      record({ ...base, outcome: 'skipped', detail: 'stub integration' });
      continue;
    }
    if (!row.subaccountSid || !row.authTokenEnc || !row.phoneNumberSid) {
      record({ ...base, outcome: 'skipped', detail: 'no subaccount, credential or number sid' });
      continue;
    }
    // The target is per tenant only through the status callback; the
    // fallback itself is the same static path for every number.
    const target = buildPhoneNumberWebhooks(opts.voiceBaseUrl, row.tenantId).voiceFallbackUrl;
    try {
      const authToken = opts.decryptToken(row.authTokenEnc);
      const current = await opts.twilio.getVoiceConfig(row.subaccountSid, authToken, row.phoneNumberSid);
      if (fallbackIsSet(current, target)) {
        record({ ...base, outcome: 'already_set' });
        continue;
      }
      if (!opts.apply) {
        record({ ...base, outcome: 'would_set', detail: `from ${current.voiceFallbackUrl ?? '(none)'}` });
        continue;
      }
      await opts.twilio.setVoiceFallback(row.subaccountSid, authToken, row.phoneNumberSid, target);
      record({ ...base, outcome: 'set' });
    } catch (err) {
      record({ ...base, outcome: 'failed', detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return { reports, counts };
}

function fail(msg: string): never {
  process.stderr.write(`backfill-twilio-voice-fallback-url: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) fail('DATABASE_URL must be set');
  const encKey = process.env.TENANT_ENCRYPTION_KEY;
  if (!encKey) fail('TENANT_ENCRYPTION_KEY must be set');
  // Same base the provisioning worker uses for the number's voice surfaces.
  const voiceBaseUrl =
    process.env.VOICE_PUBLIC_URL?.replace(/\/+$/, '') ||
    process.env.PUBLIC_API_URL?.replace(/\/+$/, '');
  if (!voiceBaseUrl) fail('VOICE_PUBLIC_URL or PUBLIC_API_URL must be set');

  const pool = createPool();
  try {
    const rows = await listTwilioNumbersForBackfill(pool, args.tenantId);
    process.stdout.write(
      `${args.apply ? 'APPLY' : 'DRY RUN (pass --apply to change numbers)'} — ${rows.length} row(s), ` +
        `fallback target ${buildPhoneNumberWebhooks(voiceBaseUrl!, '-').voiceFallbackUrl}\n`,
    );
    const result = await runVoiceFallbackBackfill({
      rows,
      voiceBaseUrl: voiceBaseUrl!,
      decryptToken: (enc) => decrypt(enc, encKey!),
      twilio: {
        getVoiceConfig: getPhoneNumberWebhooks,
        setVoiceFallback: setPhoneNumberVoiceFallback,
      },
      apply: args.apply,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(
      `done: already_set=${result.counts.already_set} would_set=${result.counts.would_set} ` +
        `set=${result.counts.set} skipped=${result.counts.skipped} failed=${result.counts.failed}\n`,
    );
    if (result.counts.failed > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
  });
}
