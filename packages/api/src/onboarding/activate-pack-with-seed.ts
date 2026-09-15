/**
 * B1.19 — single implementation for "activate a vertical pack and seed
 * its defaults," shared by POST /api/onboarding/pack (the form wizard)
 * and the conversational onboarding_tenant_settings /
 * onboarding_service_category execution handlers
 * (proposals/execution/onboarding-handlers.ts). CRITICAL: parity means
 * both write through this one function, never a re-implementation —
 * see routes/onboarding.ts POST /pack for the original.
 */
import type { Pool, PoolClient } from 'pg';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  PackActivationRepository,
  activatePack,
} from '../settings/pack-activation';
import { SettingsRepository, resolveBootstrapAiModel } from '../settings/settings';
import {
  SeedPackDefaultsDeps,
  SeedPackDefaultsResult,
  seedPackDefaults,
} from '../packs/seed-pack-defaults';

export interface ActivatePackWithSeedDeps {
  settingsRepo: SettingsRepository;
  packActivationRepo: PackActivationRepository;
  auditRepo: AuditRepository;
  /**
   * When absent, catalog/template seeding is skipped and the pack is
   * activated (pack_activations row + audit) but the price book / job
   * types stay empty — mirrors the route's own behavior when
   * packSeedDeps isn't wired.
   */
  packSeedDeps?: SeedPackDefaultsDeps;
}

export interface ActivatePackWithSeedInput {
  tenantId: string;
  packId: string;
  actorId: string;
  /**
   * Ambient request-scoped tenant transaction client, when one exists —
   * used to hold the per-(tenant,pack) advisory xact lock that
   * serializes concurrent activations of the SAME pack (see the
   * route's original comment). Omit when calling outside an HTTP
   * request; the execution handlers pass `lockPool` instead (see below).
   */
  lockClient?: Pick<PoolClient, 'query'>;
  /**
   * Review finding #3 (B1.19 follow-up) — fallback lock for call sites with
   * NO ambient request transaction (the execution handlers:
   * `proposals/execution/onboarding-handlers.ts`). `lockClient`'s
   * `pg_try_advisory_xact_lock` only works when the caller already holds a
   * live, multi-statement transaction to release it against; the background
   * executor runs each proposal on its own connection with no such
   * transaction, so taking an XACT lock there via a one-off query would
   * release the instant that single statement's implicit transaction ends —
   * i.e. immediately, before the seed writes it's supposed to guard even
   * start. This was the real gap: two DIFFERENT onboarding proposals from the
   * same conversation (e.g. `onboarding_tenant_settings` +
   * `onboarding_service_category`) targeting the same pack could execute
   * concurrently — each on its own idempotency lock keyed by *proposal id*,
   * which does nothing to serialize them against EACH OTHER — and both pass
   * `seedPackDefaults`'s per-item existence probes before either commits,
   * producing duplicate catalog items and estimate templates.
   *
   * When supplied (and `lockClient` is absent), a dedicated connection is
   * checked out to hold a SESSION-level `pg_try_advisory_lock` on the exact
   * same (tenant, pack) key as the HTTP route's xact lock (same lock space —
   * `hashtextextended('pack:{tenantId}:{packId}', 0)` — so a form-wizard
   * activation and a conversational-onboarding execution can never
   * interleave on the same pack either). Released, and the connection
   * returned, before this function returns. Non-blocking: a losing caller
   * gets `{ status: 'locked' }` immediately, same as the xact-lock path,
   * rather than stalling the execution worker.
   */
  lockPool?: Pool;
}

export type ActivatePackWithSeedResult =
  | { status: 'locked' }
  | { status: 'activated'; seedResult: SeedPackDefaultsResult | null };

