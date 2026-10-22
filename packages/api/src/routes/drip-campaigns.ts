import { Router, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requireRole } from '../middleware/auth';
import { notFoundOnMalformedId } from '../middleware/validate-uuid-param';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import { NotFoundError } from '../shared/errors';
import { routeParam } from '../shared/route-params';
import type { DripRepository } from '../marketing/drip/drip-repository';
import type { DripEngine } from '../marketing/drip/drip-engine';
import {
  DEFAULT_TARGET_DAYS,
  DRIP_FEATURE_FLAG,
  createDripSequenceSchema,
  type DripSequence,
  type DripSequenceStatus,
} from '../marketing/drip/sequence';

export interface DripCampaignsRouterDeps {
  repo: DripRepository;
  engine: Pick<DripEngine, 'enrollTargets'>;
  isEnabledForTenant: (tenantId: string, flagKey: string) => Promise<boolean>;
  auditRepo: AuditRepository;
}

/**
 * #1735 — outbound multi-step drip campaigns. Mounted at /api/drip-campaigns.
 *
 * Owner-only (outbound marketing to customers is the owner's call) and off by
 * default: every route except GET /status answers 404 until the tenant has the
 * `drip_campaigns` flag. A new sequence starts paused; nothing is sent until
 * the owner resumes it, and enrolling targets does not itself send anything.
 */
export function createDripCampaignsRouter(deps: DripCampaignsRouterDeps): Router {
  const router = Router();
  const ownerOnly = [requireAuth, requireTenant, requireRole('owner')];

  const requireFlag = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    deps
      .isEnabledForTenant(req.auth!.tenantId, DRIP_FEATURE_FLAG)
      .then((enabled) => {
        if (enabled) {
          next();
          return;
        }
        res.status(404).json({ error: 'NOT_FOUND', message: 'Drip campaigns are not enabled' });
      })
      .catch(next);
  };

  router.get(
    '/status',
    ...ownerOnly,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      res.json({ enabled: await deps.isEnabledForTenant(req.auth!.tenantId, DRIP_FEATURE_FLAG) });
    }),
  );

  router.get(
    '/sequences',
    ...ownerOnly,
    requireFlag,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const [sequences, stats] = await Promise.all([deps.repo.listSequences(tenantId), deps.repo.stats(tenantId)]);
      const byId = new Map(stats.map((s) => [s.sequenceId, s]));
      res.json(
        sequences.map((s) => ({
          ...s,
          stats: byId.get(s.id) ?? { sequenceId: s.id, enrolled: 0, active: 0, completed: 0, booked: 0 },
        })),
      );
    }),
  );

  router.post(
    '/sequences',
    ...ownerOnly,
    requireFlag,
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const input = createDripSequenceSchema.parse(req.body);
      const now = new Date();
      const sequence: DripSequence = {
        id: uuidv4(),
        tenantId: req.auth!.tenantId,
        name: input.name,
        targetKind: input.targetKind,
        targetDays: input.targetDays ?? DEFAULT_TARGET_DAYS[input.targetKind],
        steps: input.steps,
        status: 'paused',
        createdBy: req.auth!.userId,
        createdAt: now,
        updatedAt: now,
      };
      const created = await deps.repo.createSequence(sequence);
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId: created.tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          eventType: 'drip.sequence_created',
          entityType: 'drip_sequence',
          entityId: created.id,
          metadata: {
            name: created.name,
            targetKind: created.targetKind,
            channels: created.steps.map((s) => s.channel),
          },
        }),
      );
      res.status(201).json(created);
    }),
  );

  const setStatus = (path: string, status: DripSequenceStatus, eventType: string) =>
    router.post(
      path,
      ...ownerOnly,
      requireFlag,
      notFoundOnMalformedId('Drip campaign not found'),
      asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
        const tenantId = req.auth!.tenantId;
        const id = routeParam(req, 'id');
        const updated = await deps.repo.setSequenceStatus(tenantId, id, status);
        if (!updated) throw new NotFoundError('Drip campaign', id);
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: req.auth!.userId,
            actorRole: req.auth!.role,
            eventType,
            entityType: 'drip_sequence',
            entityId: updated.id,
            metadata: { status },
          }),
        );
        res.json(updated);
      }),
    );
  setStatus('/sequences/:id/pause', 'paused', 'drip.sequence_paused');
  setStatus('/sequences/:id/resume', 'active', 'drip.sequence_resumed');

  router.post(
    '/sequences/:id/enroll',
    ...ownerOnly,
    requireFlag,
    notFoundOnMalformedId('Drip campaign not found'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const enrolled = await deps.engine.enrollTargets(req.auth!.tenantId, routeParam(req, 'id'), {
        userId: req.auth!.userId,
        role: req.auth!.role,
      });
      res.json({ enrolled });
    }),
  );

  return router;
}
