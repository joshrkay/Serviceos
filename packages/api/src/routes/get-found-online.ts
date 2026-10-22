import { Router, Response } from 'express';
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

/**
 * D-044 / #1763 — the owner's "Get found online" home checklist.
 *
 *   GET  /api/get-found-online          — the derived checklist
 *   POST /api/get-found-online/dismiss  — hide it once every item is done
 *
 * Owner-only (settings:update): dispatchers and technicians get a 403 and
 * the home card renders nothing for them.
 */
export interface GetFoundOnlineRouteDeps {
  integrationRepo: Pick<GoogleBusinessIntegrationRepository, 'get'>;
  pollStateRepo?: Pick<ReviewPollStateRepository, 'getPollState'> | undefined;
  settingsRepo: Pick<SettingsRepository, 'findByTenant'>;
  dismissalRepo: GetFoundOnlineDismissalRepository;
  auditRepo?: AuditRepository | undefined;
  now?: () => Date;
}

export async function loadGetFoundOnlineFacts(
  deps: GetFoundOnlineRouteDeps,
  tenantId: string,
  now: Date,
): Promise<GetFoundOnlineFacts> {
  const [integration, pollState, settings, dismissedAt] = await Promise.all([
    deps.integrationRepo.get(tenantId),
    deps.pollStateRepo ? deps.pollStateRepo.getPollState(tenantId) : null,
    deps.settingsRepo.findByTenant(tenantId),
    deps.dismissalRepo.getDismissedAt(tenantId),
  ]);
  return {
    google: integration
      ? {
          locationState: googleBusinessLocationState(integration),
          // Google throttling (`quota`) clears on its own and a reconnect
          // can't fix it; rejected credentials (or a backoff recorded
          // before the reason was) need the owner.
          pollingPaused:
            !!pollState &&
            pollState.backoffReason !== 'quota' &&
            !!pollState.backoffUntil &&
            pollState.backoffUntil.getTime() > now.getTime(),
        }
      : null,
    googleReviewUrl: settings?.googleReviewUrl ?? null,
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
