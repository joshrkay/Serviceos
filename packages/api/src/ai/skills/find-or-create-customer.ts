import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { Customer, CustomerRepository } from '../../customers/customer';
import { normalizePhone } from '../../shared/phone';
import { maskPhone } from '../../telephony/twilio-call-control';

export interface FindOrCreateCustomerByPhoneInput {
  tenantId: string;
  /** Raw phone number as received from Twilio (e.g. '+15125550100'). */
  fromPhone: string;
  customerRepo: CustomerRepository;
  auditRepo?: Pick<AuditRepository, 'create'>;
  /** Defaults to 'system:inbound-call'. */
  systemActorId?: string;
  /** Identity captured during the call, when the caller gave a name. */
  firstName?: string;
  lastName?: string;
  companyName?: string;
  /** Audit metadata `via` tag. Defaults to 'inbound_call_skill'. */
  auditVia?: string;
}

export type FindOrCreateCustomerByPhoneResult =
  | { status: 'found'; customerId: string; customer: Customer }
  | { status: 'created'; customerId: string; customer: Customer };

/**
 * Display name for a customer minted from an inbound call: the spoken name if
 * we captured one, else the company, else a masked-phone placeholder so the
 * row is recognizable in the inbox/timeline ("Caller •••1234") rather than
 * blank. Pure, so it's unit-tested.
 */
export function callerDisplayName(input: {
  firstName?: string;
  lastName?: string;
  companyName?: string;
  rawPhone: string;
}): string {
  const name = `${input.firstName ?? ''} ${input.lastName ?? ''}`.trim();
  return name || input.companyName?.trim() || `Caller ${maskPhone(input.rawPhone)}`;
}

/**
 * Look up an existing customer by the caller's phone number, or create one when
 * none matches. The inbound-call counterpart of {@link findOrCreateLeadByPhone}
 * — used when the AI receptionist needs a real CUSTOMER (not just a CRM lead)
 * to hang a booked appointment + the call record off of.
 *
 * Lookup uses the repo's tolerant `phone_normalized` tail match (same as
 * caller-ID identification); the newest non-archived match wins, falling back
 * to the newest match overall. Unlike leads, the customers table has no
 * unique phone constraint (duplicate phones are allowed by design), so this
 * does a plain find-then-create with no 23505 recovery.
 */
export async function findOrCreateCustomerByPhone(
  input: FindOrCreateCustomerByPhoneInput,
): Promise<FindOrCreateCustomerByPhoneResult> {
  const {
    tenantId,
    fromPhone,
    customerRepo,
    auditRepo,
    systemActorId = 'system:inbound-call',
    firstName,
    lastName,
    companyName,
    auditVia = 'inbound_call_skill',
  } = input;

  const normalized = normalizePhone(fromPhone);

  // Phone too short to identify reliably — still create the customer so the
  // call is captured, but skip the (false-positive-prone) tail lookup.
  if (normalized.length >= 7 && customerRepo.findByPhoneNormalized) {
    const matches = await customerRepo.findByPhoneNormalized(tenantId, normalized);
    const existing = matches.find((c) => !c.isArchived) ?? matches[0];
    if (existing) return { status: 'found', customerId: existing.id, customer: existing };
  }

  const now = new Date();
  const customer: Customer = {
    id: uuidv4(),
    tenantId,
    firstName: firstName ?? '',
    lastName: lastName ?? '',
    displayName: callerDisplayName({ firstName, lastName, companyName, rawPhone: fromPhone }),
    companyName,
    primaryPhone: fromPhone,
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: systemActorId,
    createdAt: now,
    updatedAt: now,
  };
  const created = await customerRepo.create(customer);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: systemActorId,
        actorRole: 'system',
        eventType: 'customer.created',
        entityType: 'customer',
        entityId: created.id,
        metadata: { via: auditVia, source: 'inbound_call' },
      }),
    );
  }

  return { status: 'created', customerId: created.id, customer: created };
}
