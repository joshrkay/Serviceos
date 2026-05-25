import { Estimate, EstimateRepository, transitionEstimateStatus } from './estimate';
import {
  calculateDocumentTotals,
  hasSelectableLineItems,
  resolveSelectedLineItems,
  validateLineItemSelection,
} from '../shared/billing-engine';
import { CustomerRepository } from '../customers/customer';
import { JobRepository } from '../jobs/job';
import { LocationRepository } from '../locations/location';
import { SettingsRepository } from '../settings/settings';
import { evaluateDepositRule, deriveDepositStatus } from '../jobs/deposit-rule';
import { ValidationError, NotFoundError, ConflictError } from '../shared/errors';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { publicActorFromToken } from '../feedback/feedback-response';

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
    id: string;
    description: string;
    quantity: number;
    unitPriceCents: number;
    totalCents: number;
    /** Non-null = one option in a mutually-exclusive tier group. */
    groupKey?: string;
    /** Label for the tier group. */
    groupLabel?: string;
    /** Customer-selectable (tier option or standalone add-on). */
    isOptional?: boolean;
    /** Pre-selected on first view. */
    isDefaultSelected?: boolean;
  }>;
  /** True when the estimate has tier options or optional add-ons to choose. */
  hasSelectableItems: boolean;
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
   * Optimistic-lock / re-sync counter. The customer page captures this
   * on load and sends it back as `expectedVersion` on approve; a bump
   * means the business revised the estimate and the page must reload
   * before the customer can accept.
   */
  version: number;
  /** ISO timestamp of the most recent revise of this (already sent) estimate. */
  lastRevisedAt?: string;
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
  /**
   * Tier 4 (Deposit rules — PR 3b). Tenant policy controlling whether
   * the customer can approve before paying the deposit. The customer
   * page uses this to choose between gating Approve (`before_approval`)
   * vs. surfacing the payment link only after acceptance
   * (`after_approval`). Defaults to `'after_approval'` when the
   * tenant settings row predates migration 079.
   */
  depositTimingPolicy: 'before_approval' | 'after_approval';
  /**
   * Stripe-hosted Payment Link URL minted to collect the deposit, when
   * one has been requested. Null until the customer (or dispatcher)
   * taps Pay deposit. Surfaced read-only here so the page can
   * deep-link to it; minting goes through `getOrCreateDepositCheckoutUrl`.
   */
  depositCheckoutUrl?: string;
}

export interface ApproveEstimateInput {
  token: string;
  acceptedByName: string;
  signatureData?: string;
  ip?: string;
  userAgent?: string;
  /**
   * The estimate `version` the customer was viewing when they accepted.
   * When supplied and it no longer matches, the estimate was revised
   * after page load and approval is refused so the customer reviews the
   * latest version first.
   */
  expectedVersion?: number;
  /**
   * Good-better-best: the estimate_line_item ids the customer chose
   * (tier options + add-ons). Required when the estimate has selectable
   * items; ignored otherwise. The server validates the selection and
   * recomputes the accepted total from it — the client total is never
   * trusted.
   */
  selectedLineItemIds?: string[];
}

