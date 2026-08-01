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
import { ContactRepository } from '../customers/contact';
import { asyncRoute } from '../middleware/async-route';
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
  /**
   * C2/I14 — bind the session to a specific customer contact. The
   * contact's role determines the portal entitlement at read time
   * (site/other → service surface only, no billing).
   */
  contactId: z.string().uuid().optional(),
  /** Optional override; clamps to 1..365 to avoid pathological values. */
  ttlDays: z.number().int().positive().max(365).optional(),
});

export interface PortalRouterDeps {
  portalRepo: PortalSessionRepository;
  customerRepo: CustomerRepository;
  /** C2/I14 — required to mint contact-bound sessions. */
  contactRepo?: ContactRepository;
  /**
   * D2-1d: audit logging for portal-session mint / revoke. Optional so
   * older harnesses that don't wire it still build the router.
   */
  auditRepo?: AuditRepository;
}

export function createPortalRouter(deps: PortalRouterDeps): Router {
  const router = Router();
  router.use(requireAuth, requireTenant);

  router.post('/', asyncRoute(async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
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

    // C2/I14 — a contact-bound token must reference a live contact on THIS
    // customer. Entitlement itself is derived from the contact's role at
    // token-resolution time, so nothing role-related is stored here.
    if (parsed.contactId) {
      if (!deps.contactRepo) {
        res.status(503).json({
          error: 'UNAVAILABLE',
          message: 'Contact-bound portal sessions are not configured',
        });
        return;
      }
      const contact = await deps.contactRepo.findById(auth.tenantId, parsed.contactId);
      if (!contact || contact.isArchived || contact.customerId !== parsed.customerId) {
        res.status(404).json({
          error: 'NOT_FOUND',
          message: `Contact not found on customer: ${parsed.contactId}`,
        });
        return;
      }
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
      { contactId: parsed.contactId },
    );

    const url = `${req.protocol}://${req.get('host')}/portal/${session.token}`;

    res.status(201).json({
      id: session.id,
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
      url,
      customerId: parsed.customerId,
      contactId: parsed.contactId,
    });
  }));

  router.delete('/:id', asyncRoute(async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
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
  }));

  return router;
}
