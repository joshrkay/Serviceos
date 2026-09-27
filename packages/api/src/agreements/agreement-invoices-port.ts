/**
 * The production `InvoicesServicePort` for the recurring-agreements sweep
 * (P9-003 / §8.12 memberships).
 *
 * Lives in its own module — not inline in app.ts — so the integration suite
 * drives the SAME port that ships instead of a hand-copied replica (the
 * replica is how the #1058 gaps hid behind "verbatim in shape" tests).
 *
 * #1058 — a membership cycle bills ITSELF on every path, not only when the
 * owner opted into auto-collect with a saved card:
 *   - the invoice is numbered off the tenant's invoice sequence
 *     (`createInvoiceWithNextNumber`), never `AGREEMENT-<epoch ms>` — no hole
 *     in the books and no same-millisecond collision on idx_invoices_number;
 *   - it is ISSUED immediately (draft → open) with a due date on the tenant's
 *     default payment terms, so the overdue/dunning cadence can select it;
 *   - the issuance is audited (`invoice.issued`, system actor).
 * The auto-collect branch's `ensureIssuedAmountDue` then finds it already
 * open and charges its amount due, exactly as before.
 *
 * The port method keeps its historical name `createDraftInvoice` (the
 * InvoicesServicePort contract other callers and tests use); what it returns
 * is an issued invoice.
 */
import type { InvoicesServicePort } from './agreement-service';
import type { InvoiceRepository } from '../invoices/invoice';
import { createInvoiceWithNextNumber, issueInvoice } from '../invoices/invoice';
import type { SettingsRepository } from '../settings/settings';
import { AuditRepository, createAuditEvent } from '../audit/audit';

/** Fallback when the tenant has no settings row / no configured terms. */
export const AGREEMENT_DEFAULT_PAYMENT_TERM_DAYS = 30;

export interface AgreementInvoicesDeps {
  invoiceRepo: InvoiceRepository;
  settingsRepo: SettingsRepository;
  auditRepo?: AuditRepository;
}

export function createAgreementInvoicesService(
  deps: AgreementInvoicesDeps,
): InvoicesServicePort {
  return {
    async createDraftInvoice(input) {
      const created = await createInvoiceWithNextNumber(
        {
          tenantId: input.tenantId,
          jobId: input.jobId,
          lineItems: [
            {
              id: `agreement-${Date.now()}`,
              description: input.description,
              quantity: 1,
              unitPriceCents: input.priceCents,
              totalCents: input.priceCents,
              sortOrder: 0,
              taxable: false,
            },
          ],
          customerMessage: undefined,
          createdBy: input.createdBy,
        },
        deps.invoiceRepo,
        deps.settingsRepo,
        deps.auditRepo,
      );

      const settings = await deps.settingsRepo.findByTenant(input.tenantId);
      const termDays =
        settings?.defaultPaymentTermDays ?? AGREEMENT_DEFAULT_PAYMENT_TERM_DAYS;
      const issued = await issueInvoice(
        input.tenantId,
        created.id,
        termDays,
        deps.invoiceRepo,
      );
      if (!issued) {
        throw new Error(`Dues invoice ${created.id} vanished before it could be issued`);
      }

      if (deps.auditRepo) {
        // Failure-soft: the invoice is already open and linked to the run by
        // the caller; an audit outage must not orphan it by failing the run.
        try {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId: input.tenantId,
              actorId: 'system:agreements-worker',
              actorRole: 'system',
              eventType: 'invoice.issued',
              entityType: 'invoice',
              entityId: issued.id,
              metadata: {
                source: 'service_agreement',
                invoiceNumber: issued.invoiceNumber,
                paymentTermDays: termDays,
                issuedAt: issued.issuedAt?.toISOString(),
                dueDate: issued.dueDate?.toISOString(),
                amountDueCents: issued.amountDueCents,
              },
            }),
          );
        } catch {
          // swallow — see above
        }
      }

      return { id: issued.id };
    },
  };
}
