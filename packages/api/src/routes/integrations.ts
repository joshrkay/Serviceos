import { Router, Request, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant } from '../middleware/auth';
import { toErrorResponse, ValidationError, NotFoundError } from '../shared/errors';
import { extractIp } from '../shared/extract-ip';
import {
  AccountingIntegrationRepository,
  AccountingOAuthStateRepository,
  AccountingSyncLogRepository,
} from '../integrations/accounting/types';
import {
  buildQuickBooksAuthUrl,
  exchangeQuickBooksAuthorizationCode,
  QuickBooksOAuthConfig,
  QuickBooksFetch,
} from '../integrations/accounting/quickbooks-oauth';
import { AccountingSyncService } from '../integrations/accounting/sync-service';
import { InvoiceRepository } from '../invoices/invoice';
import { CustomerRepository } from '../customers/customer';
import { JobRepository } from '../jobs/job';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { Logger } from '../logging/logger';

/**
 * F17 / P15-001 — Per-tenant accounting integrations.
 *
 *   GET  /api/integrations                         — list tenant integrations
 *   POST /api/integrations/quickbooks/connect      — OAuth URL
 *   GET  /api/integrations/quickbooks/callback     — OAuth landing (unauthenticated)
 *   POST /api/integrations/quickbooks/disconnect   — revoke
 *   GET  /api/integrations/quickbooks/status       — sync status + recent log
 *   POST /api/integrations/quickbooks/sync         — manual retry
 */

export interface IntegrationsRouteDeps {
  integrationRepo: AccountingIntegrationRepository;
  syncLogRepo: AccountingSyncLogRepository;
  oauthStateRepo: AccountingOAuthStateRepository;
  invoiceRepo: InvoiceRepository;
  customerRepo: CustomerRepository;
  jobRepo: JobRepository;
  qboConfig?: QuickBooksOAuthConfig;
  fetchFn?: QuickBooksFetch;
  appBaseUrl?: string;
  auditRepo?: AuditRepository;
  logger?: Logger;
}

function isSafeRelativePath(value: string | undefined): value is string {
  if (!value) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (value.startsWith('/\\')) return false;
  return true;
}

export function createIntegrationsOAuthCallbackRouter(deps: IntegrationsRouteDeps): Router {
  const router = Router();

  router.get('/quickbooks/callback', async (req: Request, res: Response) => {
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : undefined;
      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      const realmId =
        typeof req.query.realmId === 'string'
          ? req.query.realmId
          : typeof req.query.realmid === 'string'
            ? req.query.realmid
            : undefined;
      const errorParam = typeof req.query.error === 'string' ? req.query.error : undefined;

      if (errorParam) {
        res.redirect(
          `${deps.appBaseUrl ?? ''}/settings?quickbooks_error=${encodeURIComponent(errorParam)}`,
        );
        return;
      }
      if (!code || !state || !realmId) {
        throw new ValidationError('Missing code, state, or realmId');
      }
      if (!deps.qboConfig) {
        throw new ValidationError('QuickBooks integration is not configured');
      }

      const consumed = await deps.oauthStateRepo.consume(state);
      if (!consumed || consumed.provider !== 'quickbooks') {
        throw new ValidationError('Invalid or expired OAuth state');
      }

      const tokens = await exchangeQuickBooksAuthorizationCode(
        deps.qboConfig,
        code,
        realmId,
        deps.fetchFn ?? fetch,
      );

      const upserted = await deps.integrationRepo.upsert({
        tenantId: consumed.tenantId,
        provider: 'quickbooks',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        realmId: tokens.realmId,
      });

      if (deps.auditRepo) {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId: consumed.tenantId,
            actorId: 'system:quickbooks-oauth-callback',
            actorRole: 'system',
            eventType: 'accounting_integration.connected',
            entityType: 'accounting_integration',
            entityId: upserted.id,
            metadata: {
              provider: 'quickbooks',
              realmId: upserted.realmId,
              originatingUserId: consumed.userId,
              ipAddress: extractIp(req),
              userAgent: req.headers['user-agent'],
            },
          }),
        );
      }

      const back = isSafeRelativePath(consumed.redirectAfter)
        ? `${deps.appBaseUrl ?? ''}${consumed.redirectAfter}`
        : `${deps.appBaseUrl ?? ''}/settings?quickbooks_connected=1`;
      res.redirect(back);
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}

