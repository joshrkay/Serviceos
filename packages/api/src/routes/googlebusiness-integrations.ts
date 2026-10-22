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
  exchangeAuthorizationCode,
  listAccounts,
  listLocationDetails,
  GoogleLocationDetail,
} from '../reputation/google-business-client';
import {
  GoogleBusinessIntegrationRepository,
  callWithGoogleBusinessAuthRetry,
} from '../reputation/google-business-integration';
import type { SettingsRepository } from '../settings/settings';
import { ReviewPollStateRepository } from '../reputation/poll-state';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { z } from 'zod';

/**
 * Review-monitoring self-serve — per-tenant Google Business Profile
 * OAuth lifecycle. Mirrors routes/calendar-integrations.ts:
 *
 *   GET    /api/googlebusiness-integrations                    — tenant status
 *   POST   /api/googlebusiness-integrations/google/connect     — initiate OAuth
 *   GET    /api/googlebusiness-integrations/google/callback    — OAuth landing
 *   GET    /api/googlebusiness-integrations/google/locations   — live location list (picker)
 *   PUT    /api/googlebusiness-integrations/google/location    — choose / switch location
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
   * When wired, choosing a location fills `googleReviewUrl` from the
   * listing — only when the setting is empty or still holds the link
   * we auto-filled for the previous location. A hand-entered link is
   * never overwritten.
   */
  settingsRepo?: SettingsRepository | undefined;
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

const pickLocationBodySchema = z.object({ locationId: z.string().min(1) });

type LocationDiscovery =
  | { kind: 'none'; accountId?: string }
  | { kind: 'single'; accountId: string; location: GoogleLocationDetail }
  | { kind: 'many'; accountId: string };

/**
 * Best-effort discovery of the tenant's GBP account + locations. We
 * use the first account (SMB tenants have one). With exactly one
 * location it is connected directly; with several the owner picks
 * (`many`); with none the integration lands in an explicit
 * `no_location` state. A discovery hiccup must not fail the OAuth
 * round-trip — the tokens are still stored and the status endpoint
 * shows `no_location`, so the operator can reconnect.
 */
async function discoverLocations(
  accessToken: string,
  fetchFn: GoogleFetch,
): Promise<LocationDiscovery> {
  try {
    const accounts = await listAccounts(accessToken, fetchFn);
    const accountId = accounts.length > 0 ? trailingId(accounts[0]) : undefined;
    if (!accountId) return { kind: 'none' };
    const locations = await listLocationDetails(accessToken, accountId, fetchFn);
    if (locations.length === 0) return { kind: 'none', accountId };
    if (locations.length === 1) {
      return { kind: 'single', accountId, location: locations[0] };
    }
    return { kind: 'many', accountId };
  } catch {
    return { kind: 'none' };
  }
}

function trailingId(resourceName: string): string | undefined {
  const idx = resourceName.lastIndexOf('/');
  const tail = idx === -1 ? resourceName : resourceName.slice(idx + 1);
  return tail.length > 0 ? tail : undefined;
}

/**
 * Fill the tenant's Google review link from the listing. Skips when
 * the setting holds something other than the link we auto-filled for
 * the previous location (`previousAutoUrl`) — i.e. a hand-entered
 * value always wins. Returns whether the setting was written.
 */
