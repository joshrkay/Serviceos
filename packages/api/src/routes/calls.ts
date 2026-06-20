import express, { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { requireTwilioSignature } from '../telephony/twilio-signature';
import {
  initiateOutboundCall,
  OutboundCallError,
  buildBridgeTwiml,
  buildHangupTwiml,
  resolveBridgeTarget,
  type OutboundCallDeps,
  type OutboundCallErrorCode,
} from '../telephony/outbound-call-service';

const callBodySchema = z.object({
  customerId: z.string().min(1),
  // Owner's callback number (device-stored); digits/+/spaces, 7–20 chars.
  agentPhone: z.string().min(7).max(20),
});

/** Map an outbound-call failure to an HTTP status the mobile UI can act on. */
const CALL_ERROR_STATUS: Record<OutboundCallErrorCode, number> = {
  not_found: 404,
  no_recipient: 422,
  dnc_blocked: 403,
  not_configured: 503,
  provider_failed: 502,
};

export interface CallsRouterDeps {
  /** Present only when telephony is configured; absent ⇒ POST / returns 503. */
  callDeps?: OutboundCallDeps;
}

export interface CallBridgeRouterDeps {
  callDeps?: OutboundCallDeps;
  /** Per-request Twilio auth token (by AccountSid) for bridge signature checks. */
  twilioAuthTokenGetter: (opts: {
    accountSid?: string;
  }) => Promise<string | undefined> | string | undefined;
  publicBaseUrl?: string;
}

/**
 * Owner→customer click-to-call (authed). `POST /api/calls` starts a bridged
 * call. Mount AFTER the global `/api` auth chain. The Twilio `/bridge` callback
 * lives in {@link createCallBridgeRouter}, mounted before auth.
 */
export function createCallsRouter(deps: CallsRouterDeps): Router {
  const router = Router();

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('conversations:manage'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      if (!deps.callDeps) {
        res.status(503).json({ error: 'UNAVAILABLE', message: 'Calling is not configured' });
        return;
      }
      const parsed = callBodySchema.parse(req.body);
      try {
        const result = await initiateOutboundCall(deps.callDeps, {
          tenantId: req.auth!.tenantId,
          customerId: parsed.customerId,
          agentPhone: parsed.agentPhone,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
        });
        res.status(201).json(result);
      } catch (err) {
        if (err instanceof OutboundCallError) {
          res
            .status(CALL_ERROR_STATUS[err.code] ?? 500)
            .json({ error: err.code.toUpperCase(), message: err.message });
          return;
        }
        throw err;
      }
    }),
  );

  return router;
}

/**
 * Twilio bridge callback (unauthenticated, signature-verified). Returns the
 * <Dial> TwiML that connects the owner to the customer once the owner answers.
 * MUST be mounted BEFORE the global `/api` Clerk-auth chain (like the inbound
 * telephony webhooks) — Twilio carries no Clerk JWT, so otherwise requireAuth
 * rejects it before requireTwilioSignature runs and the call never connects.
 * Non-matching paths (e.g. the authed `POST /`) fall through to the next router.
 */
export function createCallBridgeRouter(deps: CallBridgeRouterDeps): Router {
  const router = Router();

  router.post(
    '/bridge',
    express.urlencoded({ extended: false }),
    requireTwilioSignature(deps.twilioAuthTokenGetter, {
      publicBaseUrl: deps.publicBaseUrl ?? process.env.PUBLIC_API_URL,
    }),
    asyncRoute(async (req, res: Response) => {
      res.type('text/xml');
      const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : '';
      const conversationId =
        typeof req.query.conversationId === 'string' ? req.query.conversationId : '';
      const messageId = typeof req.query.messageId === 'string' ? req.query.messageId : '';
      if (!deps.callDeps || !tenantId || !conversationId || !messageId) {
        res.status(200).send(buildHangupTwiml());
        return;
      }
      const messages = await deps.callDeps.conversationRepo.getMessages(tenantId, conversationId);
      const resolved = resolveBridgeTarget(messages, messageId);
      if (!resolved) {
        res.status(200).send(buildHangupTwiml());
        return;
      }
      // JSONB-merge just the status; the repo preserves the rest of the metadata.
      await deps.callDeps.conversationRepo
        .updateMessageMetadata(tenantId, messageId, { status: 'bridged' })
        .catch(() => undefined);
      res.status(200).send(buildBridgeTwiml(resolved));
    }),
  );

  return router;
}
