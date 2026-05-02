import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../../audit/audit';
import { Lead, LeadRepository } from '../../leads/lead';
import { normalizePhone } from '../../shared/phone';
import { maskPhone } from '../../telephony/twilio-call-control';

export interface FindOrCreateLeadInput {
  tenantId: string;
  /** Raw phone number as received from Twilio (e.g. '+15125550100'). */
  fromPhone: string;
  leadRepo: LeadRepository;
  auditRepo?: AuditRepository;
  /** Defaults to 'system:inbound-call'. */
  systemActorId?: string;
}

export type FindOrCreateLeadResult =
  | { status: 'found'; leadId: string; lead: Lead }
  | { status: 'created'; leadId: string; lead: Lead };

/**
 * Look up an existing open lead by phone, or create a new `phone_call`
 * lead for an unknown caller. Used by the inbound-call adapter so the
 * AI receptionist's "unknown caller" branch lands in the CRM kanban
 * automatically.
 *
 * Idempotency: races between two concurrent calls to this skill (or
 * between a SELECT and a manual insert) are caught by the partial
 * unique index on `(tenant_id, phone_normalized) WHERE phone_normalized
 * <> '' AND converted_customer_id IS NULL`. On `23505` we re-SELECT
 * and return the winner.
 */
export async function findOrCreateLeadByPhone(
  input: FindOrCreateLeadInput
): Promise<FindOrCreateLeadResult> {
  const {
    tenantId,
    fromPhone,
    leadRepo,
    auditRepo,
    systemActorId = 'system:inbound-call',
  } = input;

  const normalized = normalizePhone(fromPhone);

  // Phone too short to identify reliably — still create a lead so the
  // call is captured, but skip the dedupe lookup.
  if (normalized.length >= 7) {
    const existing = await leadRepo.findByPhoneNormalized(tenantId, normalized);
    if (existing) {
      return { status: 'found', leadId: existing.id, lead: existing };
    }
  }

  try {
    return await createNewLead({
      tenantId,
      rawPhone: fromPhone,
      leadRepo,
      auditRepo,
      systemActorId,
    });
  } catch (err) {
    if (isUniqueViolation(err) && normalized.length >= 7) {
      const winner = await leadRepo.findByPhoneNormalized(tenantId, normalized);
      if (winner) {
        return { status: 'found', leadId: winner.id, lead: winner };
      }
    }
    throw err;
  }
}

async function createNewLead(opts: {
  tenantId: string;
  rawPhone: string;
  leadRepo: LeadRepository;
  auditRepo?: AuditRepository;
  systemActorId: string;
}): Promise<FindOrCreateLeadResult> {
  const now = new Date();
  const lead: Lead = {
    id: uuidv4(),
    tenantId: opts.tenantId,
    firstName: '',
    lastName: '',
    companyName: undefined,
    primaryPhone: opts.rawPhone,
    email: undefined,
    source: 'phone_call',
    sourceDetail: `Inbound call from ${maskPhone(opts.rawPhone)}`,
    stage: 'new',
    estimatedValueCents: undefined,
    notes: undefined,
    assignedUserId: undefined,
    convertedCustomerId: undefined,
    lostReason: undefined,
    createdBy: opts.systemActorId,
    createdAt: now,
    updatedAt: now,
  };

  const created = await opts.leadRepo.create(lead);

  if (opts.auditRepo) {
    await opts.auditRepo.create(
      createAuditEvent({
        tenantId: opts.tenantId,
        actorId: opts.systemActorId,
        actorRole: 'system',
        eventType: 'lead.created',
        entityType: 'lead',
        entityId: created.id,
        metadata: { source: 'phone_call', via: 'inbound_call_skill' },
      })
    );
  }

  return { status: 'created', leadId: created.id, lead: created };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505'
  );
}
