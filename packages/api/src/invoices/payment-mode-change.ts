/**
 * S5a-5 (U8, "Pick, don't build" plan) — what a switch to "Collect on the
 * spot" does to the pay links already out there.
 *
 * A Stripe Payment Link is a standing URL: invoices store it, customers have
 * it in a text, and it charges until it is deactivated at Stripe. Switching
 * `payment_collection_mode` does not touch it. So:
 *
 *  - Atomic enqueue. `onPaymentCollectionModeChanged` runs inside the
 *    settings write's own transaction (the `afterWrite` hook on
 *    `SettingsRepository.update`, which holds the EXCLUSIVE payment-mode
 *    lock when the patch names the key) and, when the stored value moved
 *    from `pay_link` or unset (D-039/D-040: unset IS `pay_link`) to
 *    `collect_on_site`, inserts the `deactivate_payment_links` job row on
 *    that same client (`queue.sendOn`). The job and the new mode commit
 *    together or not at all; no Stripe call runs in a settings write.
 *
 *  - The claim (`claimNextPaymentLink`). One short tenant transaction per
 *    link: the per-tenant cleanup mutex (`payment_cleanup:<tenant>`,
 *    EXCLUSIVE) first, so two cleanups of one tenant take turns; then the
 *    payment-mode key SHARED (the settings write holds it exclusively, the
 *    attach shared), as a statement of its own so the reads after it see a
 *    snapshot from after the grant; then the mode read; then — only on a
 *    successful `collect_on_site` — the next live link after the cursor whose
 *    `cleanup_claimed_at` is null or older than the lease, marked claimed.
 *    The locks end at COMMIT, before the Stripe call; the durable marker is
 *    what keeps a second claimer off the link across that call.
 *
 * Idempotency keys. `docs/solutions/architecture-patterns/per-tenant-job-shared-idempotency-key.md`
 * warns against trigger-specific keys for one per-tenant job: provisioning's
 * side effect (buying a number) was not idempotent at the row, so two jobs
 * meant two purchases. This job may use a key per transition
 * (`…:<settings updated_at>`), per follow-up (`…:pass2`) and per sweep day
 * because its claim IS idempotent at the row: a cleared invoice no longer
 * qualifies and a link under an unexpired lease is skipped, so a second job
 * for the same tenant retires nothing twice. A shared per-tenant key would be
 * wrong here: a completed job's row is deleted, and a second switch minutes
 * later must enqueue again.
 */
import type { Pool, PoolClient } from 'pg';
import type { Queue } from '../queues/queue';
import type { SettingsRepository, SettingsWriteContext } from '../settings/settings';
import type { InMemoryInvoiceRepository } from './invoice';
import { withTenantConnection } from '../db/tenant-transaction';
import {
  PAYMENT_MODE_READ_SQL,
  paymentModeLockKey,
  readPaymentCollectionMode,
} from './payment-collection-mode';

export const DEACTIVATE_PAYMENT_LINKS_JOB_TYPE = 'deactivate_payment_links';

/** A claimed link is excluded from other claimers for this long (crash recovery). */
export const CLEANUP_LEASE_MS = 10 * 60_000;

/** The follow-up pass runs this long after the first. */
export const PASS_2_DELAY_SECONDS = 120;

export interface DeactivatePaymentLinksPayload {
  tenantId: string;
  /** 1 enqueues exactly one follow-up; 2 never enqueues anything (the cap). */
  pass: 1 | 2;
}

/**
 * The SQL predicate for "this invoice can still capture money through a
 * stored hosted link". The repository's `findOpenWithPaymentLink` and the
 * claim both use it, so the definition lives once (migration 322's partial
 * index serves it).
 */
export const LIVE_PAYMENT_LINK_PREDICATE =
  "status IN ('open', 'partially_paid') AND stripe_payment_link_id IS NOT NULL";

/** The cleanup mutex: only claims take it, always before the payment-mode key. */
export function paymentCleanupLockKey(tenantId: string): string {
  return `payment_cleanup:${tenantId}`;
}

/**
 * The job's idempotency key for one mode transition: the settings row's
 * `updated_at` from the locked write (`PgSettingsRepository.update` moves it
 * whenever the patch names the key), so two switches enqueue two jobs and a
 * replay of one switch enqueues nothing new.
 */
