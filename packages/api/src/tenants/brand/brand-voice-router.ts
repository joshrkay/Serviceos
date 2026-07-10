/**
 * N-011 / P4-015 — Brand-Voice Configurator router.
 *
 * Mounted at /api/settings/brand-voice. A dedicated router (not overloaded onto
 * PUT /api/settings) because the lock + cool-down + version-bump + audit
 * semantics differ from a plain settings PATCH.
 *
 *   GET    /                 → current six fields + version/locked/cooldown
 *   PUT    /                 → explicit web edit (cool-down gated) or onboarding
 *   GET    /versions         → append-only history
 *   POST   /rollback         → re-persist an older snapshot as a new bump
 */
import { Router, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../../middleware/auth';
import { toErrorResponse } from '../../shared/errors';
import { AuditRepository } from '../../audit/audit';
import {
  SettingsRepository,
  ensureTenantSettings,
} from '../../settings/settings';
import {
  brandVoiceSchema,
  cooldownUntil,
  type BrandVoiceRepository,
  type BrandVoiceState,
} from './brand-voice';
import { updateBrandVoice, rollbackBrandVoice } from './brand-voice-service';

const putSchema = brandVoiceSchema.extend({
  /** Onboarding's first write: skips the cool-down and locks the field. */
  onboarding: z.boolean().optional(),
});

const rollbackSchema = z.object({
  version: z.number().int().positive(),
});

function projectState(state: BrandVoiceState) {
  const c = state.config;
  return {
    register: c.register,
    opening_lines: c.opening_lines ?? [],
    signoff: c.signoff,
    banned_phrases: c.banned_phrases ?? [],
    persona_name: c.persona_name,
    pronoun: c.pronoun,
    version: state.version,
    locked: state.locked,
    updated_at: state.updatedAt,
    cooldown_until: cooldownUntil(state.updatedAt),
  };
}

export function createBrandVoiceRouter(
  brandVoiceRepo: BrandVoiceRepository,
  settingsRepo: SettingsRepository,
  auditRepo?: AuditRepository,
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const state = await brandVoiceRepo.getState(req.auth!.tenantId);
        res.json(projectState(state));
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.get(
    '/versions',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const versions = await brandVoiceRepo.listVersions(req.auth!.tenantId);
        res.json({ versions });
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.put(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { onboarding, ...patch } = putSchema.parse(req.body ?? {});
        // Ensure the settings row exists so a first-time write persists rather
        // than failing on a missing tenant_settings row.
        await ensureTenantSettings(req.auth!.tenantId, settingsRepo);

        const result = await updateBrandVoice(
          {
            actor: {
              tenantId: req.auth!.tenantId,
              userId: req.auth!.userId,
              role: req.auth!.role,
            },
            patch,
            onboarding,
          },
          brandVoiceRepo,
        );

        if (auditRepo) await auditRepo.create(result.audit);
        res.json(projectState(result.state));
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.post(
    '/rollback',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const { version } = rollbackSchema.parse(req.body ?? {});
        await ensureTenantSettings(req.auth!.tenantId, settingsRepo);

        const result = await rollbackBrandVoice(
          {
            actor: {
              tenantId: req.auth!.tenantId,
              userId: req.auth!.userId,
              role: req.auth!.role,
            },
            version,
          },
          brandVoiceRepo,
        );

        if (auditRepo) await auditRepo.create(result.audit);
        res.json(projectState(result.state));
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
