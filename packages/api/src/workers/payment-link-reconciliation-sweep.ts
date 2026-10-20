/**
 * S5a-6 (U8, "Pick, don't build" plan) — the daily payment-link
 * reconciliation sweep (P0-009 leader-gated sweep pattern).
 *
 * A switch to "Collect on the spot" enqueues its own cleanup job in the
 * settings transaction (`invoices/payment-mode-change.ts`), and that job
 * enqueues one follow-up pass. This sweep is the backstop for what those
 * cannot see: a job that was lost or dead-lettered, and pay links that
 * predate the choice. Once a day it lists the tenants whose stored
 * `payment_collection_mode` is `collect_on_site` and, for each one that
 * `findOpenWithPaymentLink` says still holds a live link, enqueues a
 * `pass: 1` `deactivate_payment_links` job under
 * `deactivate-payment-links:<tenantId>:sweep:<UTC date>`.
 *
 * These reads only decide whether to enqueue and take no lock: the job's
 * claim re-reads the mode under the payment-mode lock, so a sweep that listed
 * a tenant just before its owner switched back retires nothing (the job is
 * superseded at its first claim). A tenant with no live link costs one query
 * and no job. One tenant's failure is logged and counted; the pass goes on.
 * A failing enumerator fails the pass, so the leader tick records no
 * heartbeat and the missed sweep shows as lag.
 *
 * Per-day keys are deliberate (see the module header of
 * `invoices/payment-mode-change.ts` and
 * `docs/solutions/architecture-patterns/per-tenant-job-shared-idempotency-key.md`):
 * the claim is idempotent at the row, so a sweep job beside a switch's own
 * job never retires a link twice.
 */
import type { Pool } from 'pg';
import type { Logger } from '../logging/logger';
import type { Queue } from '../queues/queue';
import type { InvoiceRepository } from '../invoices/invoice';
import { applyCrossTenantRole, clearTenantContext } from '../db/rls-runtime-role';
import {
  DEACTIVATE_PAYMENT_LINKS_JOB_TYPE,
  deactivatePaymentLinksSweepKey,
  type DeactivatePaymentLinksPayload,
} from '../invoices/payment-mode-change';

/** The UTC hour the once-a-day pass runs in (an hourly tick sweeps only inside it). */
export const PAYMENT_LINK_RECONCILIATION_HOUR_UTC = 3;

/** app.ts tick cadence; the hour gate makes it a once-a-day pass. */
export const PAYMENT_LINK_RECONCILIATION_TICK_MS = 60 * 60_000;

/** Tenants listed per enumerator page (keyset paged, so every tenant is visited). */
const ENUMERATOR_PAGE_SIZE = 500;

export function isPaymentLinkReconciliationHour(now: Date): boolean {
  return now.getUTCHours() === PAYMENT_LINK_RECONCILIATION_HOUR_UTC;
}

/**
 * The production enumerator: every tenant whose stored choice is
 * `collect_on_site`, in tenant-id order. An intentional cross-tenant read, so
 * it runs under the named `rls_cross_tenant` role (a no-op when the RLS
 * runtime role is off), one short transaction per keyset page.
 */
const COLLECT_ON_SITE_TENANTS_SQL = `
  SELECT s.tenant_id
    FROM tenant_settings s
    JOIN tenants t ON t.id = s.tenant_id
   WHERE s.payment_collection_mode = 'collect_on_site'
     AND ($1::uuid IS NULL OR s.tenant_id > $1::uuid)
     -- S6 (U7): add AND NOT t.demo when the tenants.demo column lands
   ORDER BY s.tenant_id
   LIMIT $2
`;

export async function listCollectOnSiteTenantIds(pool: Pool): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  for (;;) {
    const client = await pool.connect();
    let page: string[];
    try {
      await client.query('BEGIN');
      await applyCrossTenantRole(client, { transactional: true });
      const { rows } = await client.query<{ tenant_id: string }>(COLLECT_ON_SITE_TENANTS_SQL, [
        after,
        ENUMERATOR_PAGE_SIZE,
      ]);
      await client.query('COMMIT');
      page = rows.map((r) => String(r.tenant_id));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await clearTenantContext(client);
      client.release();
    }
    ids.push(...page);
    if (page.length < ENUMERATOR_PAGE_SIZE) return ids;
    after = page[page.length - 1];
  }
}

export interface PaymentLinkReconciliationSweepDeps {
  /** The enumerator: `listCollectOnSiteTenantIds(pool)` in production. */
  listCollectOnSiteTenantIds: () => Promise<string[]>;
  invoiceRepo: Pick<InvoiceRepository, 'findOpenWithPaymentLink'>;
  queue: Queue;
  logger: Logger;
  now?: () => Date;
}

export interface PaymentLinkReconciliationSweepResult {
  /** Tenants the enumerator listed as collect-on-site. */
  candidates: number;
  /** Jobs sent (a same-day key already queued is deduped by the queue). */
  enqueued: number;
  /** Collect-on-site tenants with no live link: one query, no job. */
  skipped: number;
  failed: number;
}

export async function runPaymentLinkReconciliationSweep(
  deps: PaymentLinkReconciliationSweepDeps,
): Promise<PaymentLinkReconciliationSweepResult> {
  const at = (deps.now ?? (() => new Date()))();
  const tenantIds = await deps.listCollectOnSiteTenantIds();
  const result: PaymentLinkReconciliationSweepResult = {
    candidates: tenantIds.length,
    enqueued: 0,
    skipped: 0,
    failed: 0,
  };

  for (const tenantId of tenantIds) {
    try {
      const live = await deps.invoiceRepo.findOpenWithPaymentLink(tenantId, null, 1);
      if (live.length === 0) {
        result.skipped++;
        continue;
      }
      const payload: DeactivatePaymentLinksPayload = { tenantId, pass: 1 };
      await deps.queue.send(
        DEACTIVATE_PAYMENT_LINKS_JOB_TYPE,
        payload,
        deactivatePaymentLinksSweepKey(tenantId, at),
      );
      result.enqueued++;
    } catch (err) {
      result.failed++;
      deps.logger.error('Payment-link reconciliation sweep: tenant failed; continuing', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.logger.info('Payment-link reconciliation sweep finished', { ...result });
  return result;
}
