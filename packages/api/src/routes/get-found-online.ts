import { Router, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import {
  isCallForwardingCarrier,
  isCallForwardingMode,
  DEFAULT_CALL_FORWARDING_MODE,
} from '@ai-service-os/shared';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse, ValidationError, NotFoundError } from '../shared/errors';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  GoogleBusinessIntegrationRepository,
  googleBusinessLocationState,
} from '../reputation/google-business-integration';
import { ReviewPollStateRepository } from '../reputation/poll-state';
import type { SettingsRepository } from '../settings/settings';
import {
  GetFoundOnlineChecklist,
  GetFoundOnlineFacts,
  deriveGetFoundOnlineChecklist,
} from '../onboarding/get-found-online';
import { GetFoundOnlineDismissalRepository } from '../onboarding/get-found-online-dismissal';
import type { CallForwardingRepository } from '../onboarding/call-forwarding';
import type { ForwardingCheckService } from '../onboarding/forwarding-check';
import { createRateLimitStore } from '../middleware/rate-limit-store';

/**
 * D-044 / #1763 — the owner's "Get found online" home checklist.
 *
 *   GET  /api/get-found-online          — the derived checklist
 *   POST /api/get-found-online/dismiss  — hide it once every item is done
 *   GET  /api/get-found-online/forwarding — carrier + mode + the Rivet number (#1765)
 *   PUT  /api/get-found-online/forwarding — save carrier + mode
 *   POST /api/get-found-online/forwarding/check — place the test call (#1766)
 *   GET  /api/get-found-online/forwarding/check — the latest check's state
 *
 * Owner-only (settings:update): dispatchers and technicians get a 403 and
 * the home card renders nothing for them.
 */
export interface GetFoundOnlineRouteDeps {
  integrationRepo: Pick<GoogleBusinessIntegrationRepository, 'get'>;
  pollStateRepo?: Pick<ReviewPollStateRepository, 'getPollState'> | undefined;
  settingsRepo: Pick<SettingsRepository, 'findByTenant'>;
  dismissalRepo: GetFoundOnlineDismissalRepository;
  forwardingRepo: CallForwardingRepository;
  /** The forwarding check (#1766); absent ⇒ the check endpoints answer 503. */
  forwardingCheck?: Pick<ForwardingCheckService, 'start' | 'latestView'>;
  /** The tenant's Rivet number (E.164), or null when no line is active. */
  getRivetNumber?: (tenantId: string) => Promise<string | null>;
  auditRepo?: AuditRepository | undefined;
  now?: () => Date;
}

export async function loadGetFoundOnlineFacts(
  deps: GetFoundOnlineRouteDeps,
  tenantId: string,
  now: Date,
): Promise<GetFoundOnlineFacts> {
  const [integration, pollState, settings, dismissedAt, forwarding] = await Promise.all([
    deps.integrationRepo.get(tenantId),
    deps.pollStateRepo ? deps.pollStateRepo.getPollState(tenantId) : null,
    deps.settingsRepo.findByTenant(tenantId),
    deps.dismissalRepo.getDismissedAt(tenantId),
    deps.forwardingRepo.get(tenantId),
  ]);
  return {
    google: integration
      ? {
          locationState: googleBusinessLocationState(integration),
          // Only rejected credentials need the owner: Google throttling
          // clears on its own, and a backoff recorded before the reason
          // existed may be either, so it doesn't ask for a reconnect.
          pollingPaused:
            pollState?.backoffReason === 'auth' &&
            !!pollState.backoffUntil &&
            pollState.backoffUntil.getTime() > now.getTime(),
        }
      : null,
    googleReviewUrl: settings?.googleReviewUrl ?? null,
    callForwarding: forwarding,
    dismissedAt,
  };
}

