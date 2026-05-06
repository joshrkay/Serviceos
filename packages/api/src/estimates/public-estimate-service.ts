import { Estimate, EstimateRepository } from './estimate';
import { CustomerRepository } from '../customers/customer';
import { JobRepository } from '../jobs/job';
import { SettingsRepository } from '../settings/settings';
import { evaluateDepositRule, deriveDepositStatus } from '../jobs/deposit-rule';
import { ValidationError, NotFoundError, ConflictError } from '../shared/errors';

/**
 * Service layer for the unauthenticated customer-facing estimate
 * approval flow at `/public/estimates/:token`. Routes call into here
 * so token validation, idempotency, and entity transitions live in one
 * place — the routes handle HTTP shape and audit context (IP, UA).
 *
 * Approval and decline are deliberately NOT auto-converted to
 * invoices here: that's a downstream concern owned by the future
 * estimate agent. We just record customer intent + transition the
 * estimate, then emit an audit event the dispatcher can react to.
 */

export interface PublicEstimateView {
  id: string;
  estimateNumber: string;
  status: Estimate['status'];
  customerName: string;
  customerAddress?: string;
  businessName: string;
  businessPhone?: string;
  businessEmail?: string;
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
  }>;
  totalCents: number;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  validUntil?: string;
  customerMessage?: string;
  /** True if accept/decline actions are still allowed. */
  isActionable: boolean;
  /** Set when accepted via the public link. */
  acceptedAt?: string;
  acceptedByName?: string;
  /** Set when declined via the public link. */
  rejectedAt?: string;
  rejectedReason?: string;
  /** Set when token is past expiry. */
  isExpired: boolean;
  /**
   * Tier 4 (Deposit rules — PR 3a). Deposit context surfaced from
   * the linked job. Customers see the required amount on the
   * approval page before they accept; PR 3b will mint the Stripe
   * payment link and PR 3c will credit the eventual invoice.
   *
   * `depositRequiredCents` is 0 when the tenant has no rule
   * configured, the estimate total is below the threshold, or no
   * estimate has been approved yet (the rule writes onto the job at
   * approval time).
   */
  depositRequiredCents: number;
  depositPaidCents: number;
  depositStatus: 'not_required' | 'pending' | 'paid';
}

export interface ApproveEstimateInput {
  token: string;
  acceptedByName: string;
  signatureData?: string;
  ip?: string;
  userAgent?: string;
}

export interface DeclineEstimateInput {
  token: string;
  reason?: string;
  ip?: string;
  userAgent?: string;
}

export interface PublicEstimateServiceDeps {
  estimateRepo: EstimateRepository;
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  settingsRepo: SettingsRepository;
}

const TERMINAL_STATUSES = new Set(['accepted', 'rejected', 'expired']);

export class PublicEstimateService {
  constructor(private readonly deps: PublicEstimateServiceDeps) {}

  async getByToken(token: string): Promise<PublicEstimateView> {
    const estimate = await this.lookupByToken(token);
    return this.toView(estimate);
  }

  async recordView(
    token: string,
    _meta: { ip?: string; userAgent?: string }
  ): Promise<{ recorded: boolean }> {
    const estimate = await this.lookupByToken(token);
    const now = new Date();
    await this.deps.estimateRepo.update(estimate.tenantId, estimate.id, {
      firstViewedAt: estimate.firstViewedAt ?? now,
      viewCount: (estimate.viewCount ?? 0) + 1,
      updatedAt: now,
    });
    return { recorded: true };
  }

  async approve(input: ApproveEstimateInput): Promise<PublicEstimateView> {
    const estimate = await this.lookupByToken(input.token);
    if (this.isExpired(estimate)) {
      throw new ConflictError('Estimate link has expired');
    }
    if (estimate.status === 'accepted') {
      // Idempotent: return current view rather than throwing on double-click.
      return this.toView(estimate);
    }
    if (TERMINAL_STATUSES.has(estimate.status)) {
      throw new ConflictError(
        `Estimate cannot be accepted from status: ${estimate.status}`
      );
    }
    const trimmed = input.acceptedByName.trim();
    if (trimmed.length < 2) {
      throw new ValidationError('acceptedByName must be at least 2 characters');
    }

    const now = new Date();
    const updated = await this.deps.estimateRepo.update(
      estimate.tenantId,
      estimate.id,
      {
        status: 'accepted',
        acceptedAt: now,
        acceptedByName: trimmed,
        acceptedByIp: input.ip,
        acceptedUserAgent: input.userAgent,
        acceptedSignatureData: input.signatureData,
        updatedAt: now,
      }
    );
    if (!updated) {
      throw new NotFoundError('Estimate', estimate.id);
    }

    // Tier 4 (Deposit rules — PR 2). Evaluate the tenant's deposit
    // rule against the estimate total and write the required deposit
    // onto the linked job. Best-effort: a settings/job lookup hiccup
    // must not block customer-side approval — they've already
    // committed in the UI. PR 3 will surface the deposit on the
    // payment flow; if this hook fails, the deposit defaults to 0
    // (no charge) which is the safe-for-customer outcome.
    try {
      const settings = await this.deps.settingsRepo.findByTenant(estimate.tenantId);
      if (settings) {
        const required = evaluateDepositRule(settings, updated.totals.totalCents);
        if (required > 0) {
          const status = deriveDepositStatus(required, 0);
          await this.deps.jobRepo.update(estimate.tenantId, estimate.jobId, {
            depositRequiredCents: required,
            depositPaidCents: 0,
            depositStatus: status,
            updatedAt: now,
          });
        }
      }
    } catch {
      // Approval already succeeded; deposit population is best-effort.
    }

    return this.toView(updated);
  }

