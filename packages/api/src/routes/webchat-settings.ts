import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { toErrorResponse, ValidationError } from '../shared/errors';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import {
  DEFAULT_DAILY_COST_CAP_CENTS,
  DEFAULT_DAILY_TURN_CAP,
  MAX_ALLOWED_ORIGINS,
  MAX_DAILY_COST_CAP_CENTS,
  MAX_DAILY_TURN_CAP,
  normalizeOrigins,
  type WebchatConfig,
  type WebchatConfigRepository,
} from '../webchat/webchat-config';
import { usageDay, type WebchatUsageRepository } from '../webchat/webchat-usage';

/**
 * #1737 — the owner's web chat settings.
 *
 *   GET  /api/webchat              config, embed snippet, today's usage
 *   PUT  /api/webchat              toggle, allowed sites, daily caps, kill switch
 *   POST /api/webchat/rotate-token new embed token (the old snippet stops working)
 *
 * Owner-only (settings:update). Off by default; turning it on needs at least
 * one allowed site, and the platform `webchat_widget` flag must be on for the
 * tenant (`available` tells the UI when it is not).
 */
export interface WebchatSettingsRouteDeps {
  configRepo: WebchatConfigRepository;
  usageRepo: WebchatUsageRepository;
  auditRepo: AuditRepository;
  /** API origin the snippet's script is served from. */
  apiBaseUrl: string;
  isEnabledForTenant: (tenantId: string) => Promise<boolean>;
  globallyKilled: () => boolean;
  now?: () => Date;
}

const putSchema = z
  .object({
    enabled: z.boolean(),
    allowedOrigins: z.array(z.string().max(200)).max(MAX_ALLOWED_ORIGINS),
    dailyTurnCap: z.number().int().min(1).max(MAX_DAILY_TURN_CAP),
    dailyCostCapCents: z.number().int().min(1).max(MAX_DAILY_COST_CAP_CENTS),
    killed: z.boolean(),
  })
  .partial()
  .strict();

export function buildSnippet(apiBaseUrl: string, embedToken: string): string {
  return `<script async src="${apiBaseUrl.replace(/\/$/, '')}/api/public/webchat/widget.js" data-token="${embedToken}"></script>`;
}

export function createWebchatSettingsRouter(deps: WebchatSettingsRouteDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  async function view(tenantId: string, config: WebchatConfig | null) {
    // No row yet: show defaults without minting a token (reads never write).
    const usage = await deps.usageRepo.get(tenantId, usageDay(now()));
    return {
      enabled: config?.enabled ?? false,
      killed: config?.killedAt != null,
      allowedOrigins: config?.allowedOrigins ?? [],
      dailyTurnCap: config?.dailyTurnCap ?? DEFAULT_DAILY_TURN_CAP,
      dailyCostCapCents: config?.dailyCostCapCents ?? DEFAULT_DAILY_COST_CAP_CENTS,
      snippet: config ? buildSnippet(deps.apiBaseUrl, config.embedToken) : null,
      available: !deps.globallyKilled() && (await deps.isEnabledForTenant(tenantId)),
      usageToday: usage,
    };
  }

  const guard = [requireAuth, requireTenant, requirePermission('settings:update')];

  router.get('/', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      res.json({ data: await view(tenantId, await deps.configRepo.get(tenantId)) });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.put('/', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const parsed = putSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ValidationError('Invalid web chat settings');
      const { allowedOrigins, ...rest } = parsed.data;

      let origins: string[] | undefined;
      if (allowedOrigins) {
        const normalized = normalizeOrigins(allowedOrigins);
        if (normalized.rejected.length > 0) {
          throw new ValidationError(
            `Not a valid site address: ${normalized.rejected.join(', ')}. Use the form https://example.com`,
          );
        }
        origins = normalized.origins;
      }

      const current = await deps.configRepo.get(tenantId);
      const effectiveOrigins = origins ?? current?.allowedOrigins ?? [];
      if ((rest.enabled ?? current?.enabled) && effectiveOrigins.length === 0) {
        throw new ValidationError('Add the website address that will show the chat before turning it on');
      }
      if (rest.enabled && !(await deps.isEnabledForTenant(tenantId))) {
        throw new ValidationError('Web chat is not available for your account yet');
      }

      const next = await deps.configRepo.upsert(tenantId, {
        ...rest,
        ...(origins ? { allowedOrigins: origins } : {}),
      });
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          eventType: 'webchat.config_updated',
          entityType: 'webchat_config',
          entityId: tenantId,
          metadata: { changed: Object.keys(parsed.data), enabled: next.enabled, killed: next.killedAt !== null },
        }),
      );
      res.json({ data: await view(tenantId, next) });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  router.post('/rotate-token', ...guard, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const next = await deps.configRepo.rotateToken(tenantId);
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: req.auth!.userId,
          actorRole: req.auth!.role,
          eventType: 'webchat.token_rotated',
          entityType: 'webchat_config',
          entityId: tenantId,
          metadata: {},
        }),
      );
      res.json({ data: await view(tenantId, next) });
    } catch (err) {
      const { statusCode, body } = toErrorResponse(err);
      res.status(statusCode).json(body);
    }
  });

  return router;
}
