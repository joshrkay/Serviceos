/**
 * S5a-1 (U8, "Pick, don't build" plan) — the ONE place the stored
 * `payment_collection_mode` policy key is read at a point of behaviour.
 *
 * The onboarding card "When a job's done, how do you want to get paid?"
 * writes `tenant_settings.payment_collection_mode` ('pay_link' |
 * 'collect_on_site'). Every pay surface — the invoice send, the operator
 * "Send payment link", the public invoice page and its checkout / payment
 * intent, the portal list, and (S5a-5/6/7) the cleanup job, the sweep and
 * the spoken payment answer — reads it through `readPaymentCollectionMode`
 * so the three rules below are one function with one unit test:
 *
 *   1. An ABSENT key (a read that succeeds and finds nothing stored) is the
 *      D-039/D-040 default, `pay_link`: a tenant that never answered the
 *      card is unchanged, byte for byte.
 *   2. A STORED value is itself.
 *   3. A read that THROWS is not an unset key. It is `{ ok: false }` and
 *      never `pay_link`: a failed read is no evidence of the approved
 *      policy, and defaulting would mint or text a checkout link for an
 *      owner who chose "Collect on the spot". Consumers fail CLOSED on the
 *      link (none minted, none stored, none in the message, no pay button)
 *      and OPEN on delivery (an invoice still goes out).
 *
 * Nothing is cached across a failure: the next call reads again.
 */
import { AppError, ServiceUnavailableError } from '../shared/errors';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import { createLogger } from '../logging/logger';
import type {
  PaymentCollectionMode,
  SettingsRepository,
  TenantSettings,
} from '../settings/settings';

export type PaymentCollectionModeRead =
  | {
      ok: true;
      mode: PaymentCollectionMode;
      /** `stored` when the row carries the key; `default` when it is unset. */
      source: 'stored' | 'default';
      /** The row the read returned, so a caller that also needs the business name reads once. */
      settings: TenantSettings | null;
    }
  | { ok: false; error: unknown };

/**
 * What a customer-facing surface tells the web about the mode it applied:
 * `unavailable` is the fail-closed outcome of a read that threw.
 */
export type PaymentCollectionModeView = PaymentCollectionMode | 'unavailable';

/** The surfaces that record `invoice.payment_mode_unavailable`. */
export type PaymentModeSurface =
  | 'send'
  | 'public_page'
  | 'portal'
  | 'checkout'
  | 'payment_intent'
  | 'cleanup';

export const PAYMENT_MODE_UNAVAILABLE_EVENT = 'invoice.payment_mode_unavailable';

const logger = createLogger({
  service: 'payment-collection-mode',
  environment: process.env.NODE_ENV || 'dev',
});

export async function readPaymentCollectionMode(
  settingsRepo: SettingsRepository,
  tenantId: string,
): Promise<PaymentCollectionModeRead> {
  let settings: TenantSettings | null;
  try {
    settings = await settingsRepo.findByTenant(tenantId);
  } catch (error) {
    return { ok: false, error };
  }
  const stored = settings?.paymentCollectionMode ?? null;
  if (stored === null) {
    return { ok: true, mode: 'pay_link', source: 'default', settings };
  }
  return { ok: true, mode: stored, source: 'stored', settings };
}

/**
 * Best-effort log + audit of one failed-read occurrence. With an invoice id
 * the event lands on the invoice; without one (the portal list, the cleanup
 * job) on the tenant. Never throws into the pay surface that called it.
 */
export async function auditPaymentModeUnavailable(
  auditRepo: AuditRepository | undefined,
  params: {
    tenantId: string;
    invoiceId?: string;
    surface: PaymentModeSurface;
    error: unknown;
  },
): Promise<void> {
  const { tenantId, invoiceId, surface, error } = params;
  const message = error instanceof Error ? error.message : String(error);
  logger.warn('payment_collection_mode could not be read; the surface failed closed on the link', {
    tenantId,
    invoiceId,
    surface,
    error: message,
  });
  if (!auditRepo) return;
  await auditRepo
    .create(
      createAuditEvent({
        tenantId,
        actorId: 'system',
        actorRole: 'system',
        eventType: PAYMENT_MODE_UNAVAILABLE_EVENT,
        entityType: invoiceId ? 'invoice' : 'tenant',
        entityId: invoiceId ?? tenantId,
        metadata: {
          reason: 'payment_mode_unavailable',
          surface,
          error: message,
        },
      }),
    )
    .catch(() => undefined);
}

/** 409 — the owner chose "Collect on the spot"; no pay link exists for this business. */
export class CollectOnSiteError extends AppError {
  constructor() {
    super('COLLECT_ON_SITE', 'This business collects payment in person.', 409);
    this.name = 'CollectOnSiteError';
  }
}

/** 503 — the policy could not be read; retryable, and never a reason to mint. */
export class PaymentModeUnavailableError extends ServiceUnavailableError {
  constructor() {
    super(
      'Payment options are not available right now. Try again in a moment.',
      'PAYMENT_MODE_UNAVAILABLE',
    );
    this.name = 'PaymentModeUnavailableError';
  }
}
