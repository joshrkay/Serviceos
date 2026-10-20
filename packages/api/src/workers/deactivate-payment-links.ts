/**
 * S5a-5 (U8, "Pick, don't build" plan) — the `deactivate_payment_links`
 * queue handler (P0-009 async-worker pattern, the `provision-twilio` handler
 * shape).
 *
 * The owner switched to "Collect on the spot" and the settings write
 * enqueued this job in its own transaction (`invoices/payment-mode-change.ts`).
 * The job loops claim → act → advance until a claim says stop:
 *
 *  - claim: one short locked transaction that re-reads the mode and marks
 *    exactly one live link claimed (`PaymentLinkClaimer`);
 *  - act: OUTSIDE any lock or transaction, `deactivateInvoicePaymentLink`
 *    with reason `payment_mode_changed` on exactly the claimed link — it
 *    deactivates under the minting scope, sets the customer-facing inactive
 *    message, clears the columns only while they still hold that link (which
 *    also drops the claim), and audits; a failed call keeps the columns,
 *    releases the claim and is audited;
 *  - advance: the cursor moves past the claimed invoice either way, so a
 *    failing invoice is not claimed again in the same run.
 *
 * Stops: `superseded` (the claim read anything but a successful
 * `collect_on_site`: the policy now permits links — succeed, no retry,
 * enqueue nothing); `done` (no further claimable link — throw afterwards when
 * any invoice failed, so the queue retries only what is left); a claim that
 * THROWS (a lock or the mode read failed: the policy is unknown, so nothing
 * is deactivated) audits `invoice.payment_mode_unavailable` at tenant level
 * with surface `cleanup` and rethrows for the queue's retry.
 *
 * Pass 2: the first claim of a `pass: 1` job enqueues one `pass: 2` follow-up
 * in its own transaction (`<this job's key>:pass2`, 120 s). The cap is the
 * payload's `pass`, never the key: a `pass: 2` job enqueues nothing.
 */
import type { QueueMessage, WorkerHandler } from '../queues/queue';
import type { Logger } from '../logging/logger';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import type { Invoice, InvoiceRepository } from '../invoices/invoice';
import type { PaymentLinkProvider } from '../payments/payment-link-provider';
import type { ConnectAccountResolver } from '../invoices/public-invoice-service';
import type { SettingsRepository } from '../settings/settings';
import type { UserRepository } from '../users/user';
import { deactivateInvoicePaymentLink } from '../invoices/invoice-payment-link';
import {
  auditPaymentModeUnavailable,
  renderCollectOnSiteInactiveMessage,
} from '../invoices/payment-collection-mode';
import {
  DEACTIVATE_PAYMENT_LINKS_JOB_TYPE,
  followUpKey,
  type DeactivatePaymentLinksPayload,
  type PaymentLinkClaim,
  type PaymentLinkClaimer,
} from '../invoices/payment-mode-change';

export interface DeactivatePaymentLinksWorkerDeps {
  claimNext: PaymentLinkClaimer;
  invoiceRepo: InvoiceRepository;
  provider: PaymentLinkProvider;
  connectAccountResolver?: ConnectAccountResolver;
  /** The business name for the inactive message. */
  settingsRepo: SettingsRepository;
  /** The owner's first name for the inactive message (optional). */
  userRepo?: Pick<UserRepository, 'findByTenant'>;
  auditRepo: AuditRepository;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDeactivatePaymentLinksPayload(value: unknown): value is DeactivatePaymentLinksPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<DeactivatePaymentLinksPayload>;
  return typeof v.tenantId === 'string' && UUID_RE.test(v.tenantId) && (v.pass === 1 || v.pass === 2);
}

