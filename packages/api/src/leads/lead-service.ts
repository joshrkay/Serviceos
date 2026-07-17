// P9-001: Lead pipeline service.
//
// Stage transitions on a lead are direct PATCHes — they're CRM bookkeeping,
// NOT operational mutations, so they do NOT go through the proposals system.
// Setting `stage = 'won'` from the kanban is just a flag; converting a lead
// into a customer is a separate explicit `convertToCustomer` call with its
// own audit event so future readers don't conflate the two.
import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  Customer,
  CustomerRepository,
  PreferredChannel,
} from '../customers/customer';
import {
  createLocation,
  LocationRepository,
  ServiceLocation,
} from '../locations/location';
import { AppError, ValidationError } from '../shared/errors';
import { CreateLeadInput, Lead, LeadRepository, UpdateLeadInput } from './lead';
import { ConvertLeadAddressInput, LeadSource, LeadStage } from './enums';
import { buildAttributionMetadata } from './attribution-metadata';
import { notifyOwner } from '../notifications/owner-notifications-instance';

/**
 * U6 dedupe — lead sources that originate on the inbound PHONE/CALL channel.
 * Those paths fire `incoming_call` separately, so they must NOT also fire
 * `lead_captured` (no double owner notification for one inbound call/voicemail).
 * A web/manual/referral lead is NOT phone-originated and DOES fire the push.
 */
const PHONE_ORIGINATED_LEAD_SOURCES: ReadonlySet<LeadSource> = new Set(['phone_call']);

export function isPhoneOriginatedLeadSource(source: LeadSource): boolean {
  return PHONE_ORIGINATED_LEAD_SOURCES.has(source);
}

/** Short owner-facing label for a freshly captured lead. */
function leadLabel(lead: Pick<Lead, 'firstName' | 'lastName' | 'companyName' | 'primaryPhone'>): string {
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim();
  return name || lead.companyName || lead.primaryPhone || 'A new lead';
}

/**
 * Fire the owner `lead_captured` push for a newly created lead (best-effort).
 * SUPPRESSED for phone-originated leads — the inbound-call path fires
 * `incoming_call` instead, so this avoids a duplicate owner notification.
 * Never throws — capture must not be disturbed. Exported for unit testing.
 */
export async function notifyOwnerLeadCaptured(tenantId: string, lead: Lead): Promise<void> {
  if (isPhoneOriginatedLeadSource(lead.source)) return;
  try {
    await notifyOwner(tenantId, 'lead_captured', {
      leadId: lead.id,
      leadLabel: leadLabel(lead),
    });
  } catch {
    // Best-effort: the lead already persisted; the push must not bounce it.
  }
}

/**
 * Subset of `PgLeadRepository` capabilities the service needs for the
 * atomic conversion path. InMemory repos won't expose this; the service
 * falls back to a non-atomic best-effort path with manual rollback.
 */
type TransactionalLeadRepo = LeadRepository & {
  withTransaction: <T>(
    tenantId: string,
    fn: (client: unknown) => Promise<T>
  ) => Promise<T>;
};

function isTransactional(repo: LeadRepository): repo is TransactionalLeadRepo {
  return typeof (repo as Partial<TransactionalLeadRepo>).withTransaction === 'function';
}

export async function createLead(
  input: CreateLeadInput,
  leadRepo: LeadRepository,
  auditRepo?: AuditRepository
): Promise<Lead> {
  if (!input.tenantId) throw new ValidationError('tenantId is required');
  if (!input.firstName && !input.companyName) {
    throw new ValidationError('firstName or companyName is required');
  }
  if (!input.createdBy) throw new ValidationError('createdBy is required');

  const now = new Date();
  const lead: Lead = {
    id: uuidv4(),
    tenantId: input.tenantId,
    firstName: input.firstName ?? '',
    lastName: input.lastName ?? '',
    companyName: input.companyName,
    primaryPhone: input.primaryPhone,
    email: input.email,
    source: input.source,
    sourceDetail: input.sourceDetail,
    utmSource: input.utmSource,
    utmMedium: input.utmMedium,
    utmCampaign: input.utmCampaign,
    attribution: input.attribution,
    stage: 'new',
    estimatedValueCents: input.estimatedValueCents,
    notes: input.notes,
    assignedUserId: input.assignedUserId,
    convertedCustomerId: undefined,
    lostReason: undefined,
    street1: input.street1,
    street2: input.street2,
    city: input.city,
    state: input.state,
    postalCode: input.postalCode,
    country: input.country,
    accessNotes: input.accessNotes,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };

  const created = await leadRepo.create(lead);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: input.actorRole ?? 'unknown',
        eventType: 'lead.created',
        entityType: 'lead',
        entityId: created.id,
        metadata: { source: created.source, ...buildAttributionMetadata(created) },
      })
    );
  }

  // U6 — owner `lead_captured` push (best-effort; suppressed for
  // phone-originated leads, which fire `incoming_call` instead).
  await notifyOwnerLeadCaptured(input.tenantId, created);

  return created;
}