async function fillReviewUrl(
  settingsRepo: SettingsRepository | undefined,
  tenantId: string,
  reviewUrl: string | null,
  previousAutoUrl: string | null,
): Promise<boolean> {
  if (!settingsRepo || !reviewUrl) return false;
  const settings = await settingsRepo.findByTenant(tenantId);
  if (!settings) return false;
  const current = settings.googleReviewUrl?.trim() ?? '';
  if (current === reviewUrl) return false;
  if (current !== '' && current !== previousAutoUrl) return false;
  await settingsRepo.update(tenantId, { googleReviewUrl: reviewUrl });
  return true;
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

      const discovery = await discoverLocations(tokens.accessToken, fetchFn);
      const location = discovery.kind === 'single' ? discovery.location : undefined;

      const previous = await deps.integrationRepo.get(consumed.tenantId);
      const upserted = await deps.integrationRepo.upsert({
        tenantId: consumed.tenantId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: tokens.expiresAt,
        ...(discovery.accountId !== undefined ? { accountId: discovery.accountId } : {}),
        ...(location
          ? {
              locationId: location.locationId,
              locationTitle: location.title,
              placeId: location.placeId,
              reviewUrl: location.reviewUrl,
            }
          : {}),
        needsSelection: discovery.kind === 'many',
      });
      const reviewUrlFilled = await fillReviewUrl(
        deps.settingsRepo,
        consumed.tenantId,
        upserted.reviewUrl,
        previous?.reviewUrl ?? null,
      );

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
              locationStatus: upserted.locationStatus,
              reviewUrlFilled,
              ipAddress: extractIp(req),
              userAgent: req.headers['user-agent'],
            },
          }),
        );
      }

      // A multi-location account lands on Settings (where the picker
      // lives) regardless of where the connect started.
      const back =
        upserted.locationStatus !== 'needs_selection' &&
        isSafeRelativePath(consumed.redirectAfter)
          ? `${deps.appBaseUrl ?? ''}${consumed.redirectAfter}`
          : `${deps.appBaseUrl ?? ''}/settings?googlebusiness_connected=1${
              upserted.locationStatus === 'needs_selection' ? '&googlebusiness_pick=1' : ''
            }`;
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
            locationTitle: integration.locationTitle,
            placeId: integration.placeId,
            reviewUrl: integration.reviewUrl,
            locationStatus: integration.locationStatus,
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

  /** Live location list for the picker — never cached, never stored. */
  async function listLiveLocations(
    tenantId: string,
  ): Promise<{ accountId: string; locations: GoogleLocationDetail[] }> {
    const auth = await deps.integrationRepo.getAuth(tenantId);
    if (!auth) throw new NotFoundError('Google Business integration', 'google_business');
    const fetchFn = deps.googleFetch ?? boundedGoogleFetch;
    return callWithGoogleBusinessAuthRetry({
      tenantId,
      tokens: auth.tokens,
      config: deps.googleConfig,
      store: deps.integrationRepo,
      fetchFn,
      call: async (accessToken) => {
        const accountId =
          auth.accountId ?? trailingId((await listAccounts(accessToken, fetchFn))[0] ?? '');
        if (!accountId) return { accountId: '', locations: [] };
        return {
          accountId,
          locations: await listLocationDetails(accessToken, accountId, fetchFn),
        };
      },
    });
  }

  router.get(
    '/google/locations',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { locations } = await listLiveLocations(req.auth!.tenantId);
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
        const parsed = pickLocationBodySchema.safeParse(req.body);
        if (!parsed.success) throw new ValidationError('locationId is required');
        const tenantId = req.auth!.tenantId;
        const previous = await deps.integrationRepo.get(tenantId);
        if (!previous) throw new NotFoundError('Google Business integration', 'google_business');

        // Validate against Google's live list: the owner can only pick a
        // location their own account actually has.
        const { accountId, locations } = await listLiveLocations(tenantId);
        const chosen = locations.find((l) => l.locationId === parsed.data.locationId);
        if (!chosen || !accountId) {
          throw new ValidationError('That location is not on the connected Google account');
        }

        const updated = await deps.integrationRepo.setLocation(tenantId, {
          accountId,
          locationId: chosen.locationId,
          locationTitle: chosen.title,
          placeId: chosen.placeId,
          reviewUrl: chosen.reviewUrl,
        });
        if (!updated) throw new NotFoundError('Google Business integration', 'google_business');
        const reviewUrlFilled = await fillReviewUrl(
          deps.settingsRepo,
          tenantId,
          updated.reviewUrl,
          previous.reviewUrl,
        );

        if (deps.auditRepo) {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'googlebusiness_integration.location_changed',
              entityType: 'googlebusiness_integration',
              entityId: updated.id,
              metadata: {
                provider: 'google_business',
                previousLocationId: previous.locationId,
                locationId: updated.locationId,
                reviewUrlFilled,
                ipAddress: extractIp(req),
                userAgent: req.headers['user-agent'],
              },
            }),
          );
        }

        res.json({
          data: {
            locationId: updated.locationId,
            locationTitle: updated.locationTitle,
            placeId: updated.placeId,
            reviewUrl: updated.reviewUrl,
            locationStatus: updated.locationStatus,
          },
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