export function createGetFoundOnlineRouter(deps: GetFoundOnlineRouteDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  async function checklistFor(tenantId: string): Promise<GetFoundOnlineChecklist> {
    return deriveGetFoundOnlineChecklist(await loadGetFoundOnlineFacts(deps, tenantId, now()));
  }

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        res.json({ data: await checklistFor(req.auth!.tenantId) });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  async function forwardingView(tenantId: string) {
    const [setup, rivetNumber] = await Promise.all([
      deps.forwardingRepo.get(tenantId),
      deps.getRivetNumber ? deps.getRivetNumber(tenantId).catch(() => null) : null,
    ]);
    return {
      carrier: setup?.carrier ?? null,
      mode: setup?.mode ?? DEFAULT_CALL_FORWARDING_MODE,
      checkPassedAt: setup?.checkPassedAt?.toISOString() ?? null,
      rivetNumber,
    };
  }

  router.get(
    '/forwarding',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        res.json({ data: await forwardingView(req.auth!.tenantId) });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.put(
    '/forwarding',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const { carrier, mode } = (req.body ?? {}) as { carrier?: unknown; mode?: unknown };
        if (!isCallForwardingCarrier(carrier)) {
          throw new ValidationError('Pick your carrier: Verizon, AT&T, T-Mobile or Other');
        }
        if (mode !== undefined && !isCallForwardingMode(mode)) {
          throw new ValidationError('Forwarding mode must be "missed" or "all"');
        }
        const chosenMode = mode ?? DEFAULT_CALL_FORWARDING_MODE;
        const previous = await deps.forwardingRepo.save(tenantId, { carrier, mode: chosenMode });
        if (previous === undefined) throw new NotFoundError('Tenant settings', tenantId);
        if (deps.auditRepo) {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'call_forwarding.configured',
              entityType: 'tenant_settings',
              entityId: tenantId,
              metadata: {
                carrier,
                mode: chosenMode,
                previousCarrier: previous?.carrier ?? null,
                previousMode: previous?.mode ?? null,
                reopenedCheck:
                  !!previous?.checkPassedAt &&
                  (previous.carrier !== carrier || previous.mode !== chosenMode),
              },
            }),
          );
        }
        res.json({ data: await forwardingView(tenantId) });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  // A check places a real phone call, so cap how often one tenant can start it.
  const checkLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: Math.max(1, Number(process.env.FORWARDING_CHECKS_PER_10_MIN) || 5),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) =>
      (req as AuthenticatedRequest).auth?.tenantId ?? ipKeyGenerator(req.ip ?? ''),
    handler: (_req, res) => {
      res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many forwarding tests. Please wait a few minutes and try again.',
      });
    },
    store: createRateLimitStore(process.env.REDIS_URL, 'forwarding-check:'),
  });

  router.post(
    '/forwarding/check',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    checkLimiter,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.forwardingCheck) {
          res.status(503).json({ error: 'FORWARDING_CHECK_UNAVAILABLE', message: 'Forwarding tests are not available yet' });
          return;
        }
        const { view } = await deps.forwardingCheck.start(req.auth!.tenantId, {
          id: req.auth!.userId,
          role: req.auth!.role,
        });
        res.status(202).json({ data: view });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.get(
    '/forwarding/check',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.forwardingCheck) {
          res.status(503).json({ error: 'FORWARDING_CHECK_UNAVAILABLE', message: 'Forwarding tests are not available yet' });
          return;
        }
        const view = await deps.forwardingCheck.latestView(req.auth!.tenantId, {
          id: req.auth!.userId,
          role: req.auth!.role,
        });
        res.json({ data: view });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.post(
    '/dismiss',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const checklist = await checklistFor(tenantId);
        if (!checklist.allDone) {
          throw new ValidationError('Finish every item before hiding the checklist');
        }
        const at = now();
        if (!(await deps.dismissalRepo.dismiss(tenantId, at))) {
          throw new NotFoundError('Tenant settings', tenantId);
        }
        if (deps.auditRepo) {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'get_found_online.dismissed',
              entityType: 'tenant_settings',
              entityId: tenantId,
              metadata: { dismissedAt: at.toISOString() },
            }),
          );
        }
        res.json({ data: { ...checklist, visible: false } });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
