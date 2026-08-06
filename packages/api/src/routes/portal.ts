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
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { PortalSessionRepository } from '../portal/portal-session';
import type { SendService } from '../notifications/send-service';
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

/**
 * Mint+send body. ''→undefined on the recipient/message fields mirrors the
 * estimate/invoice send routes: the send sheet posts empty strings for
 * untouched fields, and SendService must fall back to the customer's
 * contact on file instead of failing on ''.
 */
const sendSchema = createSchema.extend({
  channel: z.enum(['sms', 'email', 'both']).default('sms'),
  recipientPhone: z.string().optional().transform((v) => v || undefined),
  recipientEmail: z.string().optional().transform((v) => v || undefined),
  customMessage: z.string().optional().transform((v) => v || undefined),
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
  /**
   * Portal-link distribution (POST /send). Optional for the same reason
   * app.ts's other send routes take it optionally: environments without a
   * message-delivery provider still boot; the route answers 503 there.
   */
  sendService?: SendService;
}

export function createPortalRouter(deps: PortalRouterDeps): Router {
  const router = Router();
  router.use(requireAuth, requireTenant);

  /**
   * Shared mint-time validation for POST / and POST /send. Writes the
   * error response and returns false when the target is invalid.
   *
   * Defense in depth — confirm the customer exists in this tenant before
   * issuing a token. Prevents an authenticated owner from accidentally
   * minting a token tied to a non-existent customer.
   *
   * C2/I14 — a contact-bound token must reference a live contact on THIS
   * customer. Entitlement itself is derived from the contact's role at
   * token-resolution time, so nothing role-related is stored here.
   */
  async function validateMintTarget(
    res: Response,
    tenantId: string,
    customerId: string,
    contactId?: string,
  ): Promise<boolean> {
    const customer = await deps.customerRepo.findById(tenantId, customerId);
    if (!customer) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: `Customer not found: ${customerId}`,
      });
      return false;
    }
    if (contactId) {
      if (!deps.contactRepo) {
        res.status(503).json({
          error: 'UNAVAILABLE',
          message: 'Contact-bound portal sessions are not configured',
        });
        return false;
      }
      const contact = await deps.contactRepo.findById(tenantId, contactId);
      if (!contact || contact.isArchived || contact.customerId !== customerId) {
        res.status(404).json({
          error: 'NOT_FOUND',
          message: `Contact not found on customer: ${contactId}`,
        });
        return false;
      }
    }
    return true;
  }

  router.post('/', asyncRoute(async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    const parsed = createSchema.parse(req.body ?? {});
    if (!(await validateMintTarget(res, auth.tenantId, parsed.customerId, parsed.contactId))) {
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

  /**
   * Mint + deliver in one call. This is NOT `POST /:id/send` on purpose:
   * portal tokens are stored hash-only (portal-service.ts), so the
   * plaintext link exists exactly once — at mint time. Re-sending an
   * existing session's link is impossible by design; distributing a link
   * always mints a fresh session.
   *
   * Delivery goes through SendService → GatedMessageDelivery, the SAME
   * path as estimate/invoice sends, so consent/DNC gating and the
   * message_dispatches ledger apply identically. When every channel is
   * suppressed or fails, the just-minted session is revoked before the
   * error surfaces — a bearer credential nobody received must not stay
   * live.
   */
  router.post('/send', asyncRoute(async (req: Request, res: Response) => {
    const auth = (req as AuthenticatedRequest).auth!;
    if (!deps.sendService) {
      res.status(503).json({
        error: 'NOT_CONFIGURED',
        message: 'Message delivery is not configured for this environment',
      });
      return;
    }
    const parsed = sendSchema.parse(req.body ?? {});
    if (!(await validateMintTarget(res, auth.tenantId, parsed.customerId, parsed.contactId))) {
      return;
    }

    const auditContext = {
      actorRole: auth.role,
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    };
    const session = await createPortalSession(
      auth.tenantId,
      parsed.customerId,
      auth.userId,
      deps.portalRepo,
      parsed.ttlDays ?? DEFAULT_PORTAL_TTL_DAYS,
      deps.auditRepo,
      auditContext,
      { contactId: parsed.contactId },
    );
    const url = `${req.protocol}://${req.get('host')}/portal/${session.token}`;

    let result;
    try {
      result = await deps.sendService.sendPortalLink({
        tenantId: auth.tenantId,
        customerId: parsed.customerId,
        portalSessionId: session.id,
        portalUrl: url,
        expiresAt: session.expiresAt,
        channel: parsed.channel,
        recipientPhone: parsed.recipientPhone,
        recipientEmail: parsed.recipientEmail,
        customMessage: parsed.customMessage,
      });
    } catch (err) {
      // Nothing reached the customer on any channel (suppression or
      // transport failure — SendService already wrote the failed/suppressed
      // dispatch rows). Best-effort revoke, then let the original error
      // drive the response.
      await revokePortalSession(
        auth.tenantId,
        session.id,
        deps.portalRepo,
        deps.auditRepo,
        { actorId: auth.userId, ...auditContext },
      ).catch(() => {
        /* best-effort — never mask the send error */
      });
      throw err;
    }

    // D2-1d follow-through: distributing the credential is audited like
    // minting and revoking it. Raw token/URL is intentionally NOT written
    // to the audit row; the dispatch ledger holds recipients per channel.
    if (deps.auditRepo) {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: auth.tenantId,
          actorId: auth.userId,
          actorRole: auth.role,
          eventType: 'portal_session.link_sent',
          entityType: 'portal_session',
          entityId: session.id,
          metadata: {
            customerId: parsed.customerId,
            contactId: parsed.contactId,
            channels: result.channelsSent.map((c) => c.channel),
            dispatchIds: result.channelsSent.map((c) => c.dispatchId),
            expiresAt: session.expiresAt.toISOString(),
            ipAddress: auditContext.ipAddress,
            userAgent: auditContext.userAgent,
          },
        }),
      );
    }

    res.status(202).json({
      sessionId: session.id,
      customerId: parsed.customerId,
      contactId: parsed.contactId,
      url,
      expiresAt: session.expiresAt.toISOString(),
      channelsSent: result.channelsSent,
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
