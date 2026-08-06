import { Router, Request, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { toErrorResponse, ValidationError, NotFoundError } from '../shared/errors';
import { extractIp } from '../shared/extract-ip';
import { OAuthStateRepository } from '../integrations/calendar-integration';
import {
  GoogleBusinessOAuthConfig,
  GoogleFetch,
  buildGoogleBusinessAuthUrl,
  exchangeAuthorizationCode,
  listAccounts,
  listLocations,
} from '../reputation/google-business-client';
import {
  GoogleBusinessIntegrationRepository,
} from '../reputation/google-business-integration';
import { ReviewPollStateRepository } from '../reputation/poll-state';
import { AuditRepository, createAuditEvent } from '../audit/audit';

/**
 * Review-monitoring self-serve — per-tenant Google Business Profile
 * OAuth lifecycle. Mirrors routes/calendar-integrations.ts:
 *
 *   GET    /api/googlebusiness-integrations                    — tenant status
 *   POST   /api/googlebusiness-integrations/google/connect     — initiate OAuth
 *   GET    /api/googlebusiness-integrations/google/callback    — OAuth landing
 *   DELETE /api/googlebusiness-integrations/google             — disconnect
 *
 * The callback route is unauthenticated by design — Google redirects
 * the operator's browser there with no Clerk session in flight. The
 * one-time nonce in oauth_states binds the callback back to the
 * original (tenant, user).
 *
 * Unlike calendar (per-USER), this integration is per-TENANT: the
 * credentials land on `tenant_integrations (tenant_id,
 * provider='google_business')` — the exact row the reviews poll worker
 * and the reply resolver read (see
 * reputation/google-business-integration.ts for the pinned shape).
 *
 * oauth_states note: its provider CHECK is ('google','quickbooks',
 * 'xero'), so this flow stores provider='google' like calendar rather
 * than widening the constraint (no migration). A calendar-minted nonce
 * replayed against this callback fails closed anyway — the
 * authorization code is bound to THIS flow's redirect_uri, so the token
 * exchange is rejected by Google.
 */
export interface GoogleBusinessIntegrationsRouteDeps {
  integrationRepo: GoogleBusinessIntegrationRepository;
  stateRepo: OAuthStateRepository;
  googleConfig?: GoogleBusinessOAuthConfig | undefined;
  /** Stub-able for tests. */
  googleFetch?: GoogleFetch | undefined;
  /** Public web URL (Settings page) we send the operator back to. */
  appBaseUrl?: string | undefined;
  /** Audit events on connect / callback / disconnect (mirrors calendar). */
  auditRepo?: AuditRepository | undefined;
  /**
   * When wired, GET / includes the tenant's poll state
   * (lastSuccessfulPollAt / backoffUntil) so a broken-credentials
   * backoff degrades VISIBLY on the settings surface instead of
   * silently in worker logs.
   */
  pollStateRepo?: ReviewPollStateRepository | undefined;
}

/**
 * Same open-redirect guard as calendar-integrations.ts (PR 320 P2):
 * only same-origin relative paths may override the post-OAuth redirect.
 */
function isSafeRelativePath(value: string | undefined): value is string {
  if (!value) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (value.startsWith('/\\')) return false; // some browsers treat \ like /
  return true;
}

const trailingId = (resourceName: string): string | undefined => {
  const idx = resourceName.lastIndexOf('/');
  const tail = idx === -1 ? resourceName : resourceName.slice(idx + 1);
  return tail.length > 0 ? tail : undefined;
};

/**
 * Best-effort auto-discovery of the tenant's GBP account + location.
 * SMB tenants overwhelmingly have exactly one of each; we take the
 * first. A discovery hiccup must not fail the OAuth round-trip — the
 * tokens are still stored and the status endpoint shows the missing
 * location so the operator can retry the connect.
 */
async function discoverAccountLocation(
  accessToken: string,
  fetchFn: GoogleFetch,
): Promise<{ accountId?: string; locationId?: string }> {
  try {
    const accounts = await listAccounts(accessToken, fetchFn);
    const accountId = accounts.length > 0 ? trailingId(accounts[0]) : undefined;
    if (!accountId) return {};
    const locations = await listLocations(accessToken, accountId, fetchFn);
    const locationId =
      locations.length > 0 ? trailingId(locations[0]) : undefined;
    return {
      accountId,
      ...(locationId !== undefined ? { locationId } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Returns just the unauthenticated OAuth callback route. Mounted
 * BEFORE the global /api Clerk-session middleware (the inbound
 * redirect from Google has no session); the state nonce does the auth
 * binding instead. Mirrors createCalendarOAuthCallbackRouter.
 */
export function createGoogleBusinessOAuthCallbackRouter(
  deps: GoogleBusinessIntegrationsRouteDeps,
): Router {
  const router = Router();

  router.get('/google/callback', async (req: Request, res: Response) => {
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : undefined;
      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      const errorParam = typeof req.query.error === 'string' ? req.query.error : undefined;

      if (errorParam) {
        const back = `${deps.appBaseUrl ?? ''}/settings?googlebusiness_error=${encodeURIComponent(errorParam)}`;
        res.redirect(back);
        return;
      }
      if (!code || !state) {
        throw new ValidationError('Missing code or state parameter');
      }
      if (!deps.googleConfig) {
        throw new ValidationError('Google Business integration is not configured');
      }

      const consumed = await deps.stateRepo.consume(state);
      if (!consumed) {
        throw new ValidationError('Invalid or expired OAuth state');
      }

      const fetchFn = deps.googleFetch ?? fetch;
      const tokens = await exchangeAuthorizationCode(
        deps.googleConfig,
        code,
        fetchFn,
      );

      const { accountId, locationId } = await discoverAccountLocation(
        tokens.accessToken,
        fetchFn,
      );

      const upserted = await deps.integrationRepo.upsert({
        tenantId: consumed.tenantId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: tokens.expiresAt,
        ...(accountId !== undefined ? { accountId } : {}),
        ...(locationId !== undefined ? { locationId } : {}),
      });

      if (deps.auditRepo) {
        // No Clerk session on the callback — the actor falls back to
        // the documented `system:google-oauth-callback` sentinel; the
        // originating user is recorded in metadata (mirrors calendar).
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId: consumed.tenantId,
            actorId: 'system:google-oauth-callback',
            actorRole: 'system',
            eventType: 'googlebusiness_integration.callback_consumed',
            entityType: 'googlebusiness_integration',
            entityId: upserted.id,
            metadata: {
              provider: 'google_business',
              originatingUserId: consumed.userId,
              accountId: upserted.accountId,
              locationId: upserted.locationId,
              ipAddress: extractIp(req),
              userAgent: req.headers['user-agent'],
            },
          }),
        );
      }

      const back = isSafeRelativePath(consumed.redirectAfter)
        ? `${deps.appBaseUrl ?? ''}${consumed.redirectAfter}`
        : `${deps.appBaseUrl ?? ''}/settings?googlebusiness_connected=1`;
      res.redirect(back);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}

/**
 * The auth'd portion: status / connect / disconnect. Mounted AFTER the
 * global Clerk-session middleware.
 */
export function createGoogleBusinessIntegrationsRouter(
  deps: GoogleBusinessIntegrationsRouteDeps,
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const integration = await deps.integrationRepo.get(req.auth!.tenantId);
        if (!integration) {
          res.json({ data: null });
          return;
        }
        // Metadata only — token blobs never leave the repo layer. The
        // poll state rides along so a refresh-failure backoff is
        // visible on the settings surface.
        const pollState = deps.pollStateRepo
          ? await deps.pollStateRepo.getPollState(req.auth!.tenantId)
          : null;
        res.json({
          data: {
            id: integration.id,
            provider: 'google_business',
            status: integration.status,
            accountId: integration.accountId,
            locationId: integration.locationId,
            updatedAt: integration.updatedAt.toISOString(),
            lastSuccessfulPollAt:
              pollState?.lastSuccessfulPollAt?.toISOString() ?? null,
            backoffUntil: pollState?.backoffUntil?.toISOString() ?? null,
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
          throw new ValidationError('Google Business integration is not configured');
        }
        const rawRedirect =
          typeof req.body?.redirectAfter === 'string' ? req.body.redirectAfter : undefined;
        const redirectAfter = isSafeRelativePath(rawRedirect) ? rawRedirect : undefined;
        // provider 'google' — see the oauth_states note in the module
        // docblock (the CHECK constraint doesn't include
        // 'google_business'; the redirect_uri binding disambiguates).
        const { id: stateId } = await deps.stateRepo.create({
          tenantId: req.auth!.tenantId,
          userId: req.auth!.userId,
          provider: 'google',
          ...(redirectAfter !== undefined ? { redirectAfter } : {}),
        });
        const url = buildGoogleBusinessAuthUrl(deps.googleConfig, stateId);

        if (deps.auditRepo) {
          // Operator opted into the OAuth flow. Entity id is the
          // oauth_state nonce so callback_consumed can be correlated.
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId: req.auth!.tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'googlebusiness_integration.connected',
              entityType: 'oauth_state',
              entityId: stateId,
              metadata: {
                provider: 'google_business',
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
        const ok = await deps.integrationRepo.disconnect(req.auth!.tenantId);
        if (!ok) {
          throw new NotFoundError('Google Business integration', 'google_business');
        }

        if (deps.auditRepo) {
          // Credential-invalidation event. disconnect() deletes the
          // tenant_integrations row (so the poll worker skips the
          // tenant silently); this audit row is the durable record.
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId: req.auth!.tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'googlebusiness_integration.disconnected',
              entityType: 'googlebusiness_integration',
              entityId: `${req.auth!.tenantId}:google_business`,
              metadata: {
                provider: 'google_business',
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

  return router;
}
