import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { updateSettingsSchema } from '../shared/contracts';
import { toErrorResponse, ValidationError } from '../shared/errors';
import { loadActivePackConfigs } from '../shared/pack-config-loader';
import { VerticalPackRegistry } from '../shared/vertical-pack-registry';
import { PackActivationRepository } from '../settings/pack-activation';
import {
  getSettings,
  updateSettings,
  SettingsRepository,
  validateTerminologyPreferences,
} from '../settings/settings';

interface SettingsRouterDependencies {
  activationRepo: PackActivationRepository;
  verticalPackRegistry: VerticalPackRegistry;
}

export function createSettingsRouter(
  settingsRepo: SettingsRepository,
  deps?: SettingsRouterDependencies
): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const result = await getSettings(req.auth!.tenantId, settingsRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Settings not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  router.put(
    '/',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const parsed = updateSettingsSchema.parse(req.body);

        if (parsed.terminologyPreferences) {
          // Tier 4 — when deps are wired, validate against the union of
          // pack-derived equipment terms + ENTITY_LABEL_TERMINOLOGY_KEYS.
          // When deps aren't wired (legacy app boot, tests), fall back
          // to the entity-label allowlist baked into the validator —
          // this keeps the Terminology sheet functional without forcing
          // every test harness to wire pack-config plumbing.
          let validTermKeys: string[] | undefined;
          if (deps) {
            const activePackConfigs = await loadActivePackConfigs(
              req.auth!.tenantId,
              deps.activationRepo,
              deps.verticalPackRegistry
            );
            validTermKeys = activePackConfigs.flatMap((config) =>
              Object.keys(config.terminology),
            );
          }
          const validationErrors = validateTerminologyPreferences(
            parsed.terminologyPreferences,
            validTermKeys ?? [],
          );

          if (validationErrors.length > 0) {
            throw new ValidationError('Invalid terminologyPreferences payload', {
              field: 'terminologyPreferences',
              errors: validationErrors,
            });
          }
        }

        const result = await updateSettings(req.auth!.tenantId, parsed, settingsRepo);
        if (!result) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Settings not found' });
          return;
        }
        res.json(result);
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  return router;
}
