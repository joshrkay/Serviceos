/**
 * Maintenance contracts REST router.
 *
 * The web client (`MaintenanceContractsPage`, `ContractDetailPage`,
 * `CreateContractSheet`) talks to `/api/maintenance-contracts` GET/POST and
 * `/api/maintenance-contracts/:id` GET. Persisted via
 * PgMaintenanceContractRepository (migration 203) — distinct from
 * `/api/agreements` (the stricter RRULE recurrence model).
 */
import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { ValidationError } from '../shared/errors';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  MaintenanceContract,
  MaintenanceContractRepository,
} from '../maintenance-contracts/maintenance-contract';

export function createMaintenanceContractsRouter(
  repo: MaintenanceContractRepository,
  auditRepo: AuditRepository,
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('customers:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const data = await repo.findByTenant(req.auth!.tenantId);
      res.json({ data, total: data.length });
    }),
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('customers:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const found = await repo.findById(req.auth!.tenantId, req.params.id);
      if (!found) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Contract not found' });
        return;
      }
      res.json(found);
    }),
  );

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('customers:create'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title) {
        throw new ValidationError('title is required', { field: 'title' });
      }

      const customerInput = typeof body.customer === 'string' ? body.customer : undefined;
      const locationInput = typeof body.location === 'string' ? body.location : undefined;

      const now = new Date().toISOString();
      const contract: MaintenanceContract = {
        id: randomUUID(),
        tenantId,
        title,
        status: 'active',
        customer: customerInput ? { displayName: customerInput } : undefined,
        location: locationInput ? { street1: locationInput } : undefined,
        cadence: typeof body.cadence === 'string' ? body.cadence : undefined,
        serviceWindow: typeof body.serviceWindow === 'string' ? body.serviceWindow : undefined,
        duration: typeof body.duration === 'string' ? body.duration : undefined,
        startDate: typeof body.startDate === 'string' ? body.startDate : undefined,
        endDate: typeof body.endDate === 'string' ? body.endDate : undefined,
        defaultSummary: typeof body.defaultSummary === 'string' ? body.defaultSummary : undefined,
        createdAt: now,
        updatedAt: now,
      };

      const created = await repo.create(contract);

      // D2-1e — all mutations emit audit events.
      await auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role ?? 'unknown',
          eventType: 'maintenance_contract.created',
          entityType: 'maintenance_contract',
          entityId: created.id,
          metadata: {
            title: created.title,
            cadence: created.cadence,
          },
        })
      );

      res.status(201).json(created);
    }),
  );

  return router;
}
