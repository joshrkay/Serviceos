import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { toErrorResponse } from '../shared/errors';
import { tzMidnight } from '../shared/timezone';
import { AuditRepository } from '../audit/audit';
import { NegativeDurationError, TimeEntryRepository } from '../time-tracking/time-entry';
import { TimeEntryService } from '../time-tracking/time-entry-service';

/**
 * P12-002 — Time-tracking HTTP routes.
 *
 * Permission boundary (per spec):
 *   - tech can clock self only (req.auth.userId === userId)
 *   - owner can clock anyone
 * Dispatcher is treated like owner — they're already trusted with
 * scheduling concerns. Anyone else is a 403.
 */

const entryTypeSchema = z.enum(['job', 'drive', 'break', 'admin']);

const clockInSchema = z.object({
  userId: z.string().min(1).optional(),
  jobId: z.string().uuid().optional(),
  entryType: entryTypeSchema,
  notes: z.string().max(2000).optional(),
  clockedInAt: z.string().datetime().optional(),
});

const clockOutSchema = z.object({
  userId: z.string().min(1).optional(),
  notes: z.string().max(2000).optional(),
  clockedOutAt: z.string().datetime().optional(),
});

function canActOnBehalf(req: AuthenticatedRequest, targetUserId: string): boolean {
  const role = req.auth?.role;
  if (role === 'owner' || role === 'dispatcher') return true;
  return req.auth?.userId === targetUserId;
}

export function createTimeEntriesRouter(
  repo: TimeEntryRepository,
  auditRepo: AuditRepository
): Router {
  const router = Router();
  const service = new TimeEntryService(repo, auditRepo);

  router.post(
    '/clock-in',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = clockInSchema.parse(req.body);
        const targetUserId = parsed.userId ?? req.auth!.userId;
        if (!canActOnBehalf(req, targetUserId)) {
          res.status(403).json({
            error: 'FORBIDDEN',
            message: 'Cannot clock in another user',
          });
          return;
        }
        const entry = await service.clockIn(req.auth!.tenantId, targetUserId, {
          jobId: parsed.jobId,
          entryType: parsed.entryType,
          notes: parsed.notes,
          clockedInAt: parsed.clockedInAt ? new Date(parsed.clockedInAt) : undefined,
          actorRole: req.auth!.role,
        });
        res.status(201).json(entry);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.post(
    '/clock-out',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = clockOutSchema.parse(req.body);
        const targetUserId = parsed.userId ?? req.auth!.userId;
        if (!canActOnBehalf(req, targetUserId)) {
          res.status(403).json({
            error: 'FORBIDDEN',
            message: 'Cannot clock out another user',
          });
          return;
        }
        const entry = await service.clockOut(req.auth!.tenantId, targetUserId, {
          notes: parsed.notes,
          clockedOutAt: parsed.clockedOutAt ? new Date(parsed.clockedOutAt) : undefined,
          actorRole: req.auth!.role,
        });
        if (!entry) {
          res.status(404).json({
            error: 'NOT_FOUND',
            message: 'No active time entry to clock out',
          });
          return;
        }
        res.json(entry);
      } catch (err) {
        if (err instanceof NegativeDurationError) {
          res.status(422).json({
            error: 'INVALID_DURATION',
            message: err.message,
          });
          return;
        }
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.get(
    '/active',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const userId = (req.query.userId as string | undefined) ?? req.auth!.userId;
        if (!canActOnBehalf(req, userId)) {
          res.status(403).json({
            error: 'FORBIDDEN',
            message: 'Cannot view another user\'s time entries',
          });
          return;
        }
        const entry = await service.findActiveEntry(req.auth!.tenantId, userId);
        res.json({ active: entry });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  /**
   * GET /api/time-entries?userId=&weekOf=YYYY-MM-DD&tz=America/Los_Angeles
   * GET /api/time-entries?jobId=<uuid>
   *
   * When `jobId` is supplied we return every entry logged against that
   * job (any user, any entry type) — this backs the JobDetail time panel,
   * which must show the job's entries rather than the caller's entries
   * across all jobs. When `weekOf` is supplied we return the rollup for
   * that week. Otherwise we return the raw list (userId-scoped, default
   * 100 most recent).
   */
  router.get(
    '/',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const jobId = req.query.jobId as string | undefined;
        if (jobId) {
          // Job-scoped read: tenant-isolated, returns entries for any user
          // on the job. No per-user `canActOnBehalf` guard — the panel is a
          // job-level view, gated by tenant scope (RLS) only.
          const entries = await repo.findByJob(req.auth!.tenantId, jobId);
          res.json(entries);
          return;
        }

        const userId = (req.query.userId as string | undefined) ?? req.auth!.userId;
        if (!canActOnBehalf(req, userId)) {
          res.status(403).json({
            error: 'FORBIDDEN',
            message: 'Cannot view another user\'s time entries',
          });
          return;
        }

        const weekOf = req.query.weekOf as string | undefined;
        const tz = (req.query.tz as string | undefined) ?? 'UTC';

        if (weekOf) {
          // weekOf is YYYY-MM-DD; resolve to the UTC instant that
          // corresponds to 00:00 local time in tenant tz so the rollup
          // window aligns with the tenant's calendar week.
          let weekStart: Date;
          try {
            weekStart = tzMidnight(weekOf, tz);
          } catch {
            res.status(400).json({
              error: 'VALIDATION_ERROR',
              message: 'weekOf must be a valid YYYY-MM-DD date',
            });
            return;
          }
          const rollups = await service.weeklyHoursByUser(
            req.auth!.tenantId,
            weekStart,
            tz
          );
          // Filter to the requested user; keep array shape so the
          // frontend can pivot when an owner asks for the whole crew.
          const filtered = rollups.filter((r) => r.userId === userId);
          if (filtered.length === 0) {
            res.json([
              { userId, weekStart: weekOf, byDay: [], totalHours: 0 },
            ]);
            return;
          }
          res.json(filtered);
          return;
        }

        const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
        const entries = await repo.findByTenant(req.auth!.tenantId, {
          userId,
          limit: Number.isNaN(limit) ? 100 : Math.min(limit, 500),
        });
        res.json(entries);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
