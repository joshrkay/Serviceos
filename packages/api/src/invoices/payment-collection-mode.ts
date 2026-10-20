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

/**
 * S5a-4 (U8) — the per-tenant payment-mode lock key, hashed with
 * `pg_advisory_xact_lock(hashtext($1))` like `job_number:<tenantId>`.
 * ONE function so the three holders cannot drift: the settings write takes it
 * EXCLUSIVELY whenever its patch names `payment_collection_mode`
 * (`PgSettingsRepository.update`); the guarded link attach
 * (`PgInvoiceRepository.attachPaymentLink`) and the cleanup claim (S5a-5)
 * take it SHARED. A key exists for every tenant, where a settings row may
 * not — so it orders the attach against the FIRST collect-on-site write too.
 */
export function paymentModeLockKey(tenantId: string): string {
  return `payment_mode:${tenantId}`;
}

/**
 * S5a-5 (U8) — the in-transaction mode read the guarded attach and the
 * cleanup claim both run, as a statement of its own after the lock: a
 * missing row and an unset key are both the D-039/D-040 default. One
 * constant so the two reads cannot drift. `$1` is the tenant id.
 */
export const PAYMENT_MODE_READ_SQL = `SELECT COALESCE(
             (SELECT payment_collection_mode FROM tenant_settings WHERE tenant_id = $1),
             'pay_link'
           ) AS mode`;

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

/** Stripe's limit on a Payment Link's `inactive_message`. */
const STRIPE_INACTIVE_MESSAGE_MAX_CHARS = 500;

/** The subject when the business has no name on file — same words the send path uses. */
const NO_BUSINESS_NAME = 'Your service team';

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/**
 * S5a-3 (U8) — what a pay link that was already sent shows once the owner
 * switches to "Collect on the spot": the deactivation sets it as the link's
 * customer-facing inactive message at Stripe. With the owner's first name it
 * is the plan's sentence; without one, the business-name-only sentence
 * (never a placeholder like "the owner"). The names are clipped so the whole
 * message stays within Stripe's 500 characters; the closing words are kept.
 */
export function renderCollectOnSiteInactiveMessage(params: {
  businessName: string;
  ownerFirstName?: string | null;
}): string {
  const business = params.businessName.trim() || NO_BUSINESS_NAME;
  const owner = params.ownerFirstName?.trim() ?? '';
  const middle = ' collects payment in person. Please settle up';
  const end = ' when the work is done.';
  const ownerPart = owner ? ` with ${owner}` : '';
  const fixed = middle.length + end.length;
  const budget = STRIPE_INACTIVE_MESSAGE_MAX_CHARS - fixed;
  // The business name gets the budget first (it is the subject); the owner
  // name takes what is left, and is dropped rather than cut to a stub.
  const subject = clip(business, Math.max(1, budget - Math.min(ownerPart.length, 64)));
  const ownerBudget = budget - subject.length;
  const withOwner = ownerPart && ownerPart.length <= ownerBudget ? ownerPart : '';
  return `${subject}${middle}${withOwner}${end}`;
}
