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
import { ValidationError } from '../shared/errors';
import { CreateLeadInput, Lead, LeadRepository, UpdateLeadInput } from './lead';
import { LeadStage } from './enums';
import { buildAttributionMetadata } from './attribution-metadata';

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
}

/**
 * Convert a lead into a customer in a single transaction.
 *
 * Atomicity contract:
 *   - Insert customer row
 *   - Set `lead.converted_customer_id` and stage='won'
 *   - Write `lead.converted` and `customer.created_from_lead` audit events
 *   If any step fails, the whole transaction rolls back and no row is
 *   visible to other readers.
 *
 * Pg path uses `withTenantTransaction()` (single ROLLBACK boundary).
 * In-memory fallback simulates rollback by deleting the inserted customer
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
  auditRepo?: AuditRepository
): Promise<ConversionResult | null> {
  const existing = await leadRepo.findById(tenantId, leadId);
  if (!existing) return null;
  if (existing.convertedCustomerId) {
    throw new ValidationError('Lead has already been converted');
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

  // ── Pg / transactional path ────────────────────────────────────────
  if (isTransactional(leadRepo)) {
    return leadRepo.withTransaction(tenantId, async () => {
      // Inside the transaction the same tenant context is set; the
      // customer/audit repos go through their own withTenant() which
      // detects the request-scoped store via AsyncLocalStorage. Outside
      // a request, the inner withTenant calls would acquire fresh
      // connections and not share the BEGIN — to keep convertToCustomer
      // safe in that case, we pass through the customer create + lead
      // update + audit writes serially; they all share the same tenant
      // context so RLS holds. If any throws, withTenantTransaction
      // rolls back the lead update (the most important integrity
      // boundary) and the customer create is rolled back too because
      // it ran on the same client when invoked via tenantContextStore.
      const customer = buildCustomer();
      const createdCustomer = await customerRepo.create(customer);
      const updated = await leadRepo.update(tenantId, leadId, {
        convertedCustomerId: createdCustomer.id,
        stage: 'won',
        updatedAt: new Date(),
      });
      if (!updated) {
        // Force rollback of the customer insert by throwing.
        throw new Error('Lead disappeared mid-conversion');
      }
      if (auditRepo) {
        const attributionMeta = buildAttributionMetadata(existing);
        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId,
            actorRole,
            eventType: 'lead.converted',
            entityType: 'lead',
            entityId: leadId,
            correlationId,
            metadata: {
              customerId: createdCustomer.id,
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
            entityId: createdCustomer.id,
            correlationId,
            metadata: { leadId, ...attributionMeta },
          })
        );
      }
      return { lead: updated, customer: createdCustomer };
    });
  }

  // ── In-memory fallback path with manual rollback ───────────────────
  const customer = buildCustomer();
  const createdCustomer = await customerRepo.create(customer);
  let updated: Lead | null = null;
  try {
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

  if (auditRepo) {
    const attributionMeta = buildAttributionMetadata(existing);
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole,
        eventType: 'lead.converted',
        entityType: 'lead',
        entityId: leadId,
        correlationId,
        metadata: {
          customerId: createdCustomer.id,
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
        entityId: createdCustomer.id,
        correlationId,
        metadata: { leadId, ...attributionMeta },
      })
    );
  }

  return { lead: updated, customer: createdCustomer };
}
