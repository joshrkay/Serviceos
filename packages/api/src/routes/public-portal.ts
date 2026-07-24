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
import { JobRepository, createJob } from '../jobs/job';
import { deriveDepositStatus, isDepositPayable } from '../jobs/deposit-rule';
import { AgreementRepository } from '../agreements/agreement';
import { Appointment, AppointmentRepository, createAppointment } from '../appointments/appointment';
import { AssignmentRepository } from '../appointments/assignment';
import { LocationRepository } from '../locations/location';
import { LeadRepository } from '../leads/lead';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { SettingsRepository } from '../settings/settings';
import { ProposalRepository, createProposal } from '../proposals/proposal';
import { createLead } from '../leads/lead-service';
import {
  findBookableSlots,
  isWithinBusinessHours,
  WeeklyBusinessHours,
  schedulingConfigFromSettings,
  isSlotFree,
  clampBookingHorizon,
  STANDARD_BOOKING_HORIZON_DAYS,
  PRIORITY_BOOKING_HORIZON_DAYS,
} from '../scheduling/booking-availability';
import { customerHasPriorityBooking } from '../agreements/member-pricing';
import { CustomerPaymentMethodRepository } from '../payments/customer-payment-method';
import { createSetupIntent } from '../payments/stripe-saved-card';
import { StripeFetch } from '../payments/stripe-payment-intent';
import { ConnectAccountResolver } from '../invoices/public-invoice-service';
import { notifyDispatchBoardChanged } from '../dispatch/board-notify';
import {
  TenantTransactionRunner,
  InMemoryTransactionRunner,
} from '../db/tenant-transaction';
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
  /** Required for the self-service booking routes (availability + book). */
  assignmentRepo?: AssignmentRepository;
  locationRepo?: LocationRepository;
  proposalRepo?: ProposalRepository;
  settingsRepo?: SettingsRepository;
  /** Wraps the self-service booking writes in one atomic, slot-locked txn. */
  transactionRunner?: TenantTransactionRunner;
  /** Optional — when present, /invoices entries get a `payNowUrl`. */
  paymentLinkProvider?: PaymentLinkProvider;
  /** Default currency for payment-link generation. Defaults to 'usd'. */
  paymentCurrency?: string;
  /** #6 phase 4 — saved cards. When wired, the customer can put a card on
   * file (SetupIntent) for membership auto-billing. */
  customerPaymentMethodRepo?: CustomerPaymentMethodRepository;
  stripeConfig?: { apiKey: string };
  connectAccountResolver?: ConnectAccountResolver;
  /** Test override for the Stripe fetch impl. */
  stripeFetch?: StripeFetch;
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const availabilityQuerySchema = z.object({
  from: z.string().regex(DATE_RE, 'from must be YYYY-MM-DD'),
  to: z.string().regex(DATE_RE, 'to must be YYYY-MM-DD'),
  durationMin: z.coerce.number().int().min(15).max(480).default(60),
});

const bookSchema = z.object({
  slotStart: z.string().datetime(),
  slotEnd: z.string().datetime(),
  summary: z.string().trim().min(1).max(2000),
  locationId: z.string().uuid().optional(),
});

/** A self-service hold survives 24h before the finder treats the slot as free. */
const BOOKING_HOLD_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BOOKING_TIMEZONE = 'America/New_York';
/** Customers can't self-cancel/reschedule inside this window before start. */
const SELF_CHANGE_CUTOFF_MS = 2 * 60 * 60 * 1000;

const cancelSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

const rescheduleSchema = z.object({
  slotStart: z.string().datetime(),
  slotEnd: z.string().datetime(),
});

interface ResolvedScheduling {
  timezone: string;
  weeklyHours: WeeklyBusinessHours | null;
  bufferMinutes: number | null;
}

/**
 * Load the tenant's scheduling configuration once per request: timezone,
 * per-day business hours, and travel buffer. All three propagate into slot
 * generation AND slot validation so a POST can only book what GET offers.
 */
async function resolveTenantScheduling(
  deps: PublicPortalDeps,
  tenantId: string,
): Promise<ResolvedScheduling> {
  if (!deps.settingsRepo) {
    return { timezone: DEFAULT_BOOKING_TIMEZONE, weeklyHours: null, bufferMinutes: null };
  }
  const settings = await deps.settingsRepo.findByTenant(tenantId);
  const config = schedulingConfigFromSettings(settings);
  return {
    timezone: config.timezone || DEFAULT_BOOKING_TIMEZONE,
    weeklyHours: config.weeklyHours,
    bufferMinutes: config.bufferMinutes,
  };
}

