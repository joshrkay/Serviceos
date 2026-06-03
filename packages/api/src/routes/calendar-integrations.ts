import { Router, Request, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { toErrorResponse, ValidationError, NotFoundError } from '../shared/errors';
import { extractIp } from '../shared/extract-ip';
import {
  CalendarIntegrationRepository,
  OAuthStateRepository,
} from '../integrations/calendar-integration';
import {
  GoogleOAuthConfig,
  GoogleFetch,
  buildGoogleAuthUrl,
  exchangeAuthorizationCode,
} from '../integrations/google-calendar';
import { CalendarSyncService } from '../integrations/calendar-sync';
import { AuditRepository, createAuditEvent } from '../audit/audit';

/**
 * Tier 4 (Calendar sync — PR 1). Per-user Google Calendar OAuth
 * lifecycle:
 *
 *   GET    /api/calendar-integrations             — current user's status
 *   POST   /api/calendar-integrations/google/connect   — initiate OAuth
 *   GET    /api/calendar-integrations/google/callback  — OAuth landing
 *   DELETE /api/calendar-integrations/google           — disconnect
 *
 * The callback route is unauthenticated by design — Google redirects
 * the user's browser there, no Clerk session is in flight. State
 * binds the callback back to the original (tenant, user) via the
 * one-time nonce stored in oauth_states.
 */
export interface CalendarIntegrationsRouteDeps {
  integrationRepo: CalendarIntegrationRepository;
  stateRepo: OAuthStateRepository;
  googleConfig?: GoogleOAuthConfig;
  /** Stub-able for tests. */
  googleFetch?: GoogleFetch;
  /** Public web URL (Settings page) we send the operator back to
   *  after a successful disconnect/reconnect. */
  appBaseUrl?: string;
  /**
   * Tier 4 (Calendar sync — PR 2). When wired, the auth'd router
   * exposes POST /google/test-push so the operator can verify their
   * connection by pushing a synthetic event to their primary
   * calendar. Optional so legacy harnesses still build the router.
   */
  syncService?: CalendarSyncService;
  /**
   * D2-1d — audit logging for the calendar OAuth lifecycle
   * (connect intent, callback consume, disconnect). Optional so older
   * harnesses still build.
   */
  auditRepo?: AuditRepository;
}

/**
 * PR 320 review (P2 — Codex). The OAuth callback redirects back to
 * `consumed.redirectAfter`, which originated as user-controlled
 * input on POST /google/connect. Without validation that's a classic
 * open-redirect from a trusted domain — useful for phishing.
 *
 * Allow only relative paths (must start with `/` and NOT with `//`,
 * which is a protocol-relative URL that browsers treat as absolute
 * to a foreign host). Anything else falls through to the default
 * `/settings?calendar_connected=1` target.
 */
function isSafeRelativePath(value: string | undefined): value is string {
  if (!value) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (value.startsWith('/\\')) return false; // some browsers treat \ like /
  return true;
}

/**
 * Returns just the unauthenticated OAuth callback route. Mounted
 * BEFORE the global /api Clerk-session middleware so the inbound
 * redirect from Google isn't rejected for lack of a session. The
 * state nonce stored in oauth_states does the auth binding instead.
 */
export function createCalendarOAuthCallbackRouter(
  deps: CalendarIntegrationsRouteDeps,
): Router {
  const router = Router();

  router.get('/google/callback', async (req: Request, res: Response) => {
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : undefined;
      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      const errorParam = typeof req.query.error === 'string' ? req.query.error : undefined;

      if (errorParam) {
        const back = `${deps.appBaseUrl ?? ''}/settings?calendar_error=${encodeURIComponent(errorParam)}`;
        res.redirect(back);
        return;
      }
      if (!code || !state) {
        throw new ValidationError('Missing code or state parameter');
      }
      if (!deps.googleConfig) {
        throw new ValidationError('Google calendar integration is not configured');
      }

      const consumed = await deps.stateRepo.consume(state);
      if (!consumed) {
        throw new ValidationError('Invalid or expired OAuth state');
      }

      const tokens = await exchangeAuthorizationCode(
        deps.googleConfig,
        code,
        deps.googleFetch ?? fetch,
      );

      const upserted = await deps.integrationRepo.upsert({
        tenantId: consumed.tenantId,
        userId: consumed.userId,
        provider: 'google',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: tokens.expiresAt,
        externalAccountEmail: tokens.email,
      });

      if (deps.auditRepo) {
        // D2-1d — the callback has no Clerk session, so the actor falls
        // back to the documented `system:google-oauth-callback` sentinel.
        // The originating user is recorded in metadata so ops can still
        // attribute the connection back to the tenant operator.
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId: consumed.tenantId,
            actorId: `system:google-oauth-callback`,
            actorRole: 'system',
            eventType: 'calendar_integration.callback_consumed',
            entityType: 'calendar_integration',
            entityId: upserted.id,
            metadata: {
              provider: 'google',
              originatingUserId: consumed.userId,
              externalAccountEmail: upserted.externalAccountEmail,
              ipAddress: extractIp(req),
              userAgent: req.headers['user-agent'],
            },
          }),
        );
      }

      // Default redirect to Settings; honor a custom redirectAfter
      // ONLY when it's a same-origin relative path. See
      // isSafeRelativePath above for the open-redirect rationale.
      const back = isSafeRelativePath(consumed.redirectAfter)
        ? `${deps.appBaseUrl ?? ''}${consumed.redirectAfter}`
        : `${deps.appBaseUrl ?? ''}/settings?calendar_connected=1`;
      res.redirect(back);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}