  async decline(input: DeclineEstimateInput): Promise<PublicEstimateView> {
    const estimate = await this.lookupByToken(input.token);
    if (this.isExpired(estimate)) {
      throw new ConflictError('Estimate link has expired');
    }
    if (estimate.status === 'rejected') {
      return this.toView(estimate);
    }
    if (TERMINAL_STATUSES.has(estimate.status)) {
      throw new ConflictError(
        `Estimate cannot be declined from status: ${estimate.status}`
      );
    }

    const reason = input.reason?.trim();
    const now = new Date();
    const updated = await this.deps.estimateRepo.update(
      estimate.tenantId,
      estimate.id,
      {
        status: 'rejected',
        rejectedAt: now,
        rejectedReason: reason && reason.length > 0 ? reason : undefined,
        updatedAt: now,
      }
    );
    if (!updated) {
      throw new NotFoundError('Estimate', estimate.id);
    }
    return this.toView(updated);
  }

  private async lookupByToken(token: string): Promise<Estimate> {
    if (!token || token.length < 16) {
      throw new ValidationError('Invalid token');
    }
    if (!this.deps.estimateRepo.findByViewToken) {
      throw new ValidationError('Token lookup not supported by this repository');
    }
    const found = await this.deps.estimateRepo.findByViewToken(token);
    if (!found) {
      throw new NotFoundError('Estimate', 'token');
    }
    return found;
  }

  private isExpired(estimate: Estimate): boolean {
    if (!estimate.viewTokenExpiresAt) return false;
    return estimate.viewTokenExpiresAt.getTime() < Date.now();
  }

  private async toView(estimate: Estimate): Promise<PublicEstimateView> {
    const job = await this.deps.jobRepo.findById(estimate.tenantId, estimate.jobId);
    const customer = job
      ? await this.deps.customerRepo.findById(estimate.tenantId, job.customerId)
      : null;
    const settings = await this.deps.settingsRepo.findByTenant(estimate.tenantId);
    const isExpired = this.isExpired(estimate);

    return {
      id: estimate.id,
      estimateNumber: estimate.estimateNumber,
      status: estimate.status,
      customerName: customer?.displayName ?? 'Customer',
      businessName: settings?.businessName ?? 'Service team',
      // Settings types now allow null on optional string columns
      // (Codex P2 PR #316). mapRow normalizes NULL→undefined for Pg
      // reads; this `?? undefined` covers any other code path
      // that surfaces a null value.
      businessPhone: settings?.businessPhone ?? undefined,
      businessEmail: settings?.businessEmail ?? undefined,
      lineItems: estimate.lineItems.map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unitPriceCents: li.unitPriceCents,
        totalCents: li.totalCents,
      })),
      totalCents: estimate.totals.totalCents,
      subtotalCents: estimate.totals.subtotalCents,
      taxCents: estimate.totals.taxCents,
      discountCents: estimate.totals.discountCents,
      validUntil: estimate.validUntil?.toISOString(),
      customerMessage: estimate.customerMessage,
      isActionable: !isExpired && !TERMINAL_STATUSES.has(estimate.status),
      acceptedAt: estimate.acceptedAt?.toISOString(),
      acceptedByName: estimate.acceptedByName,
      rejectedAt: estimate.rejectedAt?.toISOString(),
      rejectedReason: estimate.rejectedReason,
      isExpired,
      // Tier 4 (Deposit rules — PR 3a). Surface the deposit context
      // from the linked job. Defaults cover legacy jobs created
      // before migration 078 (the columns DEFAULT to 0 / 'not_required'
      // there too).
      depositRequiredCents: job?.depositRequiredCents ?? 0,
      depositPaidCents: job?.depositPaidCents ?? 0,
      depositStatus: job?.depositStatus ?? 'not_required',
    };
  }
}