export async function updateLead(
  tenantId: string,
  id: string,
  input: UpdateLeadInput,
  leadRepo: LeadRepository,
  actorId?: string,
  actorRole?: string,
  auditRepo?: AuditRepository
): Promise<Lead | null> {
  const existing = await leadRepo.findById(tenantId, id);
  if (!existing) return null;

  // Block manual stage transition into 'won' via this path — promotion to
  // 'won' must go through `convertToCustomer` so the customer row + audit
  // chain are written atomically. Lateral kanban moves (new → contacted →
  // qualified → quoted) and 'lost' (handled by `loseLead`) are fine.
  if (input.stage === 'won' && existing.stage !== 'won') {
    throw new ValidationError(
      "Cannot set stage='won' directly — call convertToCustomer instead"
    );
  }
  if (input.stage === 'lost' && existing.stage !== 'lost') {
    throw new ValidationError(
      "Cannot set stage='lost' directly — call loseLead with a reason instead"
    );
  }

  const updates: Partial<Lead> = {
    // Map nullable inputs to undefined where the entity expects optional
    // (the pg repo translates undefined -> NULL for clearable columns).
    ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
    ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
    ...(input.companyName !== undefined ? { companyName: input.companyName } : {}),
    ...(input.primaryPhone !== undefined ? { primaryPhone: input.primaryPhone } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.sourceDetail !== undefined ? { sourceDetail: input.sourceDetail } : {}),
    ...(input.utmSource !== undefined ? { utmSource: input.utmSource ?? undefined } : {}),
    ...(input.utmMedium !== undefined ? { utmMedium: input.utmMedium ?? undefined } : {}),
    ...(input.utmCampaign !== undefined ? { utmCampaign: input.utmCampaign ?? undefined } : {}),
    ...(input.attribution !== undefined ? { attribution: input.attribution } : {}),
    ...(input.stage !== undefined ? { stage: input.stage } : {}),
    ...(input.estimatedValueCents !== undefined
      ? { estimatedValueCents: input.estimatedValueCents ?? undefined }
      : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.assignedUserId !== undefined
      ? { assignedUserId: input.assignedUserId ?? undefined }
      : {}),
    ...(input.preferredLanguage !== undefined
      ? { preferredLanguage: input.preferredLanguage ?? undefined }
      : {}),
    ...(input.street1 !== undefined ? { street1: input.street1 ?? undefined } : {}),
    ...(input.street2 !== undefined ? { street2: input.street2 ?? undefined } : {}),
    ...(input.city !== undefined ? { city: input.city ?? undefined } : {}),
    ...(input.state !== undefined ? { state: input.state ?? undefined } : {}),
    ...(input.postalCode !== undefined ? { postalCode: input.postalCode ?? undefined } : {}),
    ...(input.country !== undefined ? { country: input.country ?? undefined } : {}),
    ...(input.accessNotes !== undefined ? { accessNotes: input.accessNotes ?? undefined } : {}),
    updatedAt: new Date(),
  };

  const stageChanged = input.stage !== undefined && input.stage !== existing.stage;
  const updated = await leadRepo.update(tenantId, id, updates);

  if (auditRepo && actorId && updated) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: actorRole ?? 'unknown',
        eventType: stageChanged ? 'lead.stage_changed' : 'lead.updated',
        entityType: 'lead',
        entityId: id,
        metadata: stageChanged
          ? { fromStage: existing.stage, toStage: input.stage }
          : { changes: Object.keys(input) },
      })
    );
  }

  return updated;
}

/** Explicit stage-transition helper — wraps `updateLead` for callers that
 *  only want to flip the stage, and emits a `lead.stage_changed` audit. */