export function createIntegrationsRouter(deps: IntegrationsRouteDeps): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const integration = await deps.integrationRepo.findByTenant(
          req.auth!.tenantId,
          'quickbooks',
        );
        if (!integration) {
          res.json({ data: [] });
          return;
        }
        res.json({
          data: [
            {
              id: integration.id,
              provider: integration.provider,
              status: integration.status,
              realmId: integration.realmId,
              connectedAt: integration.connectedAt.toISOString(),
              lastSyncedAt: integration.lastSyncedAt?.toISOString() ?? null,
              errorMessage: integration.errorMessage,
            },
          ],
        });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.post(
    '/quickbooks/connect',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.qboConfig) {
          throw new ValidationError('QuickBooks integration is not configured');
        }
        const rawRedirect =
          typeof req.body?.redirectAfter === 'string' ? req.body.redirectAfter : undefined;
        const redirectAfter = isSafeRelativePath(rawRedirect) ? rawRedirect : undefined;
        const { id: stateId } = await deps.oauthStateRepo.create({
          tenantId: req.auth!.tenantId,
          userId: req.auth!.userId,
          provider: 'quickbooks',
          redirectAfter,
        });
        const url = buildQuickBooksAuthUrl(deps.qboConfig, stateId);
        res.json({ url });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.post(
    '/quickbooks/disconnect',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const ok = await deps.integrationRepo.disconnect(req.auth!.tenantId, 'quickbooks');
        if (!ok) {
          throw new NotFoundError('Accounting integration', 'quickbooks');
        }
        res.json({ disconnected: true });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.get(
    '/quickbooks/status',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const integration = await deps.integrationRepo.findByTenant(
          req.auth!.tenantId,
          'quickbooks',
        );
        if (!integration) {
          res.json({ data: null });
          return;
        }
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const errorCount = await deps.syncLogRepo.countRecentFailures(
          req.auth!.tenantId,
          integration.id,
          since,
        );
        const recent = await deps.syncLogRepo.listRecent(
          req.auth!.tenantId,
          integration.id,
          10,
        );
        res.json({
          data: {
            status: integration.status,
            lastSyncedAt: integration.lastSyncedAt?.toISOString() ?? null,
            errorCount24h: errorCount,
            recentSync: recent.map((r) => ({
              entityType: r.entityType,
              entityId: r.entityId,
              status: r.status,
              syncedAt: r.syncedAt.toISOString(),
              errorMessage: r.errorMessage,
            })),
          },
        });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.post(
    '/quickbooks/sync',
    requireAuth,
    requireTenant,
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        if (!deps.qboConfig || !deps.logger) {
          throw new ValidationError('QuickBooks sync is not configured');
        }
        const integration = await deps.integrationRepo.findByTenant(
          req.auth!.tenantId,
          'quickbooks',
        );
        if (!integration || integration.status !== 'active') {
          throw new NotFoundError('Active QuickBooks integration', req.auth!.tenantId);
        }
        const service = new AccountingSyncService({
          integrationRepo: deps.integrationRepo,
          syncLogRepo: deps.syncLogRepo,
          invoiceRepo: deps.invoiceRepo,
          customerRepo: deps.customerRepo,
          jobRepo: deps.jobRepo,
          qboConfig: deps.qboConfig,
          fetchFn: deps.fetchFn,
          logger: deps.logger,
        });
        const result = await service.syncIntegration(integration);
        res.json({ data: result });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}

/** Pool-only export for typing in app.ts wiring. */
export type IntegrationsRoutePool = Pool;
