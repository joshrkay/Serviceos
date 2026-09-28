/**
 * CLERK-META-2026-09-27 — hourly reconciliation for Clerk public_metadata.
 *
 * Backstop for the `user.created` webhook's tenant-metadata write: that
 * write fails the webhook so Clerk retries, but retries are bounded. For
 * users still unsynced afterwards, this sweep READs Clerk's public_metadata
 * and PATCHes it from the DB (the DB is authoritative). A still-broken sync
 * older than `alertAfterHours` pages ops via Sentry; younger failures log at
 * warn (webhook retries may still heal them).
 *
 * Mirrors the setup-reminder-sweep idiom: one eligibility SELECT, per-user
 * try/catch, no-DB no-op, injectable clock and fetch.
 */
import type { Pool } from 'pg';
import type { Logger } from '../logging/logger';
import {
  readClerkUserMetadata,
  writeClerkUserMetadata,
  describeClerkFailure,
} from '../auth/clerk-user-metadata';
import { getSentryClient, type SentryClient } from '../monitoring/sentry';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ClerkMetadataBackfillSweepDeps {
  pool: Pool | null;
  /** Clerk secret key. Empty/absent → the sweep no-ops (warn logged). */
  secretKey: string;
  logger: Logger;
  fetchFn?: typeof fetch;
  /** Injectable Sentry client; defaults to the process-wide client. */
  sentry?: SentryClient;
  now?: () => Date;
  /** How far back to look for users whose metadata may be unsynced. Default 7. */
  lookbackDays?: number;
  /** Age past which a still-broken sync alerts. Default 24 (hours). */
  alertAfterHours?: number;
}

export interface ClerkMetadataBackfillSweepResult {
  candidates: number;
  /** Metadata already matched the DB — nothing to do. */
  inSync: number;
  /** Metadata was missing/mismatched and the PATCH succeeded. */
  backfilled: number;
  /** Read or write failed for this tick. */
  failed: number;
}

interface CandidateRow {
  clerk_user_id: string;
  tenant_id: string;
  role: string;
  created_at: Date;
}

const ELIGIBLE_SQL = `
  SELECT clerk_user_id, tenant_id, role, created_at
    FROM users
   WHERE deleted_at IS NULL
     AND clerk_user_id IS NOT NULL
     AND created_at >= $1
   ORDER BY created_at ASC
   LIMIT 500
`;

export async function runClerkMetadataBackfillSweep(
  deps: ClerkMetadataBackfillSweepDeps,
): Promise<ClerkMetadataBackfillSweepResult> {
  const result: ClerkMetadataBackfillSweepResult = {
    candidates: 0,
    inSync: 0,
    backfilled: 0,
    failed: 0,
  };
  if (!deps.pool) return result;
  if (!deps.secretKey) {
    deps.logger.warn('Clerk metadata backfill sweep: no Clerk secret key — skipping');
    return result;
  }

  const now = deps.now ?? (() => new Date());
  const lookbackDays = deps.lookbackDays ?? 7;
  const alertAfterHours = deps.alertAfterHours ?? 24;
  const createdAfter = new Date(now().getTime() - lookbackDays * DAY_MS);

  let rows: CandidateRow[];
  try {
    const res = await deps.pool.query<CandidateRow>(ELIGIBLE_SQL, [createdAfter]);
    rows = res.rows;
  } catch (err) {
    deps.logger.error('Clerk metadata backfill sweep: eligibility query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  result.candidates = rows.length;
  const sentry = deps.sentry ?? getSentryClient();

  for (const row of rows) {
    try {
      const outcome = await reconcileCandidate(deps, sentry, row, now(), alertAfterHours);
      if (outcome === 'in-sync') result.inSync++;
      else if (outcome === 'backfilled') result.backfilled++;
      else result.failed++;
    } catch (err) {
      result.failed++;
      deps.logger.warn('Clerk metadata backfill sweep: candidate threw', {
        clerkUserId: row.clerk_user_id,
        tenantId: row.tenant_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

async function reconcileCandidate(
  deps: ClerkMetadataBackfillSweepDeps,
  sentry: SentryClient,
  row: CandidateRow,
  now: Date,
  alertAfterHours: number,
): Promise<'in-sync' | 'backfilled' | 'failed'> {
  const client = {
    secretKey: deps.secretKey,
    fetchFn: deps.fetchFn,
    logger: deps.logger,
  };
  const ctx = { clerkUserId: row.clerk_user_id, tenantId: row.tenant_id };
  // Webhook retries are long over for old rows — a still-broken sync is
  // persistent and pages ops; a young failure may still self-heal.
  const ageHours =
    Math.round(
      ((now.getTime() - new Date(row.created_at).getTime()) / (60 * 60 * 1000)) * 10,
    ) / 10;

  const fail = (detail: string): 'failed' => {
    if (ageHours >= alertAfterHours) {
      sentry.captureMessage(
        'Clerk tenant metadata sync persistently failing',
        'error',
      );
      deps.logger.error('Clerk metadata backfill: persistent sync failure', {
        ...ctx,
        ageHours,
        detail,
      });
    } else {
      deps.logger.warn('Clerk metadata backfill: sync failed (webhook retry may still heal)', {
        ...ctx,
        ageHours,
        detail,
      });
    }
    return 'failed';
  };

  const read = await readClerkUserMetadata(client, row.clerk_user_id);
  if (!read.ok) {
    if (read.status === 404) {
      // User gone upstream but the row isn't soft-deleted — the
      // user.deleted webhook either hasn't arrived or failed. Alert like
      // any other persistent failure; do NOT try to PATCH a ghost.
      return fail(`Clerk user not found (HTTP 404)${read.errorBody ? ` — ${read.errorBody}` : ''}`);
    }
    return fail(`metadata read failed: ${describeClerkFailure(read)}`);
  }

  if (read.publicMetadata?.tenant_id === row.tenant_id) {
    return 'in-sync';
  }

  const write = await writeClerkUserMetadata(client, row.clerk_user_id, {
    tenant_id: row.tenant_id,
    role: row.role,
  });
  if (!write.ok) {
    return fail(`metadata write failed: ${describeClerkFailure(write)}`);
  }

  deps.logger.info('Clerk metadata backfill: tenant_id restored', {
    ...ctx,
    previousTenantId: read.publicMetadata?.tenant_id ?? null,
  });
  return 'backfilled';
}
