import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors';
import { FinancingProviderClient } from './financing-provider';

/**
 * FIN (Jobber parity) — consumer financing on invoices.
 *
 * Jobber bundles Wisetack so a shop can offer "buy now / pay over time" on a
 * job. We model a FinancingApplication tied to an invoice: the owner offers
 * financing (we ask the provider for a consumer application link), the customer
 * applies, and the provider drives the application to a terminal state
 * (approved → funded, or declined/expired). Provider calls go through the
 * FinancingProviderClient abstraction (Wisetack live, Manual fallback), so the
 * orchestration here is provider-agnostic and unit-testable with a mock.
 */

export type FinancingProvider = 'wisetack' | 'manual';

export type FinancingStatus =
  | 'offered'
  | 'prequalified'
  | 'approved'
  | 'declined'
  | 'funded'
  | 'expired'
  | 'canceled';

export const FINANCING_STATUSES: readonly FinancingStatus[] = [
  'offered',
  'prequalified',
  'approved',
  'declined',
  'funded',
  'expired',
  'canceled',
];

/** Terminal states never transition further. */
export const FINANCING_TERMINAL: readonly FinancingStatus[] = ['funded', 'declined', 'expired', 'canceled'];

export interface FinancingApplication {
  id: string;
  tenantId: string;
  invoiceId: string;
  customerId: string | null;
  amountCents: number;
  provider: FinancingProvider;
  /** Provider-side application/transaction id (null for manual). */
  externalId: string | null;
  /** Consumer-facing apply URL (null for manual). */
  applicationUrl: string | null;
  status: FinancingStatus;
  statusReason: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OfferFinancingInput {
  tenantId: string;
  invoiceId: string;
  customerId?: string | null;
  amountCents: number;
  invoiceNumber: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  returnUrl?: string;
  createdBy: string;
  actorRole?: string;
}

export interface FinancingRepository {
  create(application: FinancingApplication): Promise<FinancingApplication>;
  findById(tenantId: string, id: string): Promise<FinancingApplication | null>;
  listByInvoice(tenantId: string, invoiceId: string): Promise<FinancingApplication[]>;
  updateStatus(
    tenantId: string,
    id: string,
    status: FinancingStatus,
    statusReason: string | null
  ): Promise<FinancingApplication | null>;
}

/** Minimum financeable ticket (cents). Wisetack-style floor; below this, decline up front. */
export const FINANCING_MIN_CENTS = 50_00;

export function validateOfferFinancing(input: { amountCents?: number }): string[] {
  const errors: string[] = [];
  if (
    typeof input.amountCents !== 'number' ||
    !Number.isInteger(input.amountCents) ||
    input.amountCents <= 0
  ) {
    errors.push('amountCents must be a positive integer (cents)');
  } else if (input.amountCents < FINANCING_MIN_CENTS) {
    errors.push(`amount must be at least $${(FINANCING_MIN_CENTS / 100).toFixed(0)} to finance`);
  }
  return errors;
}

export async function offerFinancing(
  input: OfferFinancingInput,
  repository: FinancingRepository,
  provider: FinancingProviderClient,
  auditRepo?: AuditRepository
): Promise<FinancingApplication> {
  const errors = validateOfferFinancing(input);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const id = uuidv4();
  // The provider echoes our applicationId back on its webhook so we can resolve
  // the row without a cross-tenant scan.
  const result = await provider.createApplication(
    {
      applicationId: id,
      tenantId: input.tenantId,
      amountCents: input.amountCents,
      invoiceNumber: input.invoiceNumber,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      returnUrl: input.returnUrl,
    },
    id
  );

  const now = new Date();
  const application: FinancingApplication = {
    id,
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    customerId: input.customerId ?? null,
    amountCents: input.amountCents,
    provider: provider.name,
    externalId: result.externalId,
    applicationUrl: result.applicationUrl,
    status: result.status,
    statusReason: null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  const created = await repository.create(application);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: input.actorRole ?? 'unknown',
        eventType: 'financing.offered',
        entityType: 'invoice',
        entityId: input.invoiceId,
        metadata: {
          financingApplicationId: created.id,
          provider: created.provider,
          amountCents: created.amountCents,
        },
      })
    );
  }
  return created;
}

/**
 * Apply a provider status update (from a verified webhook). No-ops if the
 * application is already in a terminal state, or if the transition would move
 * backwards out of terminal — keeping the record monotonic.
 */
export async function applyFinancingStatusUpdate(
  tenantId: string,
  applicationId: string,
  status: FinancingStatus,
  statusReason: string | null,
  repository: FinancingRepository,
  auditRepo?: AuditRepository
): Promise<FinancingApplication | null> {
  const existing = await repository.findById(tenantId, applicationId);
  if (!existing) return null;
  if (FINANCING_TERMINAL.includes(existing.status)) return existing; // already settled

  const updated = await repository.updateStatus(tenantId, applicationId, status, statusReason);
  if (updated && auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId: 'system',
        actorRole: 'system',
        eventType: 'financing.status_changed',
        entityType: 'invoice',
        entityId: updated.invoiceId,
        metadata: { financingApplicationId: updated.id, status, statusReason },
      })
    );
  }
  return updated;
}

export class InMemoryFinancingRepository implements FinancingRepository {
  private apps: Map<string, FinancingApplication> = new Map();

  async create(application: FinancingApplication): Promise<FinancingApplication> {
    this.apps.set(application.id, { ...application });
    return { ...application };
  }

  async findById(tenantId: string, id: string): Promise<FinancingApplication | null> {
    const a = this.apps.get(id);
    if (!a || a.tenantId !== tenantId) return null;
    return { ...a };
  }

  async listByInvoice(tenantId: string, invoiceId: string): Promise<FinancingApplication[]> {
    return Array.from(this.apps.values())
      .filter((a) => a.tenantId === tenantId && a.invoiceId === invoiceId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((a) => ({ ...a }));
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: FinancingStatus,
    statusReason: string | null
  ): Promise<FinancingApplication | null> {
    const a = this.apps.get(id);
    if (!a || a.tenantId !== tenantId) return null;
    const updated = { ...a, status, statusReason, updatedAt: new Date() };
    this.apps.set(id, updated);
    return { ...updated };
  }
}
