import { Router, Response } from 'express';
import { z } from 'zod';

import { AuthenticatedRequest } from '../auth/clerk';
import { asyncRoute } from '../middleware/async-route';
import {
  requireAuth,
  requireTenant,
  requirePermission,
} from '../middleware/auth';
import { AuditRepository } from '../audit/audit';
import { SettingsRepository } from '../settings/settings';
import {
  MessageTemplateCategory,
  MessageTemplateChannel,
  MessageTemplateRepository,
  createMessageTemplate,
  deleteMessageTemplate,
  extractTemplateVariables,
  renderMessageTemplate,
  updateMessageTemplate,
} from './message-template';

const channelSchema = z.enum(['sms', 'email']);
const categorySchema = z.enum([
  'general',
  'appointment',
  'estimate',
  'invoice',
  'followup',
  'review',
]);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  body: z.string().min(1).max(2000),
  channel: channelSchema.optional(),
  category: categorySchema.optional(),
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    body: z.string().min(1).max(2000).optional(),
    channel: channelSchema.optional(),
    category: categorySchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field is required',
  });

const renderSchema = z.object({
  variables: z.record(z.string()).default({}),
});

/**
 * Story 10.5 — tenant-scoped customer message templates.
 *
 * Both the agent (via the repository + `renderMessageTemplate`) and humans
 * (via this route) draw from the same store. The render endpoint applies the
 * tenant's terminology preferences and reports any unfilled `{{variable}}`
 * placeholders so a draft is never sent with gaps.
 */
export function createMessageTemplateRouter(
  templateRepo: MessageTemplateRepository,
  settingsRepo?: SettingsRepository,
  auditRepo?: AuditRepository,
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('conversations:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const channel = req.query.channel as string | undefined;
      const category = req.query.category as string | undefined;
      const activeOnly = req.query.activeOnly === 'true';

      if (channel && !channelSchema.safeParse(channel).success) {
        res
          .status(400)
          .json({ error: 'VALIDATION_ERROR', message: 'Invalid channel' });
        return;
      }
      if (category && !categorySchema.safeParse(category).success) {
        res
          .status(400)
          .json({ error: 'VALIDATION_ERROR', message: 'Invalid category' });
        return;
      }

      const templates = await templateRepo.findByTenant(req.auth!.tenantId, {
        channel: channel as MessageTemplateChannel | undefined,
        category: category as MessageTemplateCategory | undefined,
        activeOnly,
      });
      res.json(templates.map(withVariables));
    }),
  );

  router.get(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('conversations:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const template = await templateRepo.findById(
        req.auth!.tenantId,
        req.params.id,
      );
      if (!template) {
        res
          .status(404)
          .json({ error: 'NOT_FOUND', message: 'Template not found' });
        return;
      }
      res.json(withVariables(template));
    }),
  );

  router.post(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('conversations:manage'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid request',
        });
        return;
      }
      const created = await createMessageTemplate(
        {
          tenantId: req.auth!.tenantId,
          createdBy: req.auth!.userId,
          name: parsed.data.name,
          body: parsed.data.body,
          channel: parsed.data.channel,
          category: parsed.data.category,
        },
        templateRepo,
        auditRepo,
        req.auth!.role,
      );
      res.status(201).json(withVariables(created));
    }),
  );

  router.put(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('conversations:manage'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid request',
        });
        return;
      }
      const updated = await updateMessageTemplate(
        templateRepo,
        req.auth!.tenantId,
        req.params.id,
        parsed.data,
        { userId: req.auth!.userId, role: req.auth!.role },
        auditRepo,
      );
      if (!updated) {
        res
          .status(404)
          .json({ error: 'NOT_FOUND', message: 'Template not found' });
        return;
      }
      res.json(withVariables(updated));
    }),
  );

  router.delete(
    '/:id',
    requireAuth,
    requireTenant,
    requirePermission('conversations:manage'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const deleted = await deleteMessageTemplate(
        templateRepo,
        req.auth!.tenantId,
        req.params.id,
        { userId: req.auth!.userId, role: req.auth!.role },
        auditRepo,
      );
      if (!deleted) {
        res
          .status(404)
          .json({ error: 'NOT_FOUND', message: 'Template not found' });
        return;
      }
      res.status(204).end();
    }),
  );

  // Render a template with supplied variables + tenant terminology. Returns
  // the rendered text and any unfilled placeholders; increments usage.
  router.post(
    '/:id/render',
    requireAuth,
    requireTenant,
    requirePermission('conversations:view'),
    asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
      const parsed = renderSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: parsed.error.issues[0]?.message ?? 'Invalid request',
        });
        return;
      }
      const template = await templateRepo.findById(
        req.auth!.tenantId,
        req.params.id,
      );
      if (!template) {
        res
          .status(404)
          .json({ error: 'NOT_FOUND', message: 'Template not found' });
        return;
      }

      const settings = settingsRepo
        ? await settingsRepo.findByTenant(req.auth!.tenantId)
        : null;
      const rendered = renderMessageTemplate(
        template.body,
        parsed.data.variables,
        settings?.terminologyPreferences,
      );
      await templateRepo.incrementUsage(req.auth!.tenantId, req.params.id);
      res.json(rendered);
    }),
  );

  return router;
}

function withVariables<T extends { body: string }>(
  template: T,
): T & { variables: string[] } {
  return { ...template, variables: extractTemplateVariables(template.body) };
}