/**
 * The auth'd portion: list / connect / disconnect. Mounted AFTER
 * the global Clerk-session middleware. The OAuth callback lives in
 * the sibling router above because it can't require a Clerk session.
 */
export function createCalendarIntegrationsRouter(
  deps: CalendarIntegrationsRouteDeps,
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const integration = await deps.integrationRepo.findByUser(
          req.auth!.tenantId,
          req.auth!.userId,
          'google',
        );
        if (!integration) {
          res.json({ data: null });
          return;
        }
        // Strip the encrypted token blobs from the public shape — the
        // UI only needs metadata (status, email, calendar id, dates).
        res.json({
          data: {
            id: integration.id,
            provider: integration.provider,
            status: integration.status,
            externalAccountEmail: integration.externalAccountEmail,
            calendarId: integration.calendarId,
            createdAt: integration.createdAt.toISOString(),
            updatedAt: integration.updatedAt.toISOString(),
          },
        });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.post(
    '/google/connect',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.googleConfig) {
          throw new ValidationError('Google calendar integration is not configured');
        }
        // PR 320 review (P2). Reject obviously-bogus redirectAfter
        // values at intake — defense-in-depth alongside the callback
        // validator. Users can still pass relative same-origin paths
        // like "/settings/calendar".
        const rawRedirect =
          typeof req.body?.redirectAfter === 'string' ? req.body.redirectAfter : undefined;
        const redirectAfter = isSafeRelativePath(rawRedirect) ? rawRedirect : undefined;
        const { id: stateId } = await deps.stateRepo.create({
          tenantId: req.auth!.tenantId,
          userId: req.auth!.userId,
          provider: 'google',
          redirectAfter,
        });
        const url = buildGoogleAuthUrl(deps.googleConfig, stateId);

        if (deps.auditRepo) {
          // D2-1d — operator opted into the OAuth flow. The actor is
          // the Clerk-authenticated user; the row's entity id is the
          // oauth_state nonce so callback_consumed can be correlated.
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId: req.auth!.tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'calendar_integration.connected',
              entityType: 'oauth_state',
              entityId: stateId,
              metadata: {
                provider: 'google',
                redirectAfter,
                ipAddress: extractIp(req),
                userAgent: req.headers['user-agent'],
              },
            }),
          );
        }

        res.json({ url });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.delete(
    '/google',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const ok = await deps.integrationRepo.revoke(
          req.auth!.tenantId,
          req.auth!.userId,
          'google',
        );
        if (!ok) {
          throw new NotFoundError('Calendar integration', 'google');
        }

        if (deps.auditRepo) {
          // D2-1d — disconnect is a credential-invalidation event. The
          // entity id falls back to the (tenant,user,provider) tuple
          // because revoke() returns only a boolean.
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId: req.auth!.tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'calendar_integration.disconnected',
              entityType: 'calendar_integration',
              entityId: `${req.auth!.tenantId}:${req.auth!.userId}:google`,
              metadata: {
                provider: 'google',
                ipAddress: extractIp(req),
                userAgent: req.headers['user-agent'],
              },
            }),
          );
        }

        res.json({ revoked: true });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  /**
   * Tier 4 (Calendar sync — PR 2). Pushes a synthetic event 1 hour
   * from now into the calling user's connected Google Calendar so
   * the operator can verify their integration. Returns the sync
   * outcome ('synced' / 'skipped' / 'failed') without throwing on
   * sync failure — the result.failed flag carries the signal.
   */
  router.post(
    '/google/test-push',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.syncService) {
          throw new ValidationError('Calendar sync is not configured');
        }
        const start = new Date(Date.now() + 60 * 60 * 1000);
        const end = new Date(start.getTime() + 30 * 60 * 1000);
        // PR 320 review (P1 — Codex). The synthetic appointmentId
        // doesn't reference a real `appointments` row, so the
        // appointment_calendar_events FK + UUID type check would
        // reject the persist in Pg. Skip persistence — test-push is
        // a one-shot verification, not appointment lifecycle tracking.
        const outcome = await deps.syncService.pushForTechnician(
          {
            tenantId: req.auth!.tenantId,
            appointmentId: `test-push-${Date.now()}`,
            technicianUserId: req.auth!.userId,
            scheduledStart: start,
            scheduledEnd: end,
            timezone: 'UTC',
            summary: 'Fieldly test event',
            description:
              'This is a test event from Fieldly confirming your calendar is connected.',
          },
          { persist: false },
        );
        res.json({ outcome });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
