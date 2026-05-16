/**
 * P10-001 — Authed routes for portal session management.
 *
 * Mounted at `/api/portal-sessions` (NOT under `/api/customers`) because
 * the existing customers router file is on the freeze list and we are
 * not allowed to compose another router into it. The body must include
 * `customerId`. URL composition uses the request host so the link is
 * tenant-correct without env coupling.
 */
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { CustomerRepository } from '../customers/customer';
import { toErrorResponse } from '../shared/errors';
import { extractIp } from '../shared/extract-ip';
import { AuditRepository } from '../audit/audit';
import { PortalSessionRepository } from '../portal/portal-session';
import {
  DEFAULT_PORTAL_TTL_DAYS,
  createPortalSession,
  revokePortalSession,
} from '../portal/portal-service';

const createSchema = z.object({
  customerId: z.string().uuid(),
  /** Optional override; clamps to 1..365 to avoid pathological values. */
  ttlDays: z.number().int().positive().max(365).optional(),
});

export interface PortalRouterDeps {
  portalRepo: PortalSessionRepository;
  customerRepo: CustomerRepository;
  /**
   * D2-1d: audit logging for portal-session mint / revoke. Optional so
   * older harnesses that don't wire it still build the router.
   */
  auditRepo?: AuditRepository;
}

export function createPortalRouter(deps: PortalRouterDeps): Router {
  const router = Router();
  router.use(requireAuth, requireTenant);

  router.post('/', async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    try {
      const parsed = createSchema.parse(req.body ?? {});
      // Defense in depth — confirm the customer exists in this tenant
      // before issuing a token. Prevents an authenticated owner from
      // accidentally minting a token tied to a non-existent customer.
      const customer = await deps.customerRepo.findById(
        auth.tenantId,
        parsed.customerId,
      );
      if (!customer) {
        res.status(404).json({
          error: 'NOT_FOUND',
          message: `Customer not found: ${parsed.customerId}`,
        });
        return;
      }

      const session = await createPortalSession(
        auth.tenantId,
        parsed.customerId,
        auth.userId,
        deps.portalRepo,
        parsed.ttlDays ?? DEFAULT_PORTAL_TTL_DAYS,
        deps.auditRepo,
        {
          actorRole: auth.role,
          ipAddress: extractIp(req),
          userAgent: req.headers['user-agent'],
        },
      );

      const url = `${req.protocol}://${req.get('host')}/portal/${session.token}`;

      res.status(201).json({
        id: session.id,
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
        url,
        customerId: parsed.customerId,
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    try {
      const session = await revokePortalSession(
        auth.tenantId,
        req.params.id,
        deps.portalRepo,
        deps.auditRepo,
        {
          actorId: auth.userId,
          actorRole: auth.role,
          ipAddress: extractIp(req),
          userAgent: req.headers['user-agent'],
        },
      );
      if (!session) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Portal session not found' });
        return;
      }
      res.status(200).json({
        id: session.id,
        revokedAt: session.revokedAt?.toISOString(),
      });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}
