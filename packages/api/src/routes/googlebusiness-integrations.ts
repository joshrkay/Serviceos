import { Router, Request, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse, ValidationError, NotFoundError } from '../shared/errors';
import { extractIp } from '../shared/extract-ip';
import { OAuthStateRepository } from '../integrations/calendar-integration';
import {
  GoogleBusinessOAuthConfig,
  GoogleFetch,
  boundedGoogleFetch,
  buildGoogleBusinessAuthUrl,
  GoogleBusinessAuthError,
  GoogleBusinessLocation,
  discoverLocations,
  exchangeAuthorizationCode,
} from '../reputation/google-business-client';
import {
  GoogleBusinessIntegrationRepository,
  GoogleBusinessIntegrationSummary,
  GoogleBusinessLocationSelection,
  callWithGoogleBusinessAuthRetry,
  googleBusinessLocationState,
} from '../reputation/google-business-integration';
import { applyDerivedGoogleReviewUrl } from '../reputation/google-review-link';
import type { SettingsRepository } from '../settings/settings';
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
 *   GET    /api/googlebusiness-integrations/google/locations   — location picker
 *   PUT    /api/googlebusiness-integrations/google/location    — choose a location
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
 * oauth_states note: this flow mints and consumes provider
 * 'google_business' (migration 308). Calendar and Google Business share
 * one Google OAuth client, and the caller controls the redirect_uri and
 * scope in the consent URL, so the redirect_uri binding does NOT keep a
 * calendar-minted nonce (any member can mint one) out of this owner-only
 * callback — the provider check in consume() does.
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
  /**
   * D-044 — when wired, connecting a location fills the tenant's Google
   * review link from the listing (never over a link the owner typed).
   */
  settingsRepo?: Pick<SettingsRepository, 'findByTenant' | 'update'> | undefined;
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

function toSelection(location: GoogleBusinessLocation): GoogleBusinessLocationSelection {
  return {
    accountId: location.accountId,
    locationId: location.locationId,
    placeId: location.placeId,
    reviewUrl: location.reviewUrl,
    locationTitle: location.title,
  };
}

/**
 * Fill the review link from the chosen listing. Best-effort on the OAuth
 * callback (the tokens are already stored and the owner can still pick or
 * paste a link); the outcome is recorded on the audit event either way.
 */
async function fillReviewUrl(
  deps: GoogleBusinessIntegrationsRouteDeps,
  tenantId: string,
  previousDerived: string | null,
  derived: string | null,
): Promise<{ reviewUrlFilled: boolean; reviewUrlError?: string }> {
  if (!deps.settingsRepo) return { reviewUrlFilled: false };
  try {
    return {
      reviewUrlFilled: await applyDerivedGoogleReviewUrl(
        deps.settingsRepo,
        tenantId,
        previousDerived,
        derived,
      ),
    };
  } catch (err) {
    return {
      reviewUrlFilled: false,
      reviewUrlError: err instanceof Error ? err.message : String(err),
    };
  }
}

