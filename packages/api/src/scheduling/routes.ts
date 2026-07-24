import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { validate } from '../shared/validation';
import { UserRepository } from '../users/user';
import { SettingsRepository } from '../settings/settings';
import { FeasibilityDependencies } from './feasibility-types';
import { checkFeasibility } from './feasibility';
import {
  findBookableSlotsDetailed,
  schedulingConfigFromSettings,
} from './booking-availability';

const bodySchema = z.object({
  appointmentId: z.string().min(1),
  proposedTechnicianId: z.string().min(1),
  proposedScheduledStart: z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), 'invalid ISO date'),
  proposedScheduledEnd: z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), 'invalid ISO date'),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /availability query contract. Mirrors the public-booking availability
 * endpoint's params (from/to/durationMin) so the authed dispatch surface and
 * the prospect-facing funnel compute slots with identical inputs, plus an
 * optional technicianId to scope the search to one calendar (reschedule /
 * reassign flows pick a slot for a specific tech).
 */
const availabilityQuerySchema = z.object({
  from: z.string().regex(DATE_RE, 'from must be YYYY-MM-DD'),
  to: z.string().regex(DATE_RE, 'to must be YYYY-MM-DD'),
  durationMin: z.coerce.number().int().min(15).max(480).default(60),
  technicianId: z.string().uuid().optional(),
});

/** Fallback tz when the tenant has no settings row yet — matches public-booking. */
const DEFAULT_TIMEZONE = 'America/New_York';

export function createSchedulingRouter(
  deps: FeasibilityDependencies,
  userRepo: UserRepository,
  settingsRepo?: SettingsRepository,
): Router {
  const router = Router();

  /**
   * GET /availability — open slots the operator can book/reschedule into.
   *
   * The authenticated dispatch surface was reactive-only (POST /check-feasibility
   * validates a PROPOSED slot); the slot logic that finds OPEN windows lived only
   * behind the public/portal booking routes. This wraps `findBookableSlots`
   * (business-hours aware, tenant-tz, never-in-the-past) so the mobile SlotPicker
   * has an authed source for manual booking (B1) and reschedule slot-pick (B2).
   *
   * Read-only — no audit event. Tenant is derived from the verified session, so
   * one tenant can never read another's calendar. Auth matches its sibling
   * check-feasibility (requireAuth + requireTenant): the same operators who may
   * validate a slot may enumerate open ones.
   *
   * Response mirrors the public-booking shape: { timezone, durationMin, slots }.
   */
  router.get(
    '/availability',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        // `.parse` (not the `validate` helper) so the coerced/defaulted output
        // type flows through — durationMin is `number` here, not `number | undefined`.
        const q = availabilityQuerySchema.parse(req.query ?? {});
        const tenantId = req.auth!.tenantId;

        const settings = settingsRepo ? await settingsRepo.findByTenant(tenantId) : null;
        const timezone = settings?.timezone || deps.timezone || DEFAULT_TIMEZONE;
        const tenantConfig = schedulingConfigFromSettings(settings);

        const { slots, config } = await findBookableSlotsDetailed(
          {
            appointmentRepo: deps.appointmentRepo,
            assignmentRepo: deps.assignmentRepo,
            workingHoursRepo: deps.workingHoursRepo,
            unavailableBlockRepo: deps.unavailableBlockRepo,
          },
          {
            tenantId,
            fromDate: q.from,
            toDate: q.to,
            timezone,
            durationMin: q.durationMin,
            technicianId: q.technicianId,
            weeklyHours: tenantConfig.weeklyHours,
            bufferMinutes: tenantConfig.bufferMinutes,
          },
        );

        // Config provenance so a cold tenant sees "these are defaults,
        // configure X" instead of windows it never chose (V18). Additive —
        // existing clients that only read `slots` are unaffected.
        const configNotes: string[] = [];
        if (!settings?.timezone) {
          configNotes.push(
            `Timezone not configured — using ${timezone}. Set it in Settings → Business profile.`,
          );
        }
        if (config.businessHoursSource === 'default') {
          configNotes.push(
            'Business hours not configured — using the 08:00–17:00 default. Set them in Settings → Business profile.',
          );
        }
        if (config.bufferSource === 'default') {
          configNotes.push(
            `Travel buffer not configured — using the ${config.bufferMinutes}-minute default.`,
          );
        }

        res.status(200).json({
          timezone,
          durationMin: q.durationMin,
          slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
          config: {
            timezoneSource: settings?.timezone ? 'tenant' : 'default',
            businessHoursSource: config.businessHoursSource,
            bufferSource: config.bufferSource,
            bufferMinutes: config.bufferMinutes,
            technicianHoursApplied: config.technicianHoursApplied,
            technicianTimeOffApplied: config.technicianTimeOffApplied,
            notes: configNotes,
          },
        });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.post(
    '/check-feasibility',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = validate(bodySchema, req.body);
        const tenantId = req.auth!.tenantId;

        const appointment = await deps.appointmentRepo.findById(tenantId, parsed.appointmentId);
        if (!appointment) {
          res.status(404).json({ error: 'APPOINTMENT_NOT_FOUND' });
          return;
        }

        const tech = await userRepo.findById(tenantId, parsed.proposedTechnicianId);
        if (!tech || tech.role !== 'technician') {
          res.status(404).json({ error: 'TECHNICIAN_NOT_FOUND' });
          return;
        }

        const result = await checkFeasibility(
          {
            tenantId,
            appointment,
            proposedTechnicianId: parsed.proposedTechnicianId,
            proposedScheduledStart: new Date(parsed.proposedScheduledStart),
            proposedScheduledEnd: new Date(parsed.proposedScheduledEnd),
          },
          deps,
        );

        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
