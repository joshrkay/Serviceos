/**
 * Public, token-less online booking — the prospect-facing funnel.
 *
 * Jobber's "Online Booking" / ServiceTitan's online scheduler let a brand-new
 * customer — with no account and no portal token — pick a real open slot from
 * a shareable link and request an appointment. The token-gated customer
 * portal (`public-portal.ts`) already does self-service booking for EXISTING
 * customers; this router is the missing acquisition surface for NEW ones.
 *
 * Mounted at `/api/public/booking`, BEFORE the global Clerk auth middleware:
 * there is no session, the tenant is identified by UUID in the path (exactly
 * like `public-intake.ts`, and for the same shareable-link reason).
 *
 * Routes:
 *   GET  /:tenantId/availability?from=&to=&durationMin=   open slots
 *   POST /:tenantId                                        request a booking
 *
 * Trust model: a public booking NEVER auto-confirms. It creates the customer,
 * a service location, a job, and a tentative HELD appointment (24h), plus a
 * `create_booking` proposal that lands in the owner's approval queue. The hold
 * makes the slot show as busy, so a second prospect grabbing the same window
 * gets a 409 with fresh alternatives. Identical to the portal flow's safety,
 * minus the pre-existing customer.
 */
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { toErrorResponse } from '../shared/errors';
import { CustomerRepository, createCustomer } from '../customers/customer';
import { LocationRepository, createLocation } from '../locations/location';
import { JobRepository, createJob } from '../jobs/job';
import { AppointmentRepository, createAppointment } from '../appointments/appointment';
import { AssignmentRepository } from '../appointments/assignment';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { SettingsRepository } from '../settings/settings';
import { ProposalRepository, createProposal } from '../proposals/proposal';
import { TenantRepository } from '../auth/clerk';
import {
  findBookableSlots,
  isSlotFree,
  isWithinBusinessHours,
  WeeklyBusinessHours,
  schedulingConfigFromSettings,
} from '../scheduling/booking-availability';
import { notifyDispatchBoardChanged } from '../dispatch/board-notify';
import {
  TenantTransactionRunner,
  InMemoryTransactionRunner,
} from '../db/tenant-transaction';
import { createLogger } from '../logging/logger';

const bookingLogger = createLogger({
  service: 'public-booking-route',
  environment: process.env.NODE_ENV || 'development',
});

export interface PublicBookingDeps {
  tenantRepo: TenantRepository;
  customerRepo: CustomerRepository;
  locationRepo: LocationRepository;
  jobRepo: JobRepository;
  appointmentRepo: AppointmentRepository;
  proposalRepo: ProposalRepository;
  auditRepo?: AuditRepository;
  assignmentRepo?: AssignmentRepository;
  settingsRepo?: SettingsRepository;
  /** Wraps the booking writes in one atomic, slot-locked transaction. */
  transactionRunner?: TenantTransactionRunner;
}

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A self-service hold survives 24h before the finder treats the slot as free. */
const BOOKING_HOLD_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BOOKING_TIMEZONE = 'America/New_York';
const PUBLIC_BOOKING_ACTOR_ROLE = 'public_booking';

const availabilityQuerySchema = z.object({
  from: z.string().regex(DATE_RE, 'from must be YYYY-MM-DD'),
  to: z.string().regex(DATE_RE, 'to must be YYYY-MM-DD'),
  durationMin: z.coerce.number().int().min(15).max(480).default(60),
});

const bookingSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().max(100).optional(),
    primaryPhone: z.string().trim().min(7).max(40).optional(),
    email: z.string().trim().email().max(254).optional(),
    smsConsent: z.boolean().optional(),
    // Structured service address — a real visit needs a real address.
    street1: z.string().trim().min(1).max(200),
    street2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(120),
    state: z.string().trim().min(1).max(60),
    postalCode: z.string().trim().min(1).max(20),
    accessNotes: z.string().trim().max(500).optional(),
    // What they need + the slot they chose.
    summary: z.string().trim().min(1).max(2000),
    serviceType: z.string().trim().max(120).optional(),
    slotStart: z.string().datetime(),
    slotEnd: z.string().datetime(),
    // Honeypot — bots fill every field; humans never touch the hidden one.
    _company_url: z.string().max(500).optional(),
  })
  .refine((v) => Boolean(v.primaryPhone || v.email), {
    message: 'A primaryPhone or email is required so we can confirm your booking',
  });

interface ResolvedScheduling {
  timezone: string;
  weeklyHours: WeeklyBusinessHours | null;
  bufferMinutes: number | null;
}

/**
 * Load the tenant's scheduling configuration once per request: timezone,
 * per-day business hours, and travel buffer. All three propagate into slot
 * generation AND slot validation so the POST can only book what GET offers.
 */
