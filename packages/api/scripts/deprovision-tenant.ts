/**
 * Tenant hard-delete CLI. Releases the tenant's Twilio subaccount and purges
 * ALL tenant-scoped data, then the `tenants` row. PERMANENT and irreversible.
 *
 * Runs the purge INLINE (synchronous) so the operator sees the result, unlike
 * the admin API endpoint which enqueues a background job.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TENANT_ENCRYPTION_KEY=... \
 *     npx ts-node packages/api/scripts/deprovision-tenant.ts \
 *       --tenant-id <uuid> --actor-id <uuid> --confirm [--reason "..."] [--force]
 *
 * Notes:
 * - DATABASE_URL must point at a role that can `SET session_replication_role`
 *   (the migration/admin role) — required to bypass FK triggers + RLS.
 * - --confirm is mandatory (guards against fat-finger deletes).
 * - --force purges the DB even if the Twilio release fails.
 */
import { createPool } from '../src/db/pool';
import { createLogger } from '../src/logging/logger';
import { deprovisionTenant, type DeprovisionReason } from '../src/tenants/deprovision';

interface ParsedArgs {
  tenantId?: string;
  actorId?: string;
  reason?: string;
  confirm?: boolean;
  force?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--tenant-id' && next) {
      out.tenantId = next;
      i++;
    } else if (arg === '--actor-id' && next) {
      out.actorId = next;
      i++;
    } else if (arg === '--reason' && next) {
      out.reason = next;
      i++;
    } else if (arg === '--confirm') {
      out.confirm = true;
    } else if (arg === '--force') {
      out.force = true;
    }
  }
  return out;
}

function fail(msg: string): never {
  process.stderr.write(`deprovision-tenant: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tenantId) fail('--tenant-id <uuid> is required');
  if (!args.actorId) fail('--actor-id <uuid> is required');
  if (!args.confirm) fail('--confirm is required (this is a permanent hard delete)');
  if (!process.env.DATABASE_URL) fail('DATABASE_URL must be set');

  const pool = createPool();
  const logger = createLogger({ service: 'deprovision-cli', environment: 'cli', level: 'info' });
  try {
    const result = await deprovisionTenant(
      { pool, logger },
      {
        tenantId: args.tenantId!,
        actorId: args.actorId!,
        reason: (args.reason as DeprovisionReason) ?? 'manual_admin',
        force: args.force === true,
      },
    );

    if (result.alreadyPurged) {
      process.stdout.write(`already-purged (no-op): ${result.tenantId}\n`);
    } else {
      const total = Object.values(result.rowsDeletedByTable).reduce((a, b) => a + b, 0);
      process.stdout.write(
        `deprovisioned: ${result.tenantId}\n` +
          `  twilioReleased: ${result.twilioReleased}` +
          (result.twilioError ? ` (error: ${result.twilioError})` : '') +
          `\n  rowsDeleted: ${total} across ${Object.keys(result.rowsDeletedByTable).length} tables\n`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`deprovision-tenant failed: ${message}\n`);
  process.exit(1);
});