/**
 * Write a 409 SLOT_TAKEN response with the next open slots in a 7-day window.
 * Shared by the book and reschedule routes — both fail the same way when the
 * requested slot was claimed between availability fetch and submission.
 */
async function respondSlotTaken(
  deps: PublicPortalDeps,
  res: Response,
  args: {
    tenantId: string;
    slotStart: Date;
    slotEnd: Date;
    scheduling: ResolvedScheduling;
    message: string;
  },
): Promise<void> {
  const durationMin = Math.round((args.slotEnd.getTime() - args.slotStart.getTime()) / 60000);
  const alternatives = await findBookableSlots(
    { appointmentRepo: deps.appointmentRepo, assignmentRepo: deps.assignmentRepo },
    {
      tenantId: args.tenantId,
      fromDate: args.slotStart.toISOString().slice(0, 10),
      toDate: new Date(args.slotStart.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      timezone: args.scheduling.timezone,
      durationMin,
      weeklyHours: args.scheduling.weeklyHours,
      bufferMinutes: args.scheduling.bufferMinutes,
    },
  );
  res.status(409).json({
    error: 'SLOT_TAKEN',
    message: args.message,
    alternatives: alternatives.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
  });
}

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

  // Active-customer guard: a valid token alone isn't enough — the customer
  // it points at must still be reachable. Archiving the customer (or
  // deleting them outright) is the canonical access cutoff for the portal,
  // so we re-check on EVERY token-gated request, not just `/customer`.
  // Otherwise a previously-issued token could keep pulling
  // estimates/invoices/jobs/etc. after archive.
  const ensureActiveCustomer = async (
    req: PortalRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (!req.portal) {
      res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Portal context missing — middleware misconfigured',
      });
      return;
    }
    try {
      const customer = await deps.customerRepo.findById(
        req.portal.tenantId,
        req.portal.customerId,
      );
      if (!customer || customer.isArchived) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
        return;
      }
      next();
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  };

  // Apply the token resolver + active-customer guard to every nested route.
  router.use('/:token', tokenMw, ensureActiveCustomer);

  router.get('/:token/customer', async (req: PortalRequest, res: Response) => {
    if (!ensurePortal(req, res)) return;
    try {
      const { tenantId, customerId } = req.portal!;
      const customer = await deps.customerRepo.findById(tenantId, customerId);
      if (!customer) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
        return;
      }
      // WS6 (QUALITY-2026-07-12) — the portal is a customer-facing surface with
      // no Clerk /api/me, so it can't reach the tenant timezone the way the
      // authed SPA does. Include it in the bootstrap response (resolved from
      // tenant settings, tenant-scoped) so every portal date renders in the
      // business's timezone per the "render in tenant timezone" core pattern.
      const { timezone } = await resolveTenantScheduling(deps, tenantId);
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
        timezone,
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
      // Keep each estimate's parent job in reach so we can surface the
      // job-level deposit state on the accepted estimate's card without a
      // second query (deposit is a property of the job — deposit-rule.ts).
      const jobsById = new Map(jobs.map((j) => [j.id, j]));
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
        estimates: allEstimates.map((e) => {
          const job = jobsById.get(e.jobId);
          const depositRequiredCents = job?.depositRequiredCents ?? 0;
          const depositPaidCents = job?.depositPaidCents ?? 0;
          const depositStatus = deriveDepositStatus(
            depositRequiredCents,
            depositPaidCents,
          );
          return {
            id: e.id,
            estimateNumber: e.estimateNumber,
            status: e.status,
            totalCents: e.totals.totalCents,
            createdAt: e.createdAt.toISOString(),
            validUntil: e.validUntil ? e.validUntil.toISOString() : null,
            depositRequiredCents,
            depositPaidCents,
            depositStatus,
            // The job's deposit belongs to the ACCEPTED estimate (after_approval);
            // never surface a payable deposit on a sibling estimate of the same
            // job. The customer pays on /e/:token, which this card links to.
            depositPayable:
              e.status === 'accepted' &&
              isDepositPayable(depositStatus, e.status, false),
            // The customer can use the existing public approval link to
            // view a full estimate. Only surface the token if the owner
            // already shared the estimate; otherwise omit.
            publicViewToken: e.viewToken ?? null,
          };
        }),
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
        allInvoices.map(async (inv) =>
          buildInvoicePayload(inv, tenantId, provider, currency, deps.invoiceRepo),
        ),
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

      // P12-005: 'customer_portal' is now a first-class LEAD_SOURCES value
      // so we drop the prior workaround (`source='web_form' +
      // sourceDetail='Customer Portal'`) in favor of the dedicated enum.
      // The DB CHECK constraint accepts it via migration 068.
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

  /**
   * GET /:token/availability?from=YYYY-MM-DD&to=YYYY-MM-DD&durationMin=60
   *
   * Returns open booking slots within the tenant's business hours, in the
   * tenant timezone. Read-only — never reserves anything.
   */
  router.get('/:token/availability', async (req: PortalRequest, res: Response) => {
    if (!ensurePortal(req, res)) return;
    try {
      const { tenantId, customerId } = req.portal!;
      const parsed = availabilityQuerySchema.parse(req.query);
      const scheduling = await resolveTenantScheduling(deps, tenantId);
      const timezone = scheduling.timezone;

      // Priority-booking members (#6) can book further out; everyone else is
      // capped at the standard horizon. Clamp the requested window so the
      // finder never offers a slot past the customer's horizon.
      const priorityBooking = await customerHasPriorityBooking(
        tenantId,
        customerId,
        deps.agreementRepo,
      );
      const horizonDays = priorityBooking
        ? PRIORITY_BOOKING_HORIZON_DAYS
        : STANDARD_BOOKING_HORIZON_DAYS;
      const window = clampBookingHorizon(parsed.from, parsed.to, horizonDays, new Date(), timezone);

      const slots = window
        ? await findBookableSlots(
            { appointmentRepo: deps.appointmentRepo, assignmentRepo: deps.assignmentRepo },
            {
              tenantId,
              fromDate: window.from,
              toDate: window.to,
              timezone,
              durationMin: parsed.durationMin,
              weeklyHours: scheduling.weeklyHours,
              bufferMinutes: scheduling.bufferMinutes,
            },
          )
        : [];

      res.json({
        timezone,
        durationMin: parsed.durationMin,
        priorityBooking,
        horizonDays,
        slots: slots.map((s) => ({
          start: s.start.toISOString(),
          end: s.end.toISOString(),
        })),
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  /**
   * POST /:token/book
   *
   * Customer self-service booking. Re-verifies the slot is still open, then
   * creates a job + a tentative held appointment and a `create_booking`
   * proposal for the dispatcher to confirm. Never auto-confirms — the
   * appointment stays held (24h) until a human approves the proposal.
   */
  router.post('/:token/book', async (req: PortalRequest, res: Response) => {
    if (!ensurePortal(req, res)) return;
    try {
      const { tenantId, customerId } = req.portal!;

      if (!deps.proposalRepo) {
        res
          .status(503)
          .json({ error: 'UNAVAILABLE', message: 'Self-service booking is not configured' });
        return;
      }

      const parsed = bookSchema.parse(req.body ?? {});
      const slotStart = new Date(parsed.slotStart);
      const slotEnd = new Date(parsed.slotEnd);
      if (slotEnd.getTime() <= slotStart.getTime()) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'slotEnd must be after slotStart' });
        return;
      }
      if (slotStart.getTime() < Date.now()) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Cannot book a slot in the past' });
        return;
      }

      // Defense in depth: the availability GET already clamps the horizon, but
      // a client can POST any slot — re-check it against the customer's horizon
      // (priority members get the extended one) so it can't be bypassed.
      const scheduling = await resolveTenantScheduling(deps, tenantId);
      const timezone = scheduling.timezone;
      // Same defense for business hours: only what GET would offer is bookable.
      if (!isWithinBusinessHours(slotStart, slotEnd, timezone, scheduling.weeklyHours)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Selected time is outside booking hours',
        });
        return;
      }
      const priorityBooking = await customerHasPriorityBooking(tenantId, customerId, deps.agreementRepo);
      const horizonDays = priorityBooking
        ? PRIORITY_BOOKING_HORIZON_DAYS
        : STANDARD_BOOKING_HORIZON_DAYS;
      const slotDate = slotStart.toISOString().slice(0, 10);
      if (!clampBookingHorizon(slotDate, slotDate, horizonDays, new Date(), timezone)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Selected time is beyond your bookable window',
        });
        return;
      }

      const customer = await deps.customerRepo.findById(tenantId, customerId);
      if (!customer) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
        return;
      }

      // Resolve the service location: an explicit (customer-owned) one, else
      // the customer's primary, else their only location.
      const locationId = await resolveBookingLocation(deps, tenantId, customerId, parsed.locationId);
      if (!locationId) {
        res
          .status(422)
          .json({ error: 'NO_LOCATION', message: 'No service location on file. Please contact us to book.' });
        return;
      }

      const finderDeps = {
        appointmentRepo: deps.appointmentRepo,
        assignmentRepo: deps.assignmentRepo,
      };
      const createdBy = `portal:customer:${customerId}`;
      const runner = deps.transactionRunner ?? new InMemoryTransactionRunner();

      // Atomic reservation: one transaction wraps the slot re-check and all
      // writes (job + held appointment + proposal + audit), so a mid-sequence
      // failure can't orphan a Job. A transaction-scoped advisory lock
      // serializes the tenant's concurrent bookings: a per-slotStart key is
      // unsafe because overlapping windows with different starts (10:00-11:00
      // vs 10:30-11:30) would take different locks and both pass isSlotFree.
      // Locking per-tenant guarantees the second booking observes the first's
      // committed hold via isSlotFree; booking concurrency per tenant is low,
      // so the brief serialization is acceptable.
      const outcome = await runner.run(tenantId, async ({ lock }) => {
        // Shared key with the public booking flow (public-booking.ts) so the
        // two self-service surfaces serialize against each other for the same
        // tenant calendar and can't both pass isSlotFree for overlapping slots.
        await lock('self-service-booking');

        const stillFree = await isSlotFree(finderDeps, {
          tenantId,
          start: slotStart,
          end: slotEnd,
        });
        if (!stillFree) {
          return { ok: false as const };
        }

        const job = await createJob(
          {
            tenantId,
            customerId,
            locationId,
            summary: parsed.summary,
            createdBy,
            actorRole: 'customer_portal',
          },
          deps.jobRepo,
          deps.auditRepo,
        );

        const held = await createAppointment(
          {
            tenantId,
            jobId: job.id,
            scheduledStart: slotStart,
            scheduledEnd: slotEnd,
            timezone,
            notes: parsed.summary,
            createdBy,
            holdPendingApproval: true,
            holdExpiryAt: new Date(Date.now() + BOOKING_HOLD_WINDOW_MS),
          },
          deps.appointmentRepo,
        );

        // No sourceTrustTier — a customer-initiated booking is never
        // auto-approved. It lands as a draft proposal for the dispatcher.
        const proposal = createProposal({
          tenantId,
          proposalType: 'create_booking',
          payload: { appointmentId: held.id },
          summary: `Customer requested booking: ${parsed.summary}`,
          explanation: 'Submitted via the customer portal. Confirm to finalize the appointment.',
          sourceContext: { source: 'customer_portal', customerId, jobId: job.id },
          createdBy,
          expiresAt: held.holdExpiryAt,
        });
        const persisted = await deps.proposalRepo!.create(proposal);

        if (deps.auditRepo) {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: createdBy,
              actorRole: 'customer_portal',
              eventType: 'appointment.booking_requested',
              entityType: 'appointment',
              entityId: held.id,
              metadata: { proposalId: persisted.id, jobId: job.id },
            }),
          );
        }

        return { ok: true as const, held, proposalId: persisted.id };
      });

      if (!outcome.ok) {
        await respondSlotTaken(deps, res, {
          tenantId,
          slotStart,
          slotEnd,
          scheduling,
          message: 'That time was just booked. Here are the next available slots.',
        });
        return;
      }

      // Post-commit side effect: the tentative hold should appear on any open
      // dispatch board for that day immediately, flagged pending approval.
      notifyDispatchBoardChanged(tenantId, outcome.held.scheduledStart, outcome.held.timezone);

      res.status(201).json({
        status: 'pending_confirmation',
        proposalId: outcome.proposalId,
        appointmentId: outcome.held.id,
        scheduledStart: outcome.held.scheduledStart.toISOString(),
        scheduledEnd: outcome.held.scheduledEnd.toISOString(),
        timezone,
        message: "Thanks! We'll confirm your appointment shortly.",
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  /**
   * POST /:token/appointments/:id/cancel
   *
   * Customer-initiated cancellation. Emits a `cancel_appointment` proposal
   * for dispatcher confirmation rather than mutating directly — approval
   * fires the existing cancellation notification.
   */
  router.post('/:token/appointments/:id/cancel', async (req: PortalRequest, res: Response) => {
    if (!ensurePortal(req, res)) return;
    try {
      const { tenantId, customerId } = req.portal!;
      if (!deps.proposalRepo) {
        res.status(503).json({ error: 'UNAVAILABLE', message: 'Self-service changes are not configured' });
        return;
      }

      const owned = await loadOwnedChangeableAppointment(deps, tenantId, customerId, req.params.id, res);
      if (!owned) return;

      const parsed = cancelSchema.parse(req.body ?? {});
      const createdBy = `portal:customer:${customerId}`;
      const proposal = createProposal({
        tenantId,
        proposalType: 'cancel_appointment',
        payload: {
          appointmentId: owned.id,
          reason: parsed.reason || 'Customer requested cancellation via portal',
          cancellationType: 'customer_request',
        },
        summary: 'Customer requested to cancel their appointment',
        sourceContext: { source: 'customer_portal', customerId },
        createdBy,
      });
      const persisted = await deps.proposalRepo.create(proposal);
      await emitPortalAudit(deps, {
        tenantId,
        createdBy,
        eventType: 'appointment.cancel_requested',
        entityId: owned.id,
        metadata: { proposalId: persisted.id },
      });
      // Surface the "change requested" badge live on any open board for the
      // appointment's day, even though nothing has moved spatially yet.
      notifyDispatchBoardChanged(tenantId, owned.scheduledStart, owned.timezone);

      res.status(201).json({
        status: 'pending_confirmation',
        proposalId: persisted.id,
        message: "We've received your cancellation request and will confirm shortly.",
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  /**
   * POST /:token/appointments/:id/reschedule
   *
   * Customer-initiated reschedule. Verifies the new slot is still open, then
   * emits a `reschedule_appointment` proposal for dispatcher confirmation.
   */
  router.post('/:token/appointments/:id/reschedule', async (req: PortalRequest, res: Response) => {
    if (!ensurePortal(req, res)) return;
    try {
      const { tenantId, customerId } = req.portal!;
      if (!deps.proposalRepo) {
        res.status(503).json({ error: 'UNAVAILABLE', message: 'Self-service changes are not configured' });
        return;
      }

      const owned = await loadOwnedChangeableAppointment(deps, tenantId, customerId, req.params.id, res);
      if (!owned) return;

      const parsed = rescheduleSchema.parse(req.body ?? {});
      const slotStart = new Date(parsed.slotStart);
      const slotEnd = new Date(parsed.slotEnd);
      if (slotEnd.getTime() <= slotStart.getTime() || slotStart.getTime() < Date.now()) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid new time slot' });
        return;
      }

      const scheduling = await resolveTenantScheduling(deps, tenantId);
      const timezone = scheduling.timezone;
      // A reschedule is a new commitment — hold it to the same business-hours
      // discipline as a fresh booking.
      if (!isWithinBusinessHours(slotStart, slotEnd, timezone, scheduling.weeklyHours)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Selected time is outside booking hours',
        });
        return;
      }
      const finderDeps = { appointmentRepo: deps.appointmentRepo, assignmentRepo: deps.assignmentRepo };
      const free = await isSlotFree(finderDeps, { tenantId, start: slotStart, end: slotEnd });
      if (!free) {
        await respondSlotTaken(deps, res, {
          tenantId,
          slotStart,
          slotEnd,
          scheduling,
          message: 'That time is no longer available. Here are other open times.',
        });
        return;
      }

      const createdBy = `portal:customer:${customerId}`;
      const proposal = createProposal({
        tenantId,
        proposalType: 'reschedule_appointment',
        payload: {
          appointmentId: owned.id,
          newScheduledStart: slotStart.toISOString(),
          newScheduledEnd: slotEnd.toISOString(),
          reason: 'Customer requested reschedule via portal',
        },
        summary: 'Customer requested to reschedule their appointment',
        sourceContext: { source: 'customer_portal', customerId },
        createdBy,
      });
      const persisted = await deps.proposalRepo.create(proposal);
      await emitPortalAudit(deps, {
        tenantId,
        createdBy,
        eventType: 'appointment.reschedule_requested',
        entityId: owned.id,
        metadata: { proposalId: persisted.id },
      });
      // Surface the "change requested" badge live on the current day's board.
      notifyDispatchBoardChanged(tenantId, owned.scheduledStart, owned.timezone);

      res.status(201).json({
        status: 'pending_confirmation',
        proposalId: persisted.id,
        message: "We've received your reschedule request and will confirm shortly.",
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  /**
   * POST /:token/payment-methods/setup — begin putting a card on file.
   *
   * Returns a SetupIntent client_secret the browser confirms with Stripe
   * Elements; card data never touches our server. The resulting PaymentMethod
   * is persisted by the `setup_intent.succeeded` webhook. The SetupIntent (and
   * the reused/created Stripe customer) live on the tenant's connected account
   * so the card can later be charged off-session there.
   */
  router.post('/:token/payment-methods/setup', async (req: PortalRequest, res: Response) => {
    if (!ensurePortal(req, res)) return;
    try {
      const { tenantId, customerId } = req.portal!;
      if (!deps.customerPaymentMethodRepo || !deps.stripeConfig) {
        res.status(503).json({ error: 'UNAVAILABLE', message: 'Card-on-file is not configured' });
        return;
      }
      const stripeCustomerId =
        (await deps.customerPaymentMethodRepo.findStripeCustomerId(tenantId, customerId)) ?? undefined;
      const customer = await deps.customerRepo.findById(tenantId, customerId);
      const connect = deps.connectAccountResolver
        ? await deps.connectAccountResolver.resolveTenantConnectAccount(tenantId).catch(() => null)
        : null;
      const result = await createSetupIntent(
        {
          apiKey: deps.stripeConfig.apiKey,
          stripeAccountId: connect && connect.chargesEnabled ? connect.accountId : undefined,
        },
        {
          tenantId,
          customerId,
          stripeCustomerId,
          email: customer?.email,
          name: customer?.displayName,
        },
        deps.stripeFetch,
      );
      res.status(200).json({
        clientSecret: result.clientSecret,
        setupIntentId: result.setupIntentId,
        stripeAccountId: connect && connect.chargesEnabled ? connect.accountId : null,
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  /**
   * GET /:token/payment-methods — list the customer's cards on file. Returns
   * only display metadata (brand/last4/expiry) + the default flag; never the
   * internal Stripe ids.
   */
  router.get('/:token/payment-methods', async (req: PortalRequest, res: Response) => {
    if (!ensurePortal(req, res)) return;
    try {
      const { tenantId, customerId } = req.portal!;
      if (!deps.customerPaymentMethodRepo) {
        res.json({ paymentMethods: [] });
        return;
      }
      const pms = await deps.customerPaymentMethodRepo.findByCustomer(tenantId, customerId);
      res.json({
        paymentMethods: pms.map((p) => ({
          id: p.id,
          brand: p.brand,
          last4: p.last4,
          expMonth: p.expMonth,
          expYear: p.expYear,
          isDefault: p.isDefault,
        })),
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}

/**
 * Load an appointment, confirm it belongs to the portal customer, and that
 * it's still in a customer-changeable state and outside the cutoff window.
 * Writes the appropriate error response and returns null on any failure.
 */
async function loadOwnedChangeableAppointment(
  deps: PublicPortalDeps,
  tenantId: string,
  customerId: string,
  appointmentId: string,
  res: Response,
): Promise<Appointment | null> {
  const appointment = await deps.appointmentRepo.findById(tenantId, appointmentId);
  if (!appointment) {
    res.status(404).json({ error: 'NOT_FOUND', message: 'Appointment not found' });
    return null;
  }
  const job = await deps.jobRepo.findById(tenantId, appointment.jobId);
  if (!job || job.customerId !== customerId) {
    // Don't disclose existence of other customers' appointments.
    res.status(404).json({ error: 'NOT_FOUND', message: 'Appointment not found' });
    return null;
  }
  if (appointment.status === 'canceled' || appointment.status === 'completed' || appointment.status === 'no_show') {
    res.status(409).json({ error: 'NOT_CHANGEABLE', message: 'This appointment can no longer be changed online.' });
    return null;
  }
  if (appointment.scheduledStart.getTime() - Date.now() < SELF_CHANGE_CUTOFF_MS) {
    res.status(409).json({
      error: 'TOO_LATE',
      message: 'This appointment is too soon to change online. Please call us.',
    });
    return null;
  }
  return appointment;
}

async function emitPortalAudit(
  deps: PublicPortalDeps,
  input: { tenantId: string; createdBy: string; eventType: string; entityId: string; metadata?: Record<string, unknown> },
): Promise<void> {
  if (!deps.auditRepo) return;
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.createdBy,
      actorRole: 'customer_portal',
      eventType: input.eventType,
      entityType: 'appointment',
      entityId: input.entityId,
      metadata: input.metadata,
    }),
  );
}

async function resolveBookingLocation(
  deps: PublicPortalDeps,
  tenantId: string,
  customerId: string,
  requestedLocationId: string | undefined,
): Promise<string | null> {
  if (!deps.locationRepo) return null;
  const locations = await deps.locationRepo.findByCustomer(tenantId, customerId);
  const active = locations.filter((l) => !l.isArchived);
  if (requestedLocationId) {
    const match = active.find((l) => l.id === requestedLocationId);
    return match ? match.id : null;
  }
  const primary = active.find((l) => l.isPrimary);
  if (primary) return primary.id;
  return active.length > 0 ? active[0].id : null;
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
  invoiceRepo: InvoiceRepository,
): Promise<InvoicePayload> {
  let payNowUrl: string | null = inv.stripePaymentLinkUrl ?? null;

  // Generate a payment link only when one is missing AND the invoice is
  // actually open for payment. Persist the generated link so subsequent
  // reads are idempotent — without this, every refresh of the portal
  // invoices page would mint a fresh provider link and the prior ones
  // would orphan as live charge URLs the customer never sees.
  if (!payNowUrl && provider && inv.amountDueCents > 0 && isPayable(inv.status)) {
    const link = await safeGenerateLink(provider, {
      tenantId,
      invoiceId: inv.id,
      amountCents: inv.amountDueCents,
      currency,
      description: `Invoice ${inv.invoiceNumber}`,
    });
    if (link) {
      try {
        await invoiceRepo.update(tenantId, inv.id, {
          stripePaymentLinkId: link.linkId,
          stripePaymentLinkUrl: link.linkUrl,
          updatedAt: new Date(),
        });
        payNowUrl = link.linkUrl;
      } catch {
        // Persistence threw — but the throw is ambiguous: the DB may
        // have actually committed and only the response timed out.
        //
        // Codex P2 (PR #315 review): blindly calling deactivateLink
        // here would create a permanent dead-link footgun. If the DB
        // commit went through, future reads of this invoice will see
        // `stripePaymentLinkUrl === link.linkUrl` and serve it — but
        // the link would already be deactivated, leaving the customer
        // with a pay button that goes nowhere until manual repair.
        //
        // Resolve the ambiguity by re-reading the invoice. Three cases:
        //   1. Re-read shows our just-minted URL persisted → success
        //      hidden inside a noisy throw. Use the URL.
        //   2. Re-read shows no URL (or a different URL) → persist
        //      genuinely failed. Deactivate to avoid an orphan.
        //   3. Re-read also throws → can't tell. Don't deactivate
        //      (avoid the dead-link footgun) and serve no payNowUrl.
        //      Next refresh will retry persistence on a clean read.
        let confirmedPersisted = false;
        let canTellFromReread = true;
        try {
          const fresh = await invoiceRepo.findById(tenantId, inv.id);
          confirmedPersisted = !!fresh && fresh.stripePaymentLinkUrl === link.linkUrl;
        } catch {
          canTellFromReread = false;
        }
        if (confirmedPersisted) {
          payNowUrl = link.linkUrl;
        } else if (canTellFromReread) {
          // Persist genuinely failed — deactivate the orphan.
          try {
            await provider.deactivateLink(link.linkId);
          } catch {
            // Stripe deactivate also failed. The just-minted link
            // stays live until manual cleanup. Next refresh retries.
          }
          payNowUrl = null;
        } else {
          // Re-read failed too — DB is genuinely degraded. Don't
          // deactivate (would risk dead-linking a successful persist)
          // and don't serve a URL we're not sure persisted.
          payNowUrl = null;
        }
      }
    }
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