async function resolveTenantScheduling(
  deps: PublicBookingDeps,
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

/** 409 with the next open slots in a 7-day window — same shape as the portal. */
async function respondSlotTaken(
  deps: PublicBookingDeps,
  res: Response,
  args: { tenantId: string; slotStart: Date; slotEnd: Date; scheduling: ResolvedScheduling },
): Promise<void> {
  const durationMin = Math.round((args.slotEnd.getTime() - args.slotStart.getTime()) / 60000);
  const alternatives = await findBookableSlots(
    { appointmentRepo: deps.appointmentRepo, assignmentRepo: deps.assignmentRepo },
    {
      tenantId: args.tenantId,
      fromDate: args.slotStart.toISOString().slice(0, 10),
      toDate: new Date(args.slotStart.getTime() + 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
      timezone: args.scheduling.timezone,
      durationMin,
      weeklyHours: args.scheduling.weeklyHours,
      bufferMinutes: args.scheduling.bufferMinutes,
    },
  );
  res.status(409).json({
    error: 'SLOT_TAKEN',
    message: 'That time was just booked. Here are the next available slots.',
    alternatives: alternatives.map((s) => ({
      start: s.start.toISOString(),
      end: s.end.toISOString(),
    })),
  });
}

export function createPublicBookingRouter(deps: PublicBookingDeps): Router {
  const router = Router();

  /**
   * GET /:tenantId/availability — open slots a prospect can choose from.
   * Read-only, no PII; mirrors the portal availability endpoint so both
   * surfaces compute slots with identical logic.
   */
  router.get('/:tenantId/availability', async (req: Request, res: Response) => {
    try {
      const tenantId = req.params.tenantId;
      if (!TENANT_UUID.test(tenantId)) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid tenantId' });
        return;
      }
      const tenant = await deps.tenantRepo.findById(tenantId);
      if (!tenant) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Booking page not found' });
        return;
      }

      const q = availabilityQuerySchema.parse(req.query ?? {});
      const scheduling = await resolveTenantScheduling(deps, tenantId);
      const timezone = scheduling.timezone;
      const slots = await findBookableSlots(
        { appointmentRepo: deps.appointmentRepo, assignmentRepo: deps.assignmentRepo },
        {
          tenantId,
          fromDate: q.from,
          toDate: q.to,
          timezone,
          durationMin: q.durationMin,
          weeklyHours: scheduling.weeklyHours,
          bufferMinutes: scheduling.bufferMinutes,
        },
      );

      res.status(200).json({
        timezone,
        durationMin: q.durationMin,
        slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  /**
   * POST /:tenantId — request a booking. Creates customer + location + job +
   * held appointment + `create_booking` proposal atomically, behind a
   * per-tenant advisory lock so concurrent prospects can't double-book.
   */
  router.post('/:tenantId', async (req: Request, res: Response) => {
    try {
      const tenantId = req.params.tenantId;
      if (!TENANT_UUID.test(tenantId)) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid tenantId' });
        return;
      }
      const tenant = await deps.tenantRepo.findById(tenantId);
      if (!tenant) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Booking page not found' });
        return;
      }

      const parsed = bookingSchema.parse(req.body ?? {});

      // Honeypot tripped — pretend success so the bot moves on, write nothing.
      if (parsed._company_url && parsed._company_url.trim().length > 0) {
        res.status(200).json({ status: 'pending_confirmation' });
        return;
      }

      const slotStart = new Date(parsed.slotStart);
      const slotEnd = new Date(parsed.slotEnd);
      if (slotEnd.getTime() <= slotStart.getTime()) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'slotEnd must be after slotStart' });
        return;
      }
      // Bound the duration so a crafted request can't hold a multi-day window
      // (isSlotFree only checks for conflicts, not sane length). Matches the
      // availability finder's 15–480 minute slot constraints.
      const durationMin = (slotEnd.getTime() - slotStart.getTime()) / 60000;
      if (durationMin < 15 || durationMin > 480) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Booking duration must be between 15 and 480 minutes' });
        return;
      }
      if (slotStart.getTime() < Date.now()) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Cannot book a slot in the past' });
        return;
      }

      const scheduling = await resolveTenantScheduling(deps, tenantId);
      const timezone = scheduling.timezone;

      // Re-validate the submitted window against the SAME business hours used to
      // generate availability, in the tenant timezone. A caller can POST any
      // future slot bypassing the UI; without this an out-of-hours request
      // (e.g. 02:00) would still create a held appointment that GET
      // /availability would never have offered.
      if (!isWithinBusinessHours(slotStart, slotEnd, timezone, scheduling.weeklyHours)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Selected time is outside booking hours',
        });
        return;
      }

      const createdBy = PUBLIC_BOOKING_ACTOR_ROLE;
      const finderDeps = {
        appointmentRepo: deps.appointmentRepo,
        assignmentRepo: deps.assignmentRepo,
      };
      const runner = deps.transactionRunner ?? new InMemoryTransactionRunner();

      // One transaction wraps the slot re-check and every write so a
      // mid-sequence failure can't orphan a customer/job. The per-tenant
      // advisory lock serializes concurrent bookings: a per-slot key is unsafe
      // because overlapping windows with different starts would take different
      // locks and both pass isSlotFree. (Same reasoning as the portal flow.)
      const outcome = await runner.run(tenantId, async ({ lock }) => {
        // Shared key with the portal booking flow (public-portal.ts) so a
        // public prospect and an existing customer can't both pass isSlotFree
        // for overlapping windows on the same tenant calendar. The lock is
        // already per-tenant (the runner namespaces by tenantId).
        await lock('self-service-booking');

        const stillFree = await isSlotFree(finderDeps, {
          tenantId,
          start: slotStart,
          end: slotEnd,
        });
        if (!stillFree) {
          return { ok: false as const };
        }

        const customer = await createCustomer(
          {
            tenantId,
            firstName: parsed.firstName,
            lastName: parsed.lastName ?? '',
            primaryPhone: parsed.primaryPhone,
            email: parsed.email,
            smsConsent: parsed.smsConsent,
            preferredChannel: parsed.primaryPhone ? 'phone' : 'email',
            createdBy,
            actorRole: PUBLIC_BOOKING_ACTOR_ROLE,
          },
          deps.customerRepo,
          deps.auditRepo,
        );

        const location = await createLocation(
          {
            tenantId,
            customerId: customer.id,
            street1: parsed.street1,
            street2: parsed.street2,
            city: parsed.city,
            state: parsed.state,
            postalCode: parsed.postalCode,
            accessNotes: parsed.accessNotes,
            isPrimary: true,
          },
          deps.locationRepo,
          deps.auditRepo,
          createdBy,
          PUBLIC_BOOKING_ACTOR_ROLE,
        );

        const job = await createJob(
          {
            tenantId,
            customerId: customer.id,
            locationId: location.id,
            summary: parsed.summary,
            createdBy,
            actorRole: PUBLIC_BOOKING_ACTOR_ROLE,
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
            notes: parsed.serviceType
              ? `${parsed.serviceType}: ${parsed.summary}`
              : parsed.summary,
            createdBy,
            holdPendingApproval: true,
            holdExpiryAt: new Date(Date.now() + BOOKING_HOLD_WINDOW_MS),
          },
          deps.appointmentRepo,
        );

        // No sourceTrustTier — a prospect-initiated booking is never
        // auto-approved. It lands as a draft proposal for the owner.
        const proposal = createProposal({
          tenantId,
          proposalType: 'create_booking',
          payload: { appointmentId: held.id },
          summary: `New online booking: ${parsed.summary}`,
          explanation:
            'Submitted via the public online-booking page by a new customer. Confirm to finalize the appointment.',
          sourceContext: {
            source: 'public_booking',
            customerId: customer.id,
            jobId: job.id,
            serviceType: parsed.serviceType,
          },
          createdBy,
          expiresAt: held.holdExpiryAt,
        });
        const persisted = await deps.proposalRepo.create(proposal);

        if (deps.auditRepo) {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: createdBy,
              actorRole: PUBLIC_BOOKING_ACTOR_ROLE,
              eventType: 'appointment.booking_requested',
              entityType: 'appointment',
              entityId: held.id,
              metadata: { proposalId: persisted.id, jobId: job.id, customerId: customer.id },
            }),
          );
        }

        return { ok: true as const, held, proposalId: persisted.id };
      });

      if (!outcome.ok) {
        await respondSlotTaken(deps, res, { tenantId, slotStart, slotEnd, scheduling });
        return;
      }

      // The tentative hold should appear on any open dispatch board for that
      // day immediately, flagged pending approval. Best-effort: a broadcast
      // failure must not 500 a booking that already committed.
      try {
        notifyDispatchBoardChanged(tenantId, outcome.held.scheduledStart, outcome.held.timezone);
      } catch (broadcastErr) {
        bookingLogger.error('dispatch-board broadcast failed after booking', {
          tenantId,
          error: broadcastErr instanceof Error ? broadcastErr.message : String(broadcastErr),
        });
      }

      res.status(201).json({
        status: 'pending_confirmation',
        proposalId: outcome.proposalId,
        appointmentId: outcome.held.id,
        scheduledStart: outcome.held.scheduledStart.toISOString(),
        scheduledEnd: outcome.held.scheduledEnd.toISOString(),
        timezone,
        message: "Thanks! We've received your request and will confirm shortly.",
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}
