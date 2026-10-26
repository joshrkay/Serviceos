/**
 * U7-05+ — one-time backfill: rewrite legacy `webhook_events` payloads to the
 * write-time allowlist, so receipts stored before the change stop holding
 * customers' (and, for Clerk, staff members') names, emails, phones,
 * addresses, message bodies and media links.
 *
 * Run once after the deploy that ships the write-time allowlist. DRY RUN by
 * default — nothing is changed until `--apply` is passed. Idempotent: a row
 * already in its minimized shape is not written, so re-running (or running
 * two at once) is safe. Resumable: every page prints `cursor=<id>`; pass the
 * last one as `--after` to continue. Only `payload` is rewritten, never the
 * dedup columns, and a row whose payload changed after its page was read is
 * skipped (see src/webhooks/webhook-payload-backfill.ts for the strategy and
 * its cost on a large table). Rows from a source with no policy are left as
 * they are and listed in the summary.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *     npx tsx packages/api/scripts/backfill-webhook-events-minimize.ts \
 *       [--apply --audit-tenant-id <uuid>] [--batch-size 500] [--after <uuid>] \
 *       [--max-batches <n>] [--pause-ms <ms>]
 *
 * --audit-tenant-id, required with --apply: write one audit row for the run, scoped to
 * that tenant with metadata.actor_type='platform' (audit rows are
 * tenant-scoped; webhook_events has no tenant), as grant-platform-admin does.
 * It carries only counts and the cursor range, never payload content.
 */
import { createPool } from '../src/db/pool';
import { PgAuditRepository } from '../src/audit/pg-audit';
import { createAuditEvent, type AuditRepository } from '../src/audit/audit';
import {
  PgWebhookPayloadBackfillStore,
  runWebhookPayloadBackfill,
  WEBHOOK_BACKFILL_DEFAULT_BATCH_SIZE,
  WEBHOOK_BACKFILL_MAX_BATCH_SIZE,
  type WebhookPayloadBackfillResult,
} from '../src/webhooks/webhook-payload-backfill';

export const BACKFILL_AUDIT_EVENT_TYPE = 'webhook_events.payloads_minimized';

export interface MinimizeArgs {
  apply: boolean;
  batchSize: number;
  pauseMs: number;
  afterId?: string;
  maxBatches?: number;
  auditTenantId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function intArg(flag: string, value: string | undefined, min: number, max: number): number {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${flag} must be an integer in ${min}..${max}`);
  }
  return n;
}

function uuidArg(flag: string, value: string | undefined): string {
  if (!value || !UUID_RE.test(value)) throw new Error(`${flag} must be a uuid`);
  return value;
}

export function parseMinimizeArgs(argv: string[]): MinimizeArgs {
  const out: MinimizeArgs = { apply: false, batchSize: WEBHOOK_BACKFILL_DEFAULT_BATCH_SIZE, pauseMs: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--apply':
        out.apply = true;
        break;
      case '--batch-size':
        out.batchSize = intArg(arg, next, 1, WEBHOOK_BACKFILL_MAX_BATCH_SIZE);
        i++;
        break;
      case '--after':
        out.afterId = uuidArg(arg, next);
        i++;
        break;
      case '--max-batches':
        out.maxBatches = intArg(arg, next, 1, Number.MAX_SAFE_INTEGER);
        i++;
        break;
      case '--pause-ms':
        out.pauseMs = intArg(arg, next, 0, 60_000);
        i++;
        break;
      case '--audit-tenant-id':
        out.auditTenantId = uuidArg(arg, next);
        i++;
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  if (out.apply && !out.auditTenantId) {
    throw new Error('--apply requires --audit-tenant-id: every rewrite run leaves an audit row');
  }
  return out;
}

/** One audit row per applied run: counts and the cursor range only. */
export async function auditBackfillRun(
  auditRepo: AuditRepository,
  tenantId: string,
  run: { afterId: string | undefined; result: WebhookPayloadBackfillResult },
): Promise<void> {
  const { result } = run;
  await auditRepo.create(
    createAuditEvent({
      tenantId,
      actorId: 'system:webhook-payload-backfill',
      actorRole: 'system',
      eventType: BACKFILL_AUDIT_EVENT_TYPE,
      entityType: 'webhook_events',
      entityId: 'payload-allowlist',
      metadata: {
        actor_type: 'platform',
        startedAfter: run.afterId ?? null,
        lastId: result.lastId,
        complete: result.complete,
        scanned: result.scanned,
        rewritten: result.rewritten,
        alreadyMinimal: result.alreadyMinimal,
        skippedChanged: result.skippedChanged,
        unclassified: result.unclassified,
      },
    }),
  );
}

function fail(msg: string): never {
  process.stderr.write(`backfill-webhook-events-minimize: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let args: MinimizeArgs;
  try {
    args = parseMinimizeArgs(process.argv.slice(2));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  if (!process.env.DATABASE_URL) fail('DATABASE_URL must be set');

  const pool = createPool();
  try {
    process.stdout.write(
      `${args.apply ? 'APPLY' : 'DRY RUN (pass --apply to rewrite payloads)'} — batch ${args.batchSize}` +
        `${args.afterId ? `, after ${args.afterId}` : ''}\n`,
    );
    const result = await runWebhookPayloadBackfill({
      store: new PgWebhookPayloadBackfillStore(pool),
      apply: args.apply,
      batchSize: args.batchSize,
      afterId: args.afterId ?? null,
      ...(args.maxBatches !== undefined ? { maxBatches: args.maxBatches } : {}),
      pauseMs: args.pauseMs,
      onBatch: (p) =>
        process.stdout.write(`batch=${p.batch} scanned=${p.scanned} rewritten=${p.rewritten} cursor=${p.lastId}\n`),
    });
    process.stdout.write(`done: ${JSON.stringify(result)}\n`);
    if (!result.complete && result.lastId) {
      process.stdout.write(`not complete: resume with --after ${result.lastId}\n`);
    }
    if (args.apply && args.auditTenantId) {
      await auditBackfillRun(new PgAuditRepository(pool), args.auditTenantId, { afterId: args.afterId, result });
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
  });
}