export async function activatePackWithSeed(
  input: ActivatePackWithSeedInput,
  deps: ActivatePackWithSeedDeps,
): Promise<ActivatePackWithSeedResult> {
  const { tenantId, packId, actorId, lockClient, lockPool } = input;
  const { settingsRepo, packActivationRepo, auditRepo, packSeedDeps } = deps;

  // #1083 — the guard is taken FIRST, before any write. It used to sit
  // after the tenant_settings read-then-update-or-INSERT below, which meant
  // the loser of the lock still performed a real, unguarded write to a
  // per-tenant table on its way to being told "in progress": two concurrent
  // first-ever activations both observed "no settings row" and both INSERTed,
  // and the loser died at `tenant_settings_tenant_id_key` (raw 23505) before
  // the guard was ever evaluated. That is the difference, for the caller,
  // between "try again" (PACK_ACTIVATION_IN_PROGRESS) and a 500. Every write
  // this function performs — settings included — now happens with the lock
  // held, so a loser returns `{ status: 'locked' }` having written nothing.
  //
  // Serialize pack activation + seed per (tenant, pack). Two concurrent
  // callers for the same tenant+pack could both pass the "already
  // activated" branch and reach the seed probe before either commits;
  // both would then observe an empty catalog/template set and insert a
  // full duplicate. Only taken when the caller supplies a request-scoped
  // client (see lockClient doc above).
  if (lockClient) {
    const lockRes = await lockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked`,
      [`pack:${tenantId}:${packId}`],
    );
    if (!lockRes.rows[0]?.locked) {
      return { status: 'locked' };
    }
  }

  // Review finding #3 — the executor-side fallback: no ambient request
  // transaction exists here, so a xact lock can't be used (see `lockPool`
  // doc above). Take a SESSION-level advisory lock on a dedicated
  // connection instead, held for exactly the activate+seed section below and
  // released before returning. Same lock key/space as the xact-lock branch,
  // so the two paths mutually exclude each other too. Skipped entirely when
  // `lockClient` already served the request (mutually exclusive) or neither
  // is supplied (legacy no-lock callers, e.g. narrow unit tests).
  let lockConn: PoolClient | undefined;
  if (!lockClient && lockPool) {
    lockConn = await lockPool.connect();
    const lockRes = await lockConn.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS locked`,
      [`pack:${tenantId}:${packId}`],
    );
    if (!lockRes.rows[0]?.locked) {
      lockConn.release();
      return { status: 'locked' };
    }
  }

  try {
    // Ensure the tenant has a settings row listing this pack. ONE atomic
    // upsert-and-merge (settings/pg-settings.ts) rather than a read followed
    // by a create-or-update, because the advisory lock above CANNOT protect
    // this write: it is keyed by (tenant, pack) while `tenant_settings` is
    // keyed by tenant alone. Two writers reach the row without holding this
    // pack's key — the sibling `onboarding_tenant_settings` handler, which
    // calls `upsertIdentityFields` before it ever tries the lock
    // (proposals/execution/onboarding-handlers.ts:197), and a concurrent
    // activation of a DIFFERENT pack. A read-then-write here therefore
    // either raises 23505 (which, on the HTTP path, aborts the caller's
    // shared request transaction and 500s the route — #1083's symptom on the
    // winner's side) or silently drops the other activation's entry from the
    // mirror. The statement merges instead, so neither can happen.
    await settingsRepo.ensureActiveVerticalPack(tenantId, packId, resolveBootstrapAiModel());

    try {
      await activatePack({ tenantId, packId }, packActivationRepo);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (!msg.includes('already activated')) {
        throw err;
      }
    }

    // Auto-seed canonical job types, price book, and message-template
    // defaults so the "we'll set this up for you" promise is real.
    // Idempotent: each helper checks for the canonical names first.
    let seedResult: SeedPackDefaultsResult | null = null;
    if (packSeedDeps) {
      seedResult = await seedPackDefaults({ tenantId, packId, actorId }, packSeedDeps);
    }

    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: 'owner',
        eventType: 'tenant.pack_activated',
        entityType: 'tenant_packs',
        entityId: packId,
        metadata: {
          packId,
          ...(seedResult
            ? {
                seedAlreadyApplied: seedResult.alreadySeeded,
                catalogItemsCreated: seedResult.catalogItemsCreated,
                templatesCreated: seedResult.templatesCreated,
              }
            : {}),
        },
      }),
    );

    return { status: 'activated', seedResult };
  } finally {
    if (lockConn) {
      try {
        await lockConn.query(
          `SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`,
          [`pack:${tenantId}:${packId}`],
        );
        lockConn.release();
      } catch {
        // Unlock failed (broken connection / server restart). Destroy the
        // connection instead of returning it: a pooled client that still
        // holds the session-level advisory lock would both leak the slot
        // and block every other holder of this key — same discipline as
        // PgIdempotencyLockProvider (proposals/execution/idempotency-lock.ts).
        lockConn.release(true);
      }
    }
  }
}