export function deactivatePaymentLinksKey(tenantId: string, updatedAt: Date): string {
  return `deactivate-payment-links:${tenantId}:${updatedAt.toISOString()}`;
}

/**
 * S5a-6 — the daily reconciliation sweep's key: one job per tenant per UTC
 * calendar day, so a second sweep the same day enqueues nothing new while
 * that day's job is still queued.
 */
export function deactivatePaymentLinksSweepKey(tenantId: string, at: Date): string {
  return `deactivate-payment-links:${tenantId}:sweep:${at.toISOString().slice(0, 10)}`;
}

/**
 * The follow-up's key: the delivered pass-1 job's own key plus `:pass2` — a
 * key of its own, or the queue's unique index would silently drop it. Derived
 * from the message, so a sweep job's `…:sweep:<date>` key gets its own too.
 */
export function followUpKey(pass1Key: string): string {
  return `${pass1Key}:pass2`;
}

/**
 * The `afterWrite` hook body. Runs in the settings transaction; `ctx.client`
 * is that transaction's client (null on the in-memory repository, which has
 * no transaction to join — the in-memory queue's `send` then stands in).
 */
export async function onPaymentCollectionModeChanged(
  queue: Queue,
  ctx: SettingsWriteContext,
): Promise<void> {
  const prior = ctx.before?.paymentCollectionMode ?? 'pay_link';
  const next = ctx.after.paymentCollectionMode ?? 'pay_link';
  if (prior !== 'pay_link' || next !== 'collect_on_site') return;
  const payload: DeactivatePaymentLinksPayload = { tenantId: ctx.tenantId, pass: 1 };
  const key = deactivatePaymentLinksKey(ctx.tenantId, ctx.after.updatedAt);
  if (ctx.client) {
    await queue.sendOn(ctx.client, DEACTIVATE_PAYMENT_LINKS_JOB_TYPE, payload, key);
  } else {
    await queue.send(DEACTIVATE_PAYMENT_LINKS_JOB_TYPE, payload, key);
  }
}

/** The hook as a `SettingsUpdateOptions.afterWrite` value. */
export function paymentModeChangeHook(queue: Queue): (ctx: SettingsWriteContext) => Promise<void> {
  return (ctx) => onPaymentCollectionModeChanged(queue, ctx);
}

// ─── the claim ───────────────────────────────────────────────────────────────

export type PaymentLinkClaim =
  /** One link claimed; the caller deactivates exactly it, outside any lock. */
  | { kind: 'claimed'; invoiceId: string; linkId: string }
  /** The policy now permits links: stop, deactivate nothing more. */
  | { kind: 'superseded'; modeRead: string }
  /** Collect-on-site still holds and no further live link is claimable. */
  | { kind: 'done' };

export interface PaymentLinkClaimRequest {
  tenantId: string;
  /** Keyset cursor: only invoices with a greater id are candidates. */
  afterId: string | null;
  /**
   * The pass-2 key to enqueue in THIS claim's transaction once it has read
   * `collect_on_site` (the first claim of a pass-1 job); null otherwise.
   */
  followUpKey: string | null;
}

/** A claim throws when either lock or the mode read fails: the unreadable case. */
export type PaymentLinkClaimer = (request: PaymentLinkClaimRequest) => Promise<PaymentLinkClaim>;

/** Bounded retries when a concurrent writer moves the selected row out of the candidate set. */
const MAX_CLAIM_ATTEMPTS = 10;

/**
 * The Postgres claim, on its own tenant connection (RLS runtime role).
 * Statement order is the contract the integration suite pins: cleanup mutex,
 * payment-mode key shared, mode read, candidate select, marker write.
 */
