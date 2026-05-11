/**
 * BUG-6 — Maintenance contracts REST router.
 *
 * The web client (`MaintenanceContractsPage`, `ContractDetailPage`,
 * `CreateContractSheet`) talks to `/api/maintenance-contracts` GET/POST and
 * `/api/maintenance-contracts/:id` GET. Without these handlers the
 * Contracts page surfaces "Failed to load contracts" on render.
 *
 * Backed by an in-process tenant-scoped store. The shape mirrors what
 * the frontend renders — title/customer/location/cadence/etc — and is
 * intentionally distinct from `/api/agreements` (which uses a stricter
 * data model).
 *
 * Production wiring through a real repository is tracked separately.
 */
import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse, ValidationError } from '../shared/errors';

interface MaintenanceContract {
  id: string;
  tenantId: string;
  title: string;
  status: 'active' | 'paused' | 'cancelled';
  customer?: { id?: string; displayName?: string; firstName?: string; lastName?: string };
  location?: { id?: string; street1?: string };
  cadence?: string;
  serviceWindow?: string;
  duration?: string;
  startDate?: string;
  endDate?: string;
  defaultSummary?: string;
  createdAt: string;
  updatedAt: string;
}

const contractsByTenant = new Map<string, MaintenanceContract[]>();

function listForTenant(tenantId: string): MaintenanceContract[] {
  return contractsByTenant.get(tenantId) ?? [];
}

function setForTenant(tenantId: string, rows: MaintenanceContract[]): void {
  contractsByTenant.set(tenantId, rows);
}

export function createMaintenanceContractsRouter(): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('customers:view'),
    (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const data = listForTenant(tenantId);
      res.json({ data, total: data.length });
    },
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('customers:view'),
    (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const found = listForTenant(tenantId).find((c) => c.id === req.params.id);
      if (!found) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Contract not found' });
        return;
      }
      res.json(found);
    },
  );

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('customers:create'),
    (req: AuthenticatedRequest, res: Response) => {
      try {
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
          defaultSummary: typeof body.defaultSummary === 'string' ? body.defaultSummary : undefined,
          createdAt: now,
          updatedAt: now,
        };

        const rows = listForTenant(tenantId);
        setForTenant(tenantId, [contract, ...rows]);
        res.status(201).json(contract);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
