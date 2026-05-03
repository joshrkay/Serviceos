/**
 * P10-001 — Public, token-gated customer portal routes.
 *
 * Mounted at `/api/public/portal`. Every route runs through
 * `portalTokenMiddleware` which resolves the `:token` param into
 * `req.portal = { tenantId, customerId, sessionId }`. Downstream
 * queries scope to `req.portal.tenantId` (NEVER the request body).
 *
 * Read endpoints:
 *   GET    /:token/customer
 *   GET    /:token/estimates
 *   GET    /:token/invoices
 *   GET    /:token/jobs
 *   GET    /:token/agreements
 *   GET    /:token/appointments?upcoming=true
 *
 * Write endpoint:
 *   POST   /:token/request-service  (creates a lead)
 */
import { NextFunction, Response, Router } from 'express';
import { z } from 'zod';
import { toErrorResponse } from '../shared/errors';
import { CustomerRepository } from '../customers/customer';
import { EstimateRepository } from '../estimates/estimate';
import { InvoiceRepository, Invoice } from '../invoices/invoice';
import { JobRepository } from '../jobs/job';
import { AgreementRepository } from '../agreements/agreement';
import { AppointmentRepository } from '../appointments/appointment';
import { LeadRepository } from '../leads/lead';
import { AuditRepository } from '../audit/audit';
import { createLead } from '../leads/lead-service';
import {
  PaymentLinkProvider,
  PaymentLinkResult,
} from '../payments/payment-link-provider';
import { PortalSessionRepository } from '../portal/portal-session';
import {
  PortalRequest,
  createPortalTokenMiddleware,
  PortalTokenMiddlewareOptions,
} from '../portal/portal-token-middleware';

export interface PublicPortalDeps {
  portalRepo: PortalSessionRepository;
  customerRepo: CustomerRepository;
  estimateRepo: EstimateRepository;
  invoiceRepo: InvoiceRepository;
  jobRepo: JobRepository;
  agreementRepo: AgreementRepository;
  appointmentRepo: AppointmentRepository;
  leadRepo: LeadRepository;
  auditRepo?: AuditRepository;
  /** Optional — when present, /invoices entries get a `payNowUrl`. */
  paymentLinkProvider?: PaymentLinkProvider;
  /** Default currency for payment-link generation. Defaults to 'usd'. */
  paymentCurrency?: string;
  /** Test override for the token middleware (rate limit / clock). */
  middlewareOptions?: PortalTokenMiddlewareOptions;
}

const requestServiceSchema = z.object({
  // Allow first OR company name. Mirrors createLeadSchema's invariant.
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  companyName: z.string().trim().min(1).max(200).optional(),
  primaryPhone: z.string().trim().min(1).max(40).optional(),
  email: z.string().trim().email().max(254).optional(),
  notes: z.string().trim().max(5000).optional(),
  /**
   * Reason / summary surfaced into the lead's `notes` field. Kept as a
   * separate input so the form UX can split "what do you need" from
   * "anything else?". Both end up concatenated into `notes`.
   */
  summary: z.string().trim().min(1).max(2000),
});

function ensurePortal(req: PortalRequest, res: Response): boolean {
  if (!req.portal) {
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Portal context missing — middleware misconfigured',
    });
    return false;
  }
  return true;
}