function statusView(
  integration: GoogleBusinessIntegrationSummary,
  pollState: { lastSuccessfulPollAt?: Date | null; backoffUntil?: Date | null } | null,
) {
  return {
    id: integration.id,
    provider: 'google_business' as const,
    status: integration.status,
    accountId: integration.accountId,
    locationId: integration.locationId,
    locationTitle: integration.locationTitle,
    placeId: integration.placeId,
    reviewUrl: integration.reviewUrl,
    locationState: googleBusinessLocationState(integration),
    updatedAt: integration.updatedAt.toISOString(),
    lastSuccessfulPollAt: pollState?.lastSuccessfulPollAt?.toISOString() ?? null,
    backoffUntil: pollState?.backoffUntil?.toISOString() ?? null,
  };
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

      const consumed = await deps.stateRepo.consume(state, 'google_business');
      if (!consumed) {
        throw new ValidationError('Invalid or expired OAuth state');
      }

      const fetchFn = deps.googleFetch ?? boundedGoogleFetch;
      const tokens = await exchangeAuthorizationCode(
        deps.googleConfig,
        code,
        fetchFn,
      );

      // Discovery hiccups must not fail the round-trip: the tokens are
      // stored with no location and the owner picks one from Settings
      // (GET /google/locations retries discovery).
      let locations: GoogleBusinessLocation[] | null;
      try {
        locations = await discoverLocations(tokens.accessToken, fetchFn);
      } catch {
        locations = null;
      }
      // A reconnect keeps the location the owner already chose; otherwise
      // a single location is chosen for them, and several wait for a pick.
      const previous = await deps.integrationRepo.get(consumed.tenantId);
      const kept = previous?.locationId
        ? locations?.find(
            (l) =>
              l.locationId === previous.locationId &&
              l.accountId === previous.accountId,
          )
        : undefined;
      const chosen = kept ?? (locations?.length === 1 ? locations[0] : undefined);

      const upserted = await deps.integrationRepo.upsert({
        tenantId: consumed.tenantId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: tokens.expiresAt,
        ...(chosen ? { selection: toSelection(chosen) } : {}),
        ...(locations ? { locationCount: locations.length } : {}),
      });

      const reviewUrl = chosen
        ? await fillReviewUrl(
            deps,
            consumed.tenantId,
            previous?.reviewUrl ?? null,
            chosen.reviewUrl,
          )
        : { reviewUrlFilled: false };

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
              locationCount: locations?.length ?? null,
              ...reviewUrl,
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
        res.json({ data: statusView(integration, pollState) });
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
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.googleConfig) {
          throw new ValidationError('Google Business integration is not configured');
        }
        const rawRedirect =
          typeof req.body?.redirectAfter === 'string' ? req.body.redirectAfter : undefined;
        const redirectAfter = isSafeRelativePath(rawRedirect) ? rawRedirect : undefined;
        // See the oauth_states note in the module docblock.
        const { id: stateId } = await deps.stateRepo.create({
          tenantId: req.auth!.tenantId,
          userId: req.auth!.userId,
          provider: 'google_business',
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

  /** Discovery with the stored tokens (refresh-on-401, retry once). */
  async function discoverForTenant(tenantId: string): Promise<GoogleBusinessLocation[]> {
    const tokens = await deps.integrationRepo.getTokens(tenantId);
    if (!tokens) {
      throw new NotFoundError('Google Business integration', 'google_business');
    }
    const fetchFn = deps.googleFetch ?? boundedGoogleFetch;
    try {
      return await callWithGoogleBusinessAuthRetry({
        tenantId,
        tokens,
        config: deps.googleConfig,
        store: deps.integrationRepo,
        fetchFn,
        call: (accessToken) => discoverLocations(accessToken, fetchFn),
      });
    } catch (err) {
      if (err instanceof GoogleBusinessAuthError) {
        throw new ValidationError(
          'Google no longer accepts this connection. Reconnect Google Business.',
        );
      }
      throw err;
    }
  }

  router.get(
    '/google/locations',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const locations = await discoverForTenant(req.auth!.tenantId);
        res.json({ data: locations });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.put(
    '/google/location',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const accountId = req.body?.accountId;
        const locationId = req.body?.locationId;
        if (
          typeof accountId !== 'string' ||
          accountId.length === 0 ||
          typeof locationId !== 'string' ||
          locationId.length === 0
        ) {
          throw new ValidationError('accountId and locationId are required');
        }
        // Only a location Google says this connection can see is accepted.
        const locations = await discoverForTenant(tenantId);
        const location = locations.find(
          (l) => l.accountId === accountId && l.locationId === locationId,
        );
        if (!location) {
          throw new ValidationError('That location is not on your Google account');
        }
        const previous = await deps.integrationRepo.get(tenantId);
        const updated = await deps.integrationRepo.selectLocation(
          tenantId,
          toSelection(location),
        );
        if (!updated) {
          throw new NotFoundError('Google Business integration', 'google_business');
        }
        const reviewUrl = await fillReviewUrl(
          deps,
          tenantId,
          previous?.reviewUrl ?? null,
          location.reviewUrl,
        );
        if (deps.auditRepo) {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'googlebusiness_integration.location_selected',
              entityType: 'googlebusiness_integration',
              entityId: updated.id,
              metadata: {
                provider: 'google_business',
                accountId,
                locationId,
                previousLocationId: previous?.locationId ?? null,
                ...reviewUrl,
                ipAddress: extractIp(req),
                userAgent: req.headers['user-agent'],
              },
            }),
          );
        }

        // The location is saved either way; a review-link write that failed
        // is reported, not swallowed.
        if (reviewUrl.reviewUrlError) {
          throw new Error(
            `Location saved, but the review link could not be updated: ${reviewUrl.reviewUrlError}`,
          );
        }

        const pollState = deps.pollStateRepo
          ? await deps.pollStateRepo.getPollState(tenantId)
          : null;
        res.json({
          data: statusView(updated, pollState),
          reviewUrlFilled: reviewUrl.reviewUrlFilled,
        });
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
    requirePermission('settings:update'),
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