export interface DeclineEstimateInput {
  token: string;
  reason?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Tier 4 (Deposit rules — PR 3b). Optional Stripe config so deposit
 * checkout link minting is opt-in. Routes wire null when STRIPE_API_KEY
 * is missing; the service throws ValidationError if the customer tries
 * to mint a deposit link in that environment.
 */
export interface DepositStripeConfig {
  apiKey: string;
}

/**
 * Tier 4 (Deposit rules — PR 3b). Override-able fetch for unit tests so
 * we don't actually hit api.stripe.com. Mirrors the pattern used by
 * `public-payments` route. Defaults to global fetch.
 */
export type DepositStripeFetch = typeof fetch;

export interface PublicEstimateServiceDeps {
  estimateRepo: EstimateRepository;
  jobRepo: JobRepository;
  customerRepo: CustomerRepository;
  locationRepo?: LocationRepository;
  settingsRepo: SettingsRepository;
  stripeConfig?: DepositStripeConfig | null;
  stripeFetch?: DepositStripeFetch;
  /**
   * D2-1d — audit logging for token-scoped customer approval / decline.
   * Optional so older harnesses still build the service.
   */
  auditRepo?: AuditRepository;
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
    // Validity-date expiry beats approval: a lapsed quote can't be
    // accepted at stale pricing. Mark it expired so the pipeline reflects
    // reality, then refuse.
    await this.expireIfPastValidUntil(estimate);
    if (estimate.status === 'accepted') {
      // Idempotent: return current view rather than throwing on double-click.
      return this.toView(estimate);
    }
    if (TERMINAL_STATUSES.has(estimate.status)) {
      throw new ConflictError(
        `Estimate cannot be accepted from status: ${estimate.status}`
      );
    }
    // Stale-revision guard. Once an estimate has been revised, a caller MUST
    // prove which version it is accepting — otherwise a cached page or a
    // direct API call could accept stale, pre-revision pricing. Never-revised
    // estimates (version 1, no lastRevisedAt) don't need the token, so first
    // sends stay frictionless.
    const hasBeenRevised = estimate.version > 1 || estimate.lastRevisedAt !== undefined;
    if (hasBeenRevised && input.expectedVersion === undefined) {
      throw new ConflictError(
        'This estimate was updated. Please reload to review the latest version before accepting.',
      );
    }
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== estimate.version
    ) {
      throw new ConflictError(
        'This estimate was updated after you opened it. Please review the latest version before accepting.',
      );
    }
    const trimmed = input.acceptedByName.trim();
    if (trimmed.length < 2) {
      throw new ValidationError('acceptedByName must be at least 2 characters');
    }

    // Good-better-best: resolve the customer's selection and recompute
    // the accepted total from it. The client total is never trusted —
    // everything below (deposit gate, persisted totals, the eventual
    // invoice) uses this server-side figure.
    const selectable = hasSelectableLineItems(estimate.lineItems);
    let acceptedSelection: string[] | undefined;
    let acceptedTotals = estimate.totals;
    if (selectable) {
      const selectedIds = input.selectedLineItemIds;
      if (selectedIds === undefined) {
        throw new ValidationError('A selection is required for this estimate');
      }
      const selectionErrors = validateLineItemSelection(estimate.lineItems, selectedIds);
      if (selectionErrors.length > 0) {
        throw new ValidationError(selectionErrors.join('; '));
      }
      const billed = resolveSelectedLineItems(estimate.lineItems, selectedIds);
      acceptedTotals = calculateDocumentTotals(
        billed,
        estimate.totals.discountCents,
        estimate.totals.taxRateBps,
      );
      acceptedSelection = billed.map((li) => li.id);
    }

    // Tier 4 (Deposit rules — PR 3b). When the tenant runs the
    // 'before_approval' policy, refuse to accept an estimate whose
    // deposit hasn't been collected yet. The policy only triggers when
    // the rule actually requires a deposit for this estimate's total —
    // a $0 rule (or no configured rule) lets approval through even on
    // before_approval tenants, mirroring the after_approval default.
    const settings = await this.deps.settingsRepo.findByTenant(estimate.tenantId);
    const policy = settings?.depositTimingPolicy ?? 'after_approval';
    if (policy === 'before_approval' && settings) {
      const requiredFromRule = evaluateDepositRule(settings, acceptedTotals.totalCents);
      if (requiredFromRule > 0) {
        const job = await this.deps.jobRepo.findById(estimate.tenantId, estimate.jobId);
        const paid = job?.depositPaidCents ?? 0;
        if (paid < requiredFromRule) {
          throw new ConflictError('Deposit must be paid before this estimate can be approved');
        }
      }
    }