export function createPublicPortalRouter(deps: PublicPortalDeps): Router {
  const router = Router({ mergeParams: true });
  const tokenMw = createPortalTokenMiddleware(
    deps.portalRepo,
    deps.middlewareOptions,
  );

  // Apply the token resolver to every nested route.
  router.use('/:token', tokenMw, (req, _res, next: NextFunction) => next());

  router.get('/:token/customer', async (req: PortalRequest, res: Response) => {
    if (!ensurePortal(req, res)) return;
    try {
      const { tenantId, customerId } = req.portal!;
      const customer = await deps.customerRepo.findById(tenantId, customerId);
      if (!customer || customer.isArchived) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
        return;
      }
      // Strip internal-only fields. The portal user only needs identity.
      res.json({
        id: customer.id,
        displayName: customer.displayName,
        firstName: customer.firstName,
        lastName: customer.lastName,
        companyName: customer.companyName,
        primaryPhone: customer.primaryPhone,
        secondaryPhone: customer.secondaryPhone,
        email: customer.email,
        preferredChannel: customer.preferredChannel,
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.get('/:token/estimates', async (req: PortalRequest, res: Response) => {
    if (!ensurePortal(req, res)) return;
    try {
      const { tenantId, customerId } = req.portal!;
      const jobs = await deps.jobRepo.findByTenant(tenantId, { customerId });
      const allEstimates = (
        await Promise.all(
          jobs.map((j) => deps.estimateRepo.findByJob(tenantId, j.id)),
        )
      ).flat();
      // Sort newest first; trim to safe public-facing shape.
      allEstimates.sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      res.json({
        estimates: allEstimates.map((e) => ({
          id: e.id,
          estimateNumber: e.estimateNumber,
          status: e.status,
          totalCents: e.totals.totalCents,
          createdAt: e.createdAt.toISOString(),
          validUntil: e.validUntil ? e.validUntil.toISOString() : null,
          // The customer can use the existing public approval link to
          // view a full estimate. Only surface the token if the owner
          // already shared the estimate; otherwise omit.
          publicViewToken: e.viewToken ?? null,
        })),
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.get('/:token/invoices', async (req: PortalRequest, res: Response) => {
    if (!ensurePortal(req, res)) return;
    try {
      const { tenantId, customerId } = req.portal!;
      const jobs = await deps.jobRepo.findByTenant(tenantId, { customerId });
      const allInvoices = (
        await Promise.all(
          jobs.map((j) => deps.invoiceRepo.findByJob(tenantId, j.id)),
        )
      ).flat();
      allInvoices.sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );

      const provider = deps.paymentLinkProvider;
      const currency = deps.paymentCurrency ?? 'usd';

      const enriched = await Promise.all(
        allInvoices.map(async (inv) => buildInvoicePayload(inv, tenantId, provider, currency)),
      );
      res.json({ invoices: enriched });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.get('/:token/jobs', async (req: PortalRequest, res: Response) => {
    if (!ensurePortal(req, res)) return;
    try {
      const { tenantId, customerId } = req.portal!;
      const jobs = await deps.jobRepo.findByTenant(tenantId, { customerId });
      jobs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      res.json({
        jobs: jobs.map((j) => ({
          id: j.id,
          jobNumber: j.jobNumber,
          summary: j.summary,
          status: j.status,
          priority: j.priority,
          createdAt: j.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.get('/:token/agreements', async (req: PortalRequest, res: Response) => {
    if (!ensurePortal(req, res)) return;
    try {
      const { tenantId, customerId } = req.portal!;
      const agreements = await deps.agreementRepo.findByTenant(tenantId, { customerId });
      res.json({
        agreements: agreements.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          status: a.status,
          priceCents: a.priceCents,
          recurrenceRule: a.recurrenceRule,
          nextRunAt: a.nextRunAt.toISOString(),
          startsOn: a.startsOn,
          endsOn: a.endsOn ?? null,
        })),
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.get('/:token/appointments', async (req: PortalRequest, res: Response) => {
    if (!ensurePortal(req, res)) return;
    try {
      const { tenantId, customerId } = req.portal!;
      const upcomingOnly = req.query.upcoming === 'true';

      const jobs = await deps.jobRepo.findByTenant(tenantId, { customerId });
      const allAppts = (
        await Promise.all(
          jobs.map((j) => deps.appointmentRepo.findByJob(tenantId, j.id)),
        )
      ).flat();

      const now = Date.now();
      const filtered = upcomingOnly
        ? allAppts.filter((a) => a.scheduledStart.getTime() >= now)
        : allAppts;
      filtered.sort(
        (a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime(),
      );

      res.json({
        appointments: filtered.map((a) => ({
          id: a.id,
          jobId: a.jobId,
          status: a.status,
          scheduledStart: a.scheduledStart.toISOString(),
          scheduledEnd: a.scheduledEnd.toISOString(),
          arrivalWindowStart: a.arrivalWindowStart
            ? a.arrivalWindowStart.toISOString()
            : null,
          arrivalWindowEnd: a.arrivalWindowEnd
            ? a.arrivalWindowEnd.toISOString()
            : null,
          timezone: a.timezone,
        })),
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.post('/:token/request-service', async (req: PortalRequest, res: Response) => {
    if (!ensurePortal(req, res)) return;
    try {
      const parsed = requestServiceSchema.parse(req.body ?? {});
      const { tenantId, customerId } = req.portal!;

      // Resolve customer for fallback name/contact when the portal user
      // doesn't supply them in the form. Tenant scoped — if the row
      // disappeared between token resolve and now, treat as 404.
      const customer = await deps.customerRepo.findById(tenantId, customerId);
      if (!customer) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
        return;
      }

      const noteParts = [parsed.summary];
      if (parsed.notes) noteParts.push(parsed.notes);

      // P12-005 added 'customer_portal' to LEAD_SOURCES; use it directly.
      const lead = await createLead(
        {
          tenantId,
          firstName: parsed.firstName ?? customer.firstName,
          lastName: parsed.lastName ?? customer.lastName,
          companyName: parsed.companyName ?? customer.companyName,
          primaryPhone: parsed.primaryPhone ?? customer.primaryPhone,
          email: parsed.email ?? customer.email,
          source: 'customer_portal',
          notes: noteParts.join('\n\n'),
          createdBy: `portal:customer:${customerId}`,
          actorRole: 'customer_portal',
        },
        deps.leadRepo,
        deps.auditRepo,
      );

      res.status(201).json({
        leadId: lead.id,
        message: 'Service request received. We will reach out shortly.',
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}

interface InvoicePayload {
  id: string;
  invoiceNumber: string;
  status: string;
  totalCents: number;
  amountPaidCents: number;
  amountDueCents: number;
  issuedAt: string | null;
  dueDate: string | null;
  createdAt: string;
  /** Stripe-hosted checkout URL (or fallback) when payment is owed and the provider is wired. */
  payNowUrl: string | null;
}

async function buildInvoicePayload(
  inv: Invoice,
  tenantId: string,
  provider: PaymentLinkProvider | undefined,
  currency: string,
): Promise<InvoicePayload> {
  let payNowUrl: string | null = inv.stripePaymentLinkUrl ?? null;

  // Generate a payment link only when one is missing AND the invoice is
  // actually open for payment. We never deactivate or refresh an existing
  // link from this read path — that's owner-side workflow.
  if (!payNowUrl && provider && inv.amountDueCents > 0 && isPayable(inv.status)) {
    const link = await safeGenerateLink(provider, {
      tenantId,
      invoiceId: inv.id,
      amountCents: inv.amountDueCents,
      currency,
      description: `Invoice ${inv.invoiceNumber}`,
    });
    payNowUrl = link?.linkUrl ?? null;
  }

  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    status: inv.status,
    totalCents: inv.totals.totalCents,
    amountPaidCents: inv.amountPaidCents,
    amountDueCents: inv.amountDueCents,
    issuedAt: inv.issuedAt ? inv.issuedAt.toISOString() : null,
    dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
    createdAt: inv.createdAt.toISOString(),
    payNowUrl,
  };
}

function isPayable(status: string): boolean {
  return status === 'open' || status === 'partially_paid';
}

async function safeGenerateLink(
  provider: PaymentLinkProvider,
  request: {
    tenantId: string;
    invoiceId: string;
    amountCents: number;
    currency: string;
    description: string;
  },
): Promise<PaymentLinkResult | null> {
  try {
    return await provider.generateLink(request);
  } catch {
    // Don't fail the entire invoices read because of a payment-provider
    // hiccup; surface no payNowUrl and let the caller fall back to UX.
    return null;
  }
}