export function createDeactivatePaymentLinksWorker(
  deps: DeactivatePaymentLinksWorkerDeps,
): WorkerHandler<DeactivatePaymentLinksPayload> {
  /**
   * What an already-sent link's hosted page says once it is dead. Read once
   * per job and only when a link is actually claimed; a failed read never
   * blocks the cleanup — it falls back to the business-only sentence.
   */
  async function inactiveMessageFor(tenantId: string): Promise<string> {
    const [settings, ownerFirstName] = await Promise.all([
      deps.settingsRepo.findByTenant(tenantId).catch(() => null),
      deps.userRepo
        ? deps.userRepo
            .findByTenant(tenantId, { role: 'owner' })
            .then((owners) => owners.find((u) => u.status !== 'suspended' && u.firstName?.trim())?.firstName ?? null)
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    return renderCollectOnSiteInactiveMessage({
      businessName: settings?.businessName ?? '',
      ownerFirstName,
    });
  }

  async function audit(
    tenantId: string,
    eventType: 'payment_links.cleanup_superseded' | 'payment_links.cleanup_completed',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: 'system',
        actorRole: 'system',
        eventType,
        entityType: 'tenant',
        entityId: tenantId,
        metadata,
      }),
    );
  }

  return {
    type: DEACTIVATE_PAYMENT_LINKS_JOB_TYPE,
    async handle(message: QueueMessage<DeactivatePaymentLinksPayload>, log: Logger): Promise<void> {
      const payload: unknown = message.payload;
      if (!isDeactivatePaymentLinksPayload(payload)) {
        // Malformed jobs must not retry forever — log loudly and drop.
        log.error('deactivate_payment_links: malformed payload — dropping', {
          idempotencyKey: message.idempotencyKey,
        });
        return;
      }
      const { tenantId, pass } = payload;

      let afterId: string | null = null;
      // Only the FIRST claim of a pass-1 job carries the follow-up.
      let pass2Key: string | null = pass === 1 ? followUpKey(message.idempotencyKey) : null;
      let inactiveMessage: string | undefined;
      let deactivated = 0;
      let failed = 0;

      for (;;) {
        let claim: PaymentLinkClaim;
        try {
          claim = await deps.claimNext({ tenantId, afterId, followUpKey: pass2Key });
        } catch (error) {
          await auditPaymentModeUnavailable(deps.auditRepo, { tenantId, surface: 'cleanup', error });
          throw error;
        }
        pass2Key = null;

        if (claim.kind === 'superseded') {
          log.info('deactivate_payment_links: superseded — the policy permits pay links again', {
            tenantId,
            pass,
            modeRead: claim.modeRead,
          });
          await audit(tenantId, 'payment_links.cleanup_superseded', {
            pass,
            modeRead: claim.modeRead,
            deactivated,
            failed,
          });
          return;
        }

        if (claim.kind === 'done') {
          await audit(tenantId, 'payment_links.cleanup_completed', { pass, deactivated, failed });
          if (failed > 0) {
            throw new Error(
              `deactivate_payment_links: ${failed} pay link(s) failed to deactivate for tenant ${tenantId}; retrying`,
            );
          }
          return;
        }

        afterId = claim.invoiceId;
        let invoice: Invoice | null;
        try {
          invoice = await deps.invoiceRepo.findById(tenantId, claim.invoiceId);
        } catch (error) {
          // Could not re-read the claimed row: hand the claim back so the
          // retry this failure triggers reclaims it at once.
          failed++;
          await deps.invoiceRepo.releaseCleanupClaim(tenantId, claim.invoiceId, claim.linkId).catch(() => false);
          log.warn('deactivate_payment_links: claimed invoice could not be read; claim released', {
            tenantId,
            invoiceId: claim.invoiceId,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        // The row no longer holds the claimed link: it was cleared (and so
        // deactivated) elsewhere after the claim committed — nothing to do.
        if (!invoice || invoice.stripePaymentLinkId !== claim.linkId) continue;

        inactiveMessage ??= await inactiveMessageFor(tenantId);
        const result = await deactivateInvoicePaymentLink({
          tenantId,
          invoice: { ...invoice, stripePaymentLinkId: claim.linkId },
          reason: 'payment_mode_changed',
          invoiceRepo: deps.invoiceRepo,
          provider: deps.provider,
          connectAccountResolver: deps.connectAccountResolver,
          auditRepo: deps.auditRepo,
          inactiveMessage,
          claimed: true,
        });
        if (result.deactivated) deactivated++;
        else failed++;
      }
    },
  };
}
