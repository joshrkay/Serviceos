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

type Language = 'en' | 'es';

interface LanguageSettings {
  defaultLanguage: Language;
  ttsVoiceEn: string | null;
  ttsVoiceEs: string | null;
  autoDetectLanguage: boolean;
  spanishDispatcherUserIds: string[];
}

const DEFAULT_LANGUAGE_SETTINGS: LanguageSettings = {
  defaultLanguage: 'en',
  ttsVoiceEn: null,
  ttsVoiceEs: null,
  autoDetectLanguage: true,
  spanishDispatcherUserIds: [],
};

// P11-002 — in-process language settings store. Mirrors the columns
// added by migration 068_create_language_settings on tenant_settings,
// but kept in memory here so the dev/test boot (no DB) can serve the
// /api/settings/language endpoint without a 404. Production will swap
// this for a repository-backed implementation when those columns are
// surfaced through SettingsRepository.
const languageSettingsStore = new Map<string, LanguageSettings>();

function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'es';
}

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

  // P11-002 — tenant language settings (BUG-7).
  // Frontend (`packages/web/src/api/settings.ts`) calls
  // GET /api/settings/language on Settings-page mount and
  // PATCH /api/settings/language when the Spanish-mode toggle flips.
  // Without these handlers the SPA logs "fetchLanguageSettings failed: 404".
  // Backed by `languageSettingsStore` so the dev/test boot (no DB) can
  // serve the endpoint; production wiring through SettingsRepository is
  // tracked separately and out of scope for this PR.
  router.get(
    '/language',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    (req: AuthenticatedRequest, res: Response) => {
      const tenantId = req.auth!.tenantId;
      const stored = languageSettingsStore.get(tenantId);
      res.json(stored ?? DEFAULT_LANGUAGE_SETTINGS);
    },
  );

  router.patch(
    '/language',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const current = languageSettingsStore.get(tenantId) ?? DEFAULT_LANGUAGE_SETTINGS;
        const patch = (req.body ?? {}) as Partial<LanguageSettings> & Record<string, unknown>;

        const next: LanguageSettings = { ...current };
        if (patch.defaultLanguage !== undefined) {
          if (!isLanguage(patch.defaultLanguage)) {
            throw new ValidationError('defaultLanguage must be "en" or "es"', {
              field: 'defaultLanguage',
            });
          }
          next.defaultLanguage = patch.defaultLanguage;
        }
        if (patch.ttsVoiceEn !== undefined) {
          next.ttsVoiceEn = patch.ttsVoiceEn === null ? null : String(patch.ttsVoiceEn);
        }
        if (patch.ttsVoiceEs !== undefined) {
          next.ttsVoiceEs = patch.ttsVoiceEs === null ? null : String(patch.ttsVoiceEs);
        }
        if (patch.autoDetectLanguage !== undefined) {
          if (typeof patch.autoDetectLanguage !== 'boolean') {
            throw new ValidationError('autoDetectLanguage must be boolean', {
              field: 'autoDetectLanguage',
            });
          }
          next.autoDetectLanguage = patch.autoDetectLanguage;
        }
        if (patch.spanishDispatcherUserIds !== undefined) {
          if (
            !Array.isArray(patch.spanishDispatcherUserIds) ||
            !patch.spanishDispatcherUserIds.every((id) => typeof id === 'string')
          ) {
            throw new ValidationError('spanishDispatcherUserIds must be string[]', {
              field: 'spanishDispatcherUserIds',
            });
          }
          next.spanishDispatcherUserIds = patch.spanishDispatcherUserIds;
        }

        languageSettingsStore.set(tenantId, next);
        res.json(next);
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
