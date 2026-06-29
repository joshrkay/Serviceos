import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { AuditRepository } from '../audit/audit';
import { CustomerRepository } from '../customers/customer';
import { TagRepository } from '../customers/tag';
import { MessageDeliveryProvider } from '../notifications/delivery-provider';
import {
  CampaignRepository,
  createCampaign,
  sendCampaign,
} from '../marketing/campaign';
import { createCampaignSchema } from '../shared/contracts';

export interface MarketingRouterDeps {
  campaignRepo: CampaignRepository;
  customerRepo: CustomerRepository;
  tagRepo: TagRepository;
  /** Null when no delivery provider is configured — send returns 503. */
  delivery: MessageDeliveryProvider | null;
  /** Resolve a customer group's member ids (for group-targeted campaigns). */
  groupMemberIds: (tenantId: string, groupId: string) => Promise<string[]>;
  auditRepo: AuditRepository;
}

/**
 * MKT (Jobber parity) — customer email campaigns.
 *
 * Mounted at /api/marketing/campaigns. Uses the settings permission set
 * (marketing is an owner/admin operation). Sending fans out over the
 * configured delivery provider.
 */
export function createMarketingRouter(deps: MarketingRouterDeps): Router {
  const router = Router();

  router.get(
    '/campaigns',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      res.json(await deps.campaignRepo.list(req.auth!.tenantId));
    })
  );

  router.post(
    '/campaigns',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createCampaignSchema.parse(req.body);
      const campaign = await createCampaign(
        {
          ...parsed,
          tenantId: req.auth!.tenantId,
          createdBy: req.auth!.userId,
          actorRole: req.auth!.role,
        },
        deps.campaignRepo,
        deps.auditRepo
      );
      res.status(201).json(campaign);
    })
  );

  router.post(
    '/campaigns/:id/send',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      if (!deps.delivery) {
        res.status(503).json({ error: 'NOT_CONFIGURED', message: 'No email provider configured' });
        return;
      }
      const sent = await sendCampaign(
        req.auth!.tenantId,
        req.params.id,
        {
          campaignRepo: deps.campaignRepo,
          customerRepo: deps.customerRepo,
          tagRepo: deps.tagRepo,
          delivery: deps.delivery,
          groupMemberIds: deps.groupMemberIds,
          auditRepo: deps.auditRepo,
        },
        req.auth!.userId
      );
      res.json(sent);
    })
  );

  return router;
}
