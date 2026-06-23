import { MessageDeliveryProvider } from './delivery-provider';
import { DispatchRepository, DispatchEntityType } from './dispatch-repository';
import { DncRepository, normalizePhone } from '../compliance/dnc';
import {
  ConsentEventRepository,
  ConsentEventRow,
  deriveConsentStatus,
} from '../compliance/consent-events';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { Customer } from '../customers/customer';

export type CustomerMessageChannel = 'sms' | 'email';

export interface CustomerMessageDeliveryDeps {
  delivery: MessageDeliveryProvider;
  dispatchRepo: DispatchRepository;
  dncRepo: DncRepository;
  /**
   * U7 — authoritative SMS-consent ledger. When wired, the latest explicit
   * `sms` consent event is the source of truth: a STOP revokes the send even
   * when the denormalized `customer.smsConsent` boolean is stale-true (and an
   * explicit ledger grant allows a send when the boolean is stale-false).
   * Absent → the boolean is the only consent signal (prior behavior).
   */
  consentRepo?: ConsentEventRepository;
  /**
   * U7 — when wired, an SMS suppressed by consent/DNC emits an
   * `sms_blocked_by_compliance` audit event so blocks are observable instead of
   * silently dropped.
   */
  auditRepo?: AuditRepository;
}

export interface SendCustomerMessageInput {
  tenantId: string;
  customer: Customer;
  entityType: DispatchEntityType;
  entityId: string;
  channels: CustomerMessageChannel[];
  smsBody?: string;
  emailSubject?: string;
  emailText?: string;
  emailHtml?: string;
  idempotencyKeyPrefix: string;
}

type SmsComplianceBlock = 'dnc' | 'consent_revoked' | 'no_consent';

/**
 * Latest explicit SMS consent state from the ledger (rows are newest-first), or
 * null when the ledger carries no explicit `sms` grant/revoke for this phone.
 * Only `sms`-kind events count — a recording objection is handled by its own
 * rollup and must not be conflated with text-message consent here.
 */
function latestSmsConsentState(rows: ConsentEventRow[]): 'granted' | 'revoked' | null {
  for (const row of rows) {
    if (row.kind !== 'sms') continue;
    const derived = deriveConsentStatus(row); // 'granted' | 'revoked' | null
    if (derived) return derived;
  }
  return null;
}

/**
 * Decide whether an outbound SMS must be suppressed, and why. ONE combined
 * decision (never a redundant double-block): consent is ledger-authoritative
 * when the ledger is wired, with the denormalized `smsConsent` boolean as the
 * fallback; DNC is the final gate for an otherwise-consented recipient. Returns
 * null when the send is allowed.
 */
async function resolveSmsComplianceBlock(
  deps: CustomerMessageDeliveryDeps,
  tenantId: string,
  customer: Customer,
  phone: string,
): Promise<SmsComplianceBlock | null> {
  let consented: boolean;
  if (deps.consentRepo) {
    const ledger = latestSmsConsentState(await deps.consentRepo.listByPhone(tenantId, phone));
    if (ledger === 'revoked') return 'consent_revoked';
    // Ledger grant wins outright; with no explicit ledger signal, fall back to
    // the boolean rollup.
    consented = ledger === 'granted' || (ledger === null && customer.smsConsent === true);
  } else {
    consented = customer.smsConsent === true;
  }
  if (!consented) return 'no_consent';

  if (await deps.dncRepo.isOnDnc(tenantId, phone)) return 'dnc';

  return null;
}

async function emitComplianceBlockAudit(
  deps: CustomerMessageDeliveryDeps,
  input: SendCustomerMessageInput,
  reason: SmsComplianceBlock,
): Promise<void> {
  if (!deps.auditRepo) return;
  try {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: 'customer-message-delivery',
        actorRole: 'system',
        eventType: 'sms_blocked_by_compliance',
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: {
          reason,
          channel: 'sms',
          customerId: input.customer.id,
        },
      }),
    );
  } catch {
    // Observability is best-effort — it must never block (or unblock) a send.
  }
}

/**
 * Best-effort SMS/email send with SMS consent + DNC gates and dispatch logging.
 * Failures are swallowed so transactional comms never block business mutations.
 * A consent/DNC suppression emits an `sms_blocked_by_compliance` audit (when an
 * auditRepo is wired) rather than dropping silently.
 */
export async function sendCustomerMessage(
  deps: CustomerMessageDeliveryDeps,
  input: SendCustomerMessageInput,
): Promise<void> {
  const { customer, tenantId, channels } = input;

  if (channels.includes('sms') && input.smsBody && customer.primaryPhone) {
    const phone = normalizePhone(customer.primaryPhone);
    const block = await resolveSmsComplianceBlock(deps, tenantId, customer, phone);
    if (block) {
      await emitComplianceBlockAudit(deps, input, block);
    } else {
      const idempotencyKey = `${input.idempotencyKeyPrefix}:sms`;
      try {
        const result = await deps.delivery.sendSms({
          to: customer.primaryPhone,
          body: input.smsBody,
          tenantId,
          idempotencyKey,
        });
        await deps.dispatchRepo.create({
          tenantId,
          entityType: input.entityType,
          entityId: input.entityId,
          channel: 'sms',
          recipient: customer.primaryPhone,
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          status: 'sent',
          idempotencyKey,
        });
      } catch {
        // Best-effort.
      }
    }
  }

  if (
    channels.includes('email') &&
    input.emailSubject &&
    input.emailText &&
    customer.email
  ) {
    const idempotencyKey = `${input.idempotencyKeyPrefix}:email`;
    try {
      const result = await deps.delivery.sendEmail({
        to: customer.email,
        subject: input.emailSubject,
        text: input.emailText,
        html: input.emailHtml,
        tenantId,
        idempotencyKey,
      });
      await deps.dispatchRepo.create({
        tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        channel: 'email',
        recipient: customer.email,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        status: 'sent',
        idempotencyKey,
      });
    } catch {
      // Best-effort.
    }
  }
}
