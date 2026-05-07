/**
 * P0-034 — bootstrap CLI for the `platform_admins` table.
 *
 * Adds a single user as a platform admin. Idempotent: if the user is
 * already present, the command exits 0 without re-inserting.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *     npx ts-node packages/api/scripts/grant-platform-admin.ts \
 *       --user-id <uuid> --granted-by <uuid> [--notes "..."] \
 *       [--audit-tenant-id <uuid>]
 *
 * Notes:
 * - --user-id is the Clerk user id of the new platform admin (UUID).
 * - --granted-by is the actor performing the grant (also UUID). For the
 *   very first bootstrap, set --granted-by to the same value as
 *   --user-id (self-grant is allowed by design — the operator running
 *   the dispatch).
 * - --audit-tenant-id is optional. If provided, the grant emits an
 *   audit row scoped to that tenant with metadata.actor_type='platform'.
 *   Audit rows are tenant-scoped (FK + RLS); the platform action is
 *   tagged via metadata so review tooling can filter on it.
 */
import { createPool } from '../src/db/pool';
import { PgAuditRepository } from '../src/audit/pg-audit';
import { grantPlatformAdmin } from '../src/auth/platform-admin';

interface ParsedArgs {
  userId?: string;
  grantedBy?: string;
  notes?: string;
  auditTenantId?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--user-id' && next) {
      out.userId = next;
      i++;
    } else if (arg === '--granted-by' && next) {
      out.grantedBy = next;
      i++;
    } else if (arg === '--notes' && next) {
      out.notes = next;
      i++;
    } else if (arg === '--audit-tenant-id' && next) {
      out.auditTenantId = next;
      i++;
    }
  }
  return out;
}

function fail(msg: string): never {
  process.stderr.write(`grant-platform-admin: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.userId) fail('--user-id <uuid> is required');
  if (!args.grantedBy) fail('--granted-by <uuid> is required');
  if (!process.env.DATABASE_URL) fail('DATABASE_URL must be set');

  const pool = createPool();
  try {
    const auditRepo = args.auditTenantId
      ? new PgAuditRepository(pool)
      : undefined;

    const result = await grantPlatformAdmin(pool, {
      userId: args.userId!,
      grantedBy: args.grantedBy!,
      notes: args.notes,
      auditTenantId: args.auditTenantId ?? '',
      auditRepo,
    });

    if (result.inserted) {
      process.stdout.write(
        `granted: ${result.userId} at ${result.grantedAt.toISOString()}\n`
      );
    } else {
      process.stdout.write(
        `already-granted (no-op): ${result.userId}\n`
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`grant-platform-admin failed: ${message}\n`);
  process.exit(1);
});