export async function claimNextPaymentLink(
  pool: Pool,
  queue: Queue,
  request: PaymentLinkClaimRequest,
): Promise<PaymentLinkClaim> {
  const { tenantId, afterId, followUpKey: pass2Key } = request;
  return withTenantConnection(pool, tenantId, async (client: PoolClient) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [paymentCleanupLockKey(tenantId)]);
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [paymentModeLockKey(tenantId)]);
    const { rows: modeRows } = await client.query<{ mode: string }>(PAYMENT_MODE_READ_SQL, [tenantId]);
    const mode = modeRows[0]?.mode;
    if (mode !== 'collect_on_site') return { kind: 'superseded', modeRead: mode ?? 'pay_link' };

    if (pass2Key) {
      const payload: DeactivatePaymentLinksPayload = { tenantId, pass: 2 };
      await queue.sendOn(client, DEACTIVATE_PAYMENT_LINKS_JOB_TYPE, payload, pass2Key, {
        delaySeconds: PASS_2_DELAY_SECONDS,
      });
    }

    const leaseSeconds = CLEANUP_LEASE_MS / 1000;
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const { rows } = await client.query<{ id: string; stripe_payment_link_id: string }>(
        `SELECT id, stripe_payment_link_id FROM invoices
          WHERE tenant_id = $1
            AND ${LIVE_PAYMENT_LINK_PREDICATE}
            AND (cleanup_claimed_at IS NULL OR cleanup_claimed_at < now() - make_interval(secs => $3))
            AND ($2::uuid IS NULL OR id > $2::uuid)
          ORDER BY id
          LIMIT 1`,
        [tenantId, afterId, leaseSeconds],
      );
      const candidate = rows[0];
      if (!candidate) return { kind: 'done' };
      // The UPDATE repeats the whole predicate and pins the link id: a clear,
      // void or payment that committed after the SELECT leaves 0 rows, and
      // the next SELECT (a fresh READ COMMITTED snapshot) no longer sees it.
      const { rows: claimed } = await client.query<{ id: string }>(
        `UPDATE invoices
            SET cleanup_claimed_at = now()
          WHERE tenant_id = $1 AND id = $2
            AND stripe_payment_link_id = $3
            AND ${LIVE_PAYMENT_LINK_PREDICATE}
            AND (cleanup_claimed_at IS NULL OR cleanup_claimed_at < now() - make_interval(secs => $4))
          RETURNING id`,
        [tenantId, candidate.id, candidate.stripe_payment_link_id, leaseSeconds],
      );
      if (claimed.length > 0) {
        return { kind: 'claimed', invoiceId: candidate.id, linkId: candidate.stripe_payment_link_id };
      }
    }
    throw new Error('payment link claim did not settle: candidate rows kept changing');
  });
}

export function createPgPaymentLinkClaimer(pool: Pool, queue: Queue): PaymentLinkClaimer {
  return (request) => claimNextPaymentLink(pool, queue, request);
}

/**
 * The in-memory claim, for the in-memory app boot and unit tests: the same
 * rules (mode read first, an error is neither mode, the follow-up only after
 * a `collect_on_site` read, the lease, the marker) over the in-memory
 * repositories. Single-threaded, so there is nothing to lock.
 */
export function createInMemoryPaymentLinkClaimer(deps: {
  invoiceRepo: InMemoryInvoiceRepository;
  settingsRepo: SettingsRepository;
  queue: Queue;
  now?: () => Date;
}): PaymentLinkClaimer {
  const now = deps.now ?? (() => new Date());
  return async ({ tenantId, afterId, followUpKey: pass2Key }) => {
    const read = await readPaymentCollectionMode(deps.settingsRepo, tenantId);
    if (!read.ok) throw read.error;
    if (read.mode !== 'collect_on_site') return { kind: 'superseded', modeRead: read.mode };
    if (pass2Key) {
      const payload: DeactivatePaymentLinksPayload = { tenantId, pass: 2 };
      await deps.queue.send(DEACTIVATE_PAYMENT_LINKS_JOB_TYPE, payload, pass2Key, {
        delaySeconds: PASS_2_DELAY_SECONDS,
      });
    }
    const at = now();
    const leaseCutoff = at.getTime() - CLEANUP_LEASE_MS;
    let cursor = afterId;
    for (;;) {
      const page = await deps.invoiceRepo.findOpenWithPaymentLink(tenantId, cursor, 100);
      if (page.length === 0) return { kind: 'done' };
      const next = page.find(
        (i) => i.cleanupClaimedAt === undefined || i.cleanupClaimedAt.getTime() < leaseCutoff,
      );
      if (next?.stripePaymentLinkId) {
        deps.invoiceRepo.markCleanupClaimed(tenantId, next.id, next.stripePaymentLinkId, at);
        return { kind: 'claimed', invoiceId: next.id, linkId: next.stripePaymentLinkId };
      }
      cursor = page[page.length - 1].id;
    }
  };
}
