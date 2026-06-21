import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requirePermission, requireTenant } from '../middleware/auth';
import { DncRepository, normalizePhone } from '../compliance/dnc';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ValidationError } from '../shared/errors';

/**
 * Tenant Do-Not-Call list management.
 *
 * Backs the Settings UI (`SettingsPage > DNC list`). The list is a
 * tenant-local opt-out registry: a number on it is refused by the
 * outbound-consent gate (`voice/outbound-consent.ts`) regardless of any
 * granted customer consent.
 *
 * Routes (all require `settings:manage`):
 *   GET    /api/dnc            — list entries, newest first
 *   POST   /api/dnc            — add a phone to the list
 *   DELETE /api/dnc/:phone     — remove a phone from the list
 *
 * Phones are stored normalized (digits only) so the same number written
 * in multiple formats — `(555) 123-4567`, `+1 555-123-4567`,
 * `15551234567` — resolves to a single row.
 */

const addBodySchema = z.object({
  /** Free-form input; we normalize to digits before storage. */
  phone: z.string().min(7, 'Phone number too short'),
  /**
   * Where the entry came from. Defaults to `manual_settings` for entries
   * created via the Settings UI; the STOP-reply opt-out handler stamps
   * `sms_stop_reply`, etc.
   */
  source: z.string().min(1).default('manual_settings'),
});

const phoneParamSchema = z.object({
  phone: z.string().min(1),
});

export interface DncRouterDeps {
  dncRepo: DncRepository;
  auditRepo?: AuditRepository;
}

export function createDncRouter(deps: DncRouterDeps): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    // Reuses settings:view — DNC management lives in Settings and any
    // operator who can see settings can see the list.
    requirePermission('settings:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const entries = await deps.dncRepo.list(req.auth!.tenantId);
      res.json({
        entries: entries.map((e) => ({
          phone: e.phone,
          source: e.source,
          createdAt: e.createdAt.toISOString(),
        })),
      });
    }),
  );

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = addBodySchema.parse(req.body);
      const normalized = normalizePhone(parsed.phone);
      if (normalized.length < 7) {
        throw new ValidationError('Phone number must contain at least 7 digits');
      }
      await deps.dncRepo.addToDnc(req.auth!.tenantId, normalized, parsed.source);

      if (deps.auditRepo) {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId: req.auth!.tenantId,
            actorId: req.auth!.userId,
            actorRole: req.auth!.role,
            eventType: 'tenant.dnc_added',
            entityType: 'tenant_dnc_list',
            entityId: normalized,
            metadata: { phone: normalized, source: parsed.source },
          }),
        );
      }
      res.status(201).json({ phone: normalized, source: parsed.source });
    }),
  );

  router.delete(
    '/:phone',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const { phone } = phoneParamSchema.parse(req.params);
      const normalized = normalizePhone(decodeURIComponent(phone));
      if (normalized.length === 0) {
        throw new ValidationError('Phone parameter must contain at least one digit');
      }
      await deps.dncRepo.removeFromDnc(req.auth!.tenantId, normalized);

      if (deps.auditRepo) {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId: req.auth!.tenantId,
            actorId: req.auth!.userId,
            actorRole: req.auth!.role,
            eventType: 'tenant.dnc_removed',
            entityType: 'tenant_dnc_list',
            entityId: normalized,
            metadata: { phone: normalized },
          }),
        );
      }
      res.status(204).end();
    }),
  );

  return router;
}