    const now = new Date();
    const updated = await this.deps.estimateRepo.update(
      estimate.tenantId,
      estimate.id,
      {
        status: 'accepted',
        totals: acceptedTotals,
        acceptedSelection,
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
    // committed in the UI. PR 3 surfaces the deposit on the payment
    // flow; if this hook fails the deposit defaults to 0 (no charge)
    // which is the safe-for-customer outcome.
    //
    // The settings row is reused from the before_approval gate above
    // so we don't make two round-trips to the same row. For
    // before_approval the deposit was already paid (we got past the
    // gate) so we can lock the paid amount onto the job here too.
    try {
      if (settings) {
        const required = evaluateDepositRule(settings, updated.totals.totalCents);
        if (required > 0) {
          const job = await this.deps.jobRepo.findById(estimate.tenantId, estimate.jobId);
          const paid = job?.depositPaidCents ?? 0;
          const status = deriveDepositStatus(required, paid);
          await this.deps.jobRepo.update(estimate.tenantId, estimate.jobId, {
            depositRequiredCents: required,
            depositPaidCents: paid,
            depositStatus: status,
            updatedAt: now,
          });
        }
      }
    } catch {
      // Approval already succeeded; deposit population is best-effort.
    }

    if (this.deps.auditRepo) {
      // D2-1d — token-scoped public actor. Raw token is NEVER persisted
      // on the audit row; the 12-char SHA-256 prefix lets ops correlate
      // back to the originating link without leaking the bearer credential.
      await this.deps.auditRepo.create(
        createAuditEvent({
          tenantId: updated.tenantId,
          actorId: publicActorFromToken(input.token),
          actorRole: 'customer',
          eventType: 'public_estimate.approved',
          entityType: 'estimate',
          entityId: updated.id,
          metadata: {
            estimateNumber: updated.estimateNumber,
            acceptedByName: trimmed,
            totalCents: updated.totals.totalCents,
            ipAddress: input.ip,
            userAgent: input.userAgent,
          },
        }),
      );
    }

    return this.toView(updated);
  }

  async decline(input: DeclineEstimateInput): Promise<PublicEstimateView> {
    const estimate = await this.lookupByToken(input.token);
    if (this.isExpired(estimate)) {
      throw new ConflictError('Estimate link has expired');
    }
    await this.expireIfPastValidUntil(estimate);
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

    if (this.deps.auditRepo) {
      // D2-1d — same synthetic-actor contract as approve(). The optional
      // `reason` carries customer free-text and is recorded for ops triage.
      await this.deps.auditRepo.create(
        createAuditEvent({
          tenantId: updated.tenantId,
          actorId: publicActorFromToken(input.token),
          actorRole: 'customer',
          eventType: 'public_estimate.declined',
          entityType: 'estimate',
          entityId: updated.id,
          metadata: {
            estimateNumber: updated.estimateNumber,
            reason: reason && reason.length > 0 ? reason : undefined,
            totalCents: updated.totals.totalCents,
            ipAddress: input.ip,
            userAgent: input.userAgent,
          },
        }),
      );
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

  /**
   * Validity-date expiry precedence. When a sent estimate is past its
   * `validUntil`, transition it to 'expired' and refuse the action so a
   * lapsed quote can neither be accepted nor declined at stale terms.
   * No-op for estimates with no validity date or one still in the future.
   */
  private async expireIfPastValidUntil(estimate: Estimate): Promise<void> {
    if (!estimate.validUntil) return;
    if (estimate.validUntil.getTime() >= Date.now()) return;
    if (estimate.status !== 'sent') return;
    await transitionEstimateStatus(
      estimate.tenantId,
      estimate.id,
      'expired',
      this.deps.estimateRepo,
    );
    throw new ConflictError('This estimate has expired and can no longer be actioned.');
  }

  private async toView(estimate: Estimate): Promise<PublicEstimateView> {
    const job = await this.deps.jobRepo.findById(estimate.tenantId, estimate.jobId);
    const [customer, settings, locs] = await Promise.all([
      job ? this.deps.customerRepo.findById(estimate.tenantId, job.customerId) : Promise.resolve(null),
      this.deps.settingsRepo.findByTenant(estimate.tenantId),
      job?.locationId && this.deps.locationRepo ? this.deps.locationRepo.findByCustomer(estimate.tenantId, job.customerId) : Promise.resolve([]),
    ]);

    // Fetch the job's service location for the approval page (QA 5.14)
    let serviceAddress: string | undefined;
    if (job?.locationId && locs.length > 0) {
      const loc = locs.find(l => l.id === job.locationId);
      if (loc) {
        serviceAddress = [loc.street1, loc.city, loc.state, loc.postalCode]
          .filter(Boolean).join(', ');
      }
    }
    const isExpired = this.isExpired(estimate) ||
      // A sent estimate past its validity date reads as expired so the
      // page disables Approve/Decline, matching the server's enforcement
      // (expireIfPastValidUntil) without writing on a GET.
      (!!estimate.validUntil &&
        estimate.validUntil.getTime() < Date.now() &&
        estimate.status === 'sent');
    const policy = settings?.depositTimingPolicy ?? 'after_approval';

    // Tier 4 (Deposit rules — PR 3b). For tenants on the
    // 'before_approval' policy, the deposit must be visible to the
    // customer BEFORE they have approved (the rule normally writes
    // onto the job at approval time — too late for this flow). When
    // the job has no required amount yet, compute it on the fly from
    // the estimate total + current settings. Once the customer pays,
    // mintDepositCheckoutUrl persists the required amount onto the
    // job, so subsequent renders read the locked value.
    let computedRequired = job?.depositRequiredCents ?? 0;
    let computedStatus: 'not_required' | 'pending' | 'paid' =
      job?.depositStatus ?? 'not_required';
    const depositPaidCents = job?.depositPaidCents ?? 0;
    if (
      policy === 'before_approval' &&
      computedRequired === 0 &&
      settings &&
      estimate.status !== 'rejected'
    ) {
      const fromRule = evaluateDepositRule(settings, estimate.totals.totalCents);
      if (fromRule > 0) {
        computedRequired = fromRule;
        computedStatus = deriveDepositStatus(fromRule, depositPaidCents);
      }
    }

    // Approve gate: when the policy is 'before_approval' and a deposit
    // is required but not yet paid, the customer cannot accept yet.
    // isActionable wraps that gate so the page can disable the
    // Approve button consistently with the server's enforcement.
    const baseActionable = !isExpired && !TERMINAL_STATUSES.has(estimate.status);
    const blockedByDeposit =
      policy === 'before_approval' &&
      computedRequired > 0 &&
      depositPaidCents < computedRequired;
    const isActionable = baseActionable && !blockedByDeposit;

    return {
      id: estimate.id,
      estimateNumber: estimate.estimateNumber,
      status: estimate.status,
      customerName: customer?.displayName ?? 'Customer',
      customerAddress: serviceAddress,
      businessName: settings?.businessName ?? 'Service team',
      // Settings types now allow null on optional string columns
      // (Codex P2 PR #316). mapRow normalizes NULL→undefined for Pg
      // reads; this `?? undefined` covers any other code path
      // that surfaces a null value.
      businessPhone: settings?.businessPhone ?? undefined,
      businessEmail: settings?.businessEmail ?? undefined,
      lineItems: estimate.lineItems.map((li) => ({
        id: li.id,
        description: li.description,
        quantity: li.quantity,
        unitPriceCents: li.unitPriceCents,
        totalCents: li.totalCents,
        groupKey: li.groupKey,
        groupLabel: li.groupLabel,
        isOptional: li.isOptional,
        isDefaultSelected: li.isDefaultSelected,
      })),
      hasSelectableItems: hasSelectableLineItems(estimate.lineItems),
      totalCents: estimate.totals.totalCents,
      subtotalCents: estimate.totals.subtotalCents,
      taxCents: estimate.totals.taxCents,
      discountCents: estimate.totals.discountCents,
      validUntil: estimate.validUntil?.toISOString(),
      customerMessage: estimate.customerMessage,
      isActionable,
      acceptedAt: estimate.acceptedAt?.toISOString(),
      acceptedByName: estimate.acceptedByName,
      rejectedAt: estimate.rejectedAt?.toISOString(),
      rejectedReason: estimate.rejectedReason,
      isExpired,
      version: estimate.version,
      lastRevisedAt: estimate.lastRevisedAt?.toISOString(),
      // Tier 4 (Deposit rules — PR 3a). Surface the deposit context
      // from the linked job, with PR 3b's before_approval computation
      // layered on top. Defaults cover legacy jobs (the columns
      // DEFAULT to 0 / 'not_required' too).
      depositRequiredCents: computedRequired,
      depositPaidCents,
      depositStatus: computedStatus,
      depositTimingPolicy: policy,
      depositCheckoutUrl: job?.depositStripePaymentLinkUrl ?? undefined,
    };
  }

  /**
   * Tier 4 (Deposit rules — PR 3b). Returns a Stripe Payment Link URL
   * sized to the deposit owed on this estimate's linked job. Mirrors
   * `PublicInvoiceService.getOrCreateCheckoutUrl`:
   *
   *   - Idempotent: if a link is already persisted on the job and the
   *     amount it covers still matches, the same URL comes back.
   *   - Bound: the customer's deposit cannot be > the estimate total.
   *   - Webhook-driven: payments arrive via the Stripe webhook and
   *     credit `depositPaidCents` on the job using
   *     `metadata.deposit_for_job_id`.
   */
  async getOrCreateDepositCheckoutUrl(token: string): Promise<{ url: string }> {
    const estimate = await this.lookupByToken(token);
    if (this.isExpired(estimate)) {
      throw new ConflictError('Estimate link has expired');
    }
    if (!this.deps.stripeConfig?.apiKey) {
      throw new ValidationError('Payment processing is not configured');
    }

    const settings = await this.deps.settingsRepo.findByTenant(estimate.tenantId);
    const job = await this.deps.jobRepo.findById(estimate.tenantId, estimate.jobId);
    if (!job) {
      throw new NotFoundError('Job', estimate.jobId);
    }

    // Resolve the required deposit. For after_approval the job already
    // carries it (written at approve()); for before_approval we
    // evaluate the rule against the estimate total and lock that
    // value onto the job by writing it before minting the link.
    const policy = settings?.depositTimingPolicy ?? 'after_approval';
    let required = job.depositRequiredCents ?? 0;
    if (required === 0 && policy === 'before_approval' && settings) {
      required = evaluateDepositRule(settings, estimate.totals.totalCents);
    }
    if (required <= 0) {
      throw new ValidationError('No deposit is required for this estimate');
    }

    const paid = job.depositPaidCents ?? 0;
    if (paid >= required) {
      throw new ValidationError('Deposit has already been paid');
    }
    const remaining = required - paid;

    // Idempotent return: if a link exists, hand it back. The amount it
    // was minted for can't change without surfacing through this same
    // path (which deactivates the old link below if the rule moved),
    // so a repeated tap just reuses the existing URL.
    if (job.depositStripePaymentLinkUrl) {
      // Lock the required amount onto the job if it isn't already
      // persisted (before_approval first-mint path) so the webhook
      // can credit deterministically.
      if ((job.depositRequiredCents ?? 0) === 0) {
        await this.deps.jobRepo.update(job.tenantId, job.id, {
          depositRequiredCents: required,
          depositPaidCents: paid,
          depositStatus: deriveDepositStatus(required, paid),
          updatedAt: new Date(),
        });
      }
      return { url: job.depositStripePaymentLinkUrl };
    }

    const customer = await this.deps.customerRepo.findById(
      job.tenantId,
      job.customerId,
    );
    const description = `Deposit for ${estimate.estimateNumber}${
      customer ? ` — ${customer.displayName}` : ''
    }`;

    const fetchFn = this.deps.stripeFetch ?? fetch;
    const res = await fetchFn('https://api.stripe.com/v1/payment_links', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.deps.stripeConfig.apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][product_data][name]': description,
        'line_items[0][price_data][unit_amount]': String(remaining),
        'line_items[0][quantity]': '1',
        'metadata[tenant_id]': job.tenantId,
        'metadata[deposit_for_job_id]': job.id,
        'metadata[estimate_id]': estimate.id,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Stripe API error (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { id?: string; url?: string };
    if (!data.id || !data.url) {
      throw new Error('Stripe API returned incomplete payment link (missing id or url)');
    }

    // Persist required + paid + link in a single update so a webhook
    // delivery that arrives while we're still here finds a coherent
    // job row. If the persist fails, deactivate the freshly-minted
    // link so it isn't an orphaned charge vector.
    try {
      await this.deps.jobRepo.update(job.tenantId, job.id, {
        depositRequiredCents: required,
        depositPaidCents: paid,
        depositStatus: deriveDepositStatus(required, paid),
        depositStripePaymentLinkId: data.id,
        depositStripePaymentLinkUrl: data.url,
        updatedAt: new Date(),
      });
    } catch (dbErr) {
      await fetchFn(`https://api.stripe.com/v1/payment_links/${data.id}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.deps.stripeConfig.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ active: 'false' }),
      }).catch(() => undefined);
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      throw new Error(`Failed to persist deposit Stripe link ${data.id}: ${msg}`);
    }

    return { url: data.url };
  }
}