export async function transitionStage(
  tenantId: string,
  id: string,
  toStage: LeadStage,
  leadRepo: LeadRepository,
  actorId?: string,
  actorRole?: string,
  auditRepo?: AuditRepository
): Promise<Lead | null> {
  return updateLead(
    tenantId,
    id,
    { stage: toStage },
    leadRepo,
    actorId,
    actorRole,
    auditRepo
  );
}

export async function loseLead(
  tenantId: string,
  id: string,
  reason: string,
  leadRepo: LeadRepository,
  actorId: string,
  actorRole: string,
  auditRepo?: AuditRepository
): Promise<Lead | null> {
  if (!reason || reason.trim().length === 0) {
    throw new ValidationError('reason is required to lose a lead');
  }
  const existing = await leadRepo.findById(tenantId, id);
  if (!existing) return null;

  const updated = await leadRepo.update(tenantId, id, {
    stage: 'lost',
    lostReason: reason.trim(),
    updatedAt: new Date(),
  });

  if (auditRepo && updated) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole,
        eventType: 'lead.lost',
        entityType: 'lead',
        entityId: id,
        metadata: { reason: reason.trim(), fromStage: existing.stage },
      })
    );
  }

  return updated;
}

export interface ConversionResult {
  lead: Lead;
  customer: Customer;
  location: ServiceLocation;
}

export interface ConvertServiceLocationInput {
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  accessNotes?: string;
  label?: string;
}

function isCompleteAddress(addr: {
  street1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}): addr is {
  street1: string;
  city: string;
  state: string;
  postalCode: string;
} {
  return Boolean(addr.street1 && addr.city && addr.state && addr.postalCode);
}

/**
 * Resolve the service address for conversion: body override wins, else
 * the lead's structured address. Incomplete addresses are treated as missing.
 */
export function resolveConvertAddress(
  lead: Lead,
  override?: ConvertLeadAddressInput | ConvertServiceLocationInput
): ConvertServiceLocationInput | null {
  if (override && isCompleteAddress(override)) {
    return {
      street1: override.street1,
      street2: override.street2 ?? undefined,
      city: override.city,
      state: override.state,
      postalCode: override.postalCode,
      country: override.country ?? undefined,
      accessNotes: override.accessNotes ?? undefined,
      label: 'label' in override ? override.label : undefined,
    };
  }
  if (isCompleteAddress(lead)) {
    return {
      street1: lead.street1,
      street2: lead.street2,
      city: lead.city,
      state: lead.state,
      postalCode: lead.postalCode,
      country: lead.country,
      accessNotes: lead.accessNotes,
    };
  }
  return null;
}

/**
 * Convert a lead into a customer in a single transaction.
 *
 * Atomicity contract:
 *   - Insert customer row
 *   - Insert primary service_location from lead address (or convert override)
 *   - Set `lead.converted_customer_id` and stage='won'
 *   - Write `lead.converted` and `customer.created_from_lead` audit events
 *   If any step fails, the whole transaction rolls back and no row is
 *   visible to other readers.
 *
 * Requires a complete service address (lead fields or `serviceLocation`
 * override). Without one, throws `SERVICE_LOCATION_REQUIRED`.
 *
 * Pg path uses `withTenantTransaction()` (single ROLLBACK boundary).
 * In-memory fallback simulates rollback by archiving the inserted customer
 * if the lead update fails — best-effort for tests; production never
 * takes this path because pool is wired.
 */
