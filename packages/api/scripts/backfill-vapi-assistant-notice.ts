/**
 * PRIV-4 — push the virtual-assistant notice to every existing Vapi assistant.
 *
 * A Vapi-routed number never reaches /api/telephony/voice, so its callers hear
 * the assistant's `firstMessage`. New assistants (provisioning) and owners who
 * re-save voice settings get a first message that ends with the notice
 * (`vapiFirstMessage`); assistants created before that keep their old first
 * message, with no notice, until this script re-pushes it. The first message
 * is rebuilt from `tenant_settings` exactly as provisioning builds it (stored
 * greeting, else the auto greeting; the tenant's `default_language` picks the
 * notice's language). Only `firstMessage` is written; the voice, server URL
 * and secret are never touched.
 *
 * Idempotent: the PATCH sets the same text on every run, so re-running is
 * safe. DRY RUN by default — nothing is changed until `--apply` is passed.
 *
 * Usage:
 *   DATABASE_URL=postgres://... VAPI_API_KEY=... \
 *     npx tsx packages/api/scripts/backfill-vapi-assistant-notice.ts \
 *       [--apply] [--tenant-id <uuid>]
 *
 * Notes:
 * - Tenant ids are listed from `tenant_integrations` cross-tenant under the
 *   `app.system_lookup` escape hatch (migration 074); each tenant's settings
 *   are then read under that tenant's own RLS context, so the script works
 *   under the admin role and the RLS runtime role alike.
 */
import type { Pool } from 'pg';
import { createPool } from '../src/db/pool';
import { tenantQuery } from '../src/workers/tenant-query';
import { getVapiClient, type VapiClient } from '../src/integrations/vapi/client';
import { vapiFirstMessageForSettings } from '../src/integrations/vapi/assistant-config';

/** One tenant's Vapi assistant and the settings its first message is built from. */
export interface VapiNoticeRow {
  tenantId: string;
  assistantId: string | null;
  businessName: string | null;
  greeting: string | null;
  services: string[];
  defaultLanguage: string | null;
}

export type VapiNoticeOutcome = 'would_set' | 'set' | 'skipped' | 'failed';

export interface VapiNoticeReport {
  tenantId: string;
  assistantId: string | null;
  outcome: VapiNoticeOutcome;
  detail?: string;
}

export interface VapiNoticeResult {
  reports: VapiNoticeReport[];
  counts: Record<VapiNoticeOutcome, number>;
}

export interface VapiNoticeArgs {
  apply: boolean;
  tenantId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Throws on anything it does not recognise. A dropped `--tenant-id` value or
 * a mistyped flag must never fall through to "every tenant" on an `--apply`.
 */
export function parseVapiNoticeArgs(argv: string[]): VapiNoticeArgs {
  const out: VapiNoticeArgs = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      out.apply = true;
    } else if (arg === '--tenant-id') {
      const next = argv[i + 1];
      if (!next || !UUID_RE.test(next)) {
        throw new Error('--tenant-id needs a tenant uuid');
      }
      out.tenantId = next;
      i++;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

/**
 * Every tenant with a Twilio integration, then each one's Vapi settings read
 * under its own tenant context. Tenants without an assistant come back with
 * `assistantId: null` and are skipped by the planner.
 */
export async function listVapiAssistantsForBackfill(
  pool: Pool,
  tenantId?: string,
): Promise<VapiNoticeRow[]> {
  const client = await pool.connect();
  let tenantIds: string[];
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.system_lookup', 'true', true)");
    const { rows } = await client.query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id
         FROM tenant_integrations
        WHERE provider = 'twilio'
          AND ($1::uuid IS NULL OR tenant_id = $1::uuid)
        ORDER BY tenant_id`,
      [tenantId ?? null],
    );
    await client.query('COMMIT');
    tenantIds = rows.map((r) => r.tenant_id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const out: VapiNoticeRow[] = [];
  for (const id of tenantIds) {
    const { rows } = await tenantQuery<{
      vapi_assistant_id: string | null;
      business_name: string | null;
      voice_greeting: string | null;
      services_offered: string[] | null;
      default_language: string | null;
    }>(
      pool,
      id,
      `SELECT vapi_assistant_id, business_name, voice_greeting, services_offered, default_language
         FROM tenant_settings WHERE tenant_id = $1`,
      [id],
    );
    const s = rows[0];
    out.push({
      tenantId: id,
      assistantId: s?.vapi_assistant_id ?? null,
      businessName: s?.business_name ?? null,
      greeting: s?.voice_greeting ?? null,
      services: s?.services_offered ?? [],
      defaultLanguage: s?.default_language ?? null,
    });
  }
  return out;
}

/** The first message provisioning would build for this tenant today. */
export function firstMessageFor(row: VapiNoticeRow): string {
  return vapiFirstMessageForSettings(row);
}

export async function runVapiNoticeBackfill(opts: {
  rows: VapiNoticeRow[];
  vapi: Pick<VapiClient, 'updateAssistant'>;
  apply: boolean;
  log: (line: string) => void;
}): Promise<VapiNoticeResult> {
  const counts: Record<VapiNoticeOutcome, number> = { would_set: 0, set: 0, skipped: 0, failed: 0 };
  const reports: VapiNoticeReport[] = [];
  const record = (report: VapiNoticeReport): void => {
    counts[report.outcome] += 1;
    reports.push(report);
    opts.log(
      `${report.outcome.padEnd(9)} tenant=${report.tenantId} assistant=${report.assistantId ?? '-'}` +
        (report.detail ? ` (${report.detail})` : ''),
    );
  };

  for (const row of opts.rows) {
    const base = { tenantId: row.tenantId, assistantId: row.assistantId };
    if (!row.assistantId) {
      record({ ...base, outcome: 'skipped', detail: 'no Vapi assistant' });
      continue;
    }
    const firstMessage = firstMessageFor(row);
    if (!opts.apply) {
      record({ ...base, outcome: 'would_set', detail: firstMessage });
      continue;
    }
    try {
      await opts.vapi.updateAssistant(row.assistantId, { firstMessage });
      record({ ...base, outcome: 'set' });
    } catch (err) {
      record({ ...base, outcome: 'failed', detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return { reports, counts };
}

function fail(msg: string): never {
  process.stderr.write(`backfill-vapi-assistant-notice: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let args: VapiNoticeArgs;
  try {
    args = parseVapiNoticeArgs(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  if (!process.env.DATABASE_URL) fail('DATABASE_URL must be set');
  const vapi = getVapiClient();
  if (!vapi) fail('VAPI_API_KEY must be set');

  const pool = createPool();
  try {
    const rows = await listVapiAssistantsForBackfill(pool, args.tenantId);
    process.stdout.write(
      `${args.apply ? 'APPLY' : 'DRY RUN (pass --apply to update assistants)'} — ${rows.length} tenant(s)\n`,
    );
    const result = await runVapiNoticeBackfill({
      rows,
      vapi: vapi!,
      apply: args.apply,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(
      `done: would_set=${result.counts.would_set} set=${result.counts.set} ` +
        `skipped=${result.counts.skipped} failed=${result.counts.failed}\n`,
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