export async function convertToCustomer(
  tenantId: string,
  leadId: string,
  leadRepo: LeadRepository,
  customerRepo: CustomerRepository,
  actorId: string,
  actorRole: string,
  auditRepo?: AuditRepository,
  locationRepo?: LocationRepository,
  serviceLocation?: ConvertLeadAddressInput | ConvertServiceLocationInput
): Promise<ConversionResult | null> {
  const existing = await leadRepo.findById(tenantId, leadId);
  if (!existing) return null;
  if (existing.convertedCustomerId) {
    throw new ValidationError('Lead has already been converted');
  }

  if (!locationRepo) {
    throw new ValidationError(
      'locationRepo is required to convert a lead (service location creation)'
    );
  }

  const address = resolveConvertAddress(existing, serviceLocation);
  if (!address) {
    throw new AppError(
      'SERVICE_LOCATION_REQUIRED',
      'A service location address is required to convert a lead — provide street1, city, state, and postalCode',
      400
    );
  }

  const correlationId = uuidv4();
  const now = new Date();

  const buildCustomer = (): Customer => {
    const firstName = existing.firstName ?? '';
    const lastName = existing.lastName ?? '';
    const displayName =
      `${firstName} ${lastName}`.trim() || existing.companyName || 'Unknown';
    const preferred: PreferredChannel = existing.email
      ? 'email'
      : existing.primaryPhone
      ? 'phone'
      : 'none';
    return {
      id: uuidv4(),
      tenantId,
      firstName,
      lastName,
      displayName,
      companyName: existing.companyName,
      primaryPhone: existing.primaryPhone,
      secondaryPhone: undefined,
      email: existing.email,
      preferredChannel: preferred,
      smsConsent: false,
      communicationNotes: undefined,
      isArchived: false,
      archivedAt: undefined,
      // Thread source attribution forward — the originating lead id is
      // how downstream jobs/invoices later resolve it (one join away).
      originatingLeadId: existing.id,
      // Preserve the lead's spoken-language preference so customer-facing
      // language resolution (which reads customer.preferredLanguage) doesn't
      // fall back to the tenant default after conversion.
      preferredLanguage: existing.preferredLanguage,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
  };

  const createPrimaryLocation = async (
    customerId: string
  ): Promise<ServiceLocation> => {
    return createLocation(
      {
        tenantId,
        customerId,
        street1: address.street1,
        street2: address.street2,
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        country: address.country || 'US',
        accessNotes: address.accessNotes,
        label: address.label,
        isPrimary: true,
        addressType: 'service',
      },
      locationRepo,
      auditRepo,
      actorId,
      actorRole
    );
  };

  const writeAudits = async (leadIdForAudit: string, customerId: string) => {
    if (!auditRepo) return;
    const attributionMeta = buildAttributionMetadata(existing);
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole,
        eventType: 'lead.converted',
        entityType: 'lead',
        entityId: leadIdForAudit,
        correlationId,
        metadata: {
          customerId,
          fromStage: existing.stage,
          ...attributionMeta,
        },
      })
    );
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole,
        eventType: 'customer.created_from_lead',
        entityType: 'customer',
        entityId: customerId,
        correlationId,
        metadata: { leadId: leadIdForAudit, ...attributionMeta },
      })
    );
  };

  // ── Pg / transactional path ────────────────────────────────────────
  if (isTransactional(leadRepo)) {
    return leadRepo.withTransaction(tenantId, async () => {
      const customer = buildCustomer();
      const createdCustomer = await customerRepo.create(customer);
      const location = await createPrimaryLocation(createdCustomer.id);
      const updated = await leadRepo.update(tenantId, leadId, {
        convertedCustomerId: createdCustomer.id,
        stage: 'won',
        updatedAt: new Date(),
      });
      if (!updated) {
        // Force rollback of the customer insert by throwing.
        throw new Error('Lead disappeared mid-conversion');
      }
      await writeAudits(leadId, createdCustomer.id);
      return { lead: updated, customer: createdCustomer, location };
    });
  }

  // ── In-memory fallback path with manual rollback ───────────────────
  const customer = buildCustomer();
  const createdCustomer = await customerRepo.create(customer);
  let location: ServiceLocation;
  let updated: Lead | null = null;
  try {
    location = await createPrimaryLocation(createdCustomer.id);
    updated = await leadRepo.update(tenantId, leadId, {
      convertedCustomerId: createdCustomer.id,
      stage: 'won',
      updatedAt: new Date(),
    });
    if (!updated) throw new Error('Lead disappeared mid-conversion');
  } catch (err) {
    // Rollback the customer insert — InMemory repos don't expose delete,
    // but they do expose an `update` that can mark archived. We mark it
    // as archived so the test's `findByTenant` (default excludes archived)
    // doesn't see it. Ugly but bounded to the in-memory test path.
    await customerRepo.update(tenantId, createdCustomer.id, {
      isArchived: true,
      archivedAt: new Date(),
      updatedAt: new Date(),
    });
    throw err;
  }

  await writeAudits(leadId, createdCustomer.id);

  return { lead: updated, customer: createdCustomer, location };
}
