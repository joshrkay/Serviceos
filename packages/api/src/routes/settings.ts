import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth/clerk';
import { requireAuth, requireTenant, requirePermission } from '../middleware/auth';
import { updateSettingsSchema } from '../shared/contracts';
import { toErrorResponse, ValidationError } from '../shared/errors';
import { normalizeMobileE164 } from '../shared/phone/normalize';
import { loadActivePackConfigs } from '../shared/pack-config-loader';
import { VerticalPackRegistry } from '../shared/vertical-pack-registry';
import { PackActivationRepository } from '../settings/pack-activation';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { z } from 'zod';
import {
  getSettings,
  updateSettings,
  ensureTenantSettings,
  SettingsRepository,
  TenantSettings,
  validateTerminologyPreferences,
} from '../settings/settings';

type Language = 'en' | 'es';

interface LanguageSettings {
  defaultLanguage: Language;
  ttsVoiceEn: string | null;
  ttsVoiceEs: string | null;
  autoDetectLanguage: boolean;
  spanishDispatcherUserIds: string[];
  // Voice-parity — opt-in language stack; always includes 'en'. The Spanish
  // toggle in Settings flips this between ['en'] and ['en','es'].
  supportedLanguages: Language[];
}

const DEFAULT_LANGUAGE_SETTINGS: LanguageSettings = {
  defaultLanguage: 'en',
  ttsVoiceEn: null,
  ttsVoiceEs: null,
  autoDetectLanguage: true,
  spanishDispatcherUserIds: [],
  supportedLanguages: ['en'],
};

// P11-002 — project the persisted tenant_settings language columns into
// the response shape the web client (web/src/api/settings.ts) expects.
function projectLanguageSettings(
  settings: TenantSettings | null,
): LanguageSettings {
  if (!settings) return DEFAULT_LANGUAGE_SETTINGS;
  return {
    defaultLanguage: settings.defaultLanguage ?? 'en',
    ttsVoiceEn: settings.ttsVoiceEn ?? null,
    ttsVoiceEs: settings.ttsVoiceEs ?? null,
    autoDetectLanguage: settings.autoDetectLanguage ?? true,
    spanishDispatcherUserIds: settings.spanishDispatcherUserIds ?? [],
    supportedLanguages: normalizeSupportedLanguages(settings.supportedLanguages),
  };
}

// 'en' is always supported (the universal fallback); the toggle only adds or
// removes 'es'. Dedupe + force-include 'en' so a malformed/empty array can
// never strand the agent without a usable language.
function normalizeSupportedLanguages(input?: Language[] | null): Language[] {
  const set = new Set<Language>(['en']);
  for (const lang of input ?? []) {
    if (lang === 'en' || lang === 'es') set.add(lang);
  }
  return Array.from(set);
}

// Polly voice id; constrained so a stored value can't inject XML
// metacharacters into the `<Say voice="...">` TwiML.
const ttsVoicePatchField = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/, 'Invalid voice id')
  .max(64)
  .nullable()
  .optional();

const languagePatchSchema = z.object({
  defaultLanguage: z.enum(['en', 'es']).optional(),
  ttsVoiceEn: ttsVoicePatchField,
  ttsVoiceEs: ttsVoicePatchField,
  autoDetectLanguage: z.boolean().optional(),
  spanishDispatcherUserIds: z.array(z.string().uuid()).optional(),
  // Voice-parity — opt-in language stack. 'en' is always force-included on
  // persist so the agent can never be left without a fallback language.
  supportedLanguages: z.array(z.enum(['en', 'es'])).optional(),
});

interface SettingsRouterDependencies {
  activationRepo: PackActivationRepository;
  verticalPackRegistry: VerticalPackRegistry;
}

export function createSettingsRouter(
  settingsRepo: SettingsRepository,
  deps?: SettingsRouterDependencies,
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
  // Backed by the persisted tenant_settings language columns via
  // SettingsRepository (P11-002 follow-up — replaces the old in-memory
  // store). The JSON shape is kept stable for web/src/api/settings.ts.
  router.get(
    '/language',
    requireAuth,
    requireTenant,
    requirePermission('settings:view'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const settings = await getSettings(req.auth!.tenantId, settingsRepo);
        res.json(projectLanguageSettings(settings));
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.patch(
    '/language',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const patch = languagePatchSchema.parse(req.body ?? {});
        // Force-include 'en' (and dedupe) before persisting so the toggle can
        // never store a stack the agent can't fall back from.
        if (patch.supportedLanguages !== undefined) {
          patch.supportedLanguages = normalizeSupportedLanguages(
            patch.supportedLanguages,
          );
        }
        const changedKeys = Object.keys(patch);

        // Ensure the row exists so a first-time PATCH persists rather
        // than 404ing (settings are normally bootstrapped on tenant
        // creation, but tests / legacy tenants may not have a row yet).
        await ensureTenantSettings(tenantId, settingsRepo);
        const updated = await updateSettings(tenantId, patch, settingsRepo);

        // D2-1c — audit-log the language settings change.
        if (auditRepo) {
          await auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'settings.language.updated',
              entityType: 'tenant_settings',
              entityId: updated?.id ?? tenantId,
              metadata: { changedKeys },
            }),
          );
        }

        res.json(projectLanguageSettings(updated));
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

        // P8-016 — normalize owner_phone to E.164 before persisting (or
        // null to clear). Done at the route boundary so the repo and
        // downstream Twilio dial code can trust the stored shape.
        if (parsed.ownerPhone !== undefined && parsed.ownerPhone !== null) {
          const trimmed = parsed.ownerPhone.trim();
          if (trimmed === '') {
            parsed.ownerPhone = null;
          } else {
            try {
              parsed.ownerPhone = normalizeMobileE164(trimmed);
            } catch (err) {
              throw new ValidationError(
                err instanceof Error ? err.message : 'Invalid owner phone number',
                { field: 'ownerPhone' },
              );
            }
          }
        }

        // Voice-parity — normalize transfer_number to E.164 (or null to
        // clear) at the boundary so the escalation/dial code can trust the
        // stored shape, exactly like owner_phone above.
        if (parsed.transferNumber !== undefined && parsed.transferNumber !== null) {
          const trimmed = parsed.transferNumber.trim();
          if (trimmed === '') {
            parsed.transferNumber = null;
          } else {
            try {
              parsed.transferNumber = normalizeMobileE164(trimmed);
            } catch (err) {
              throw new ValidationError(
                err instanceof Error ? err.message : 'Invalid transfer number',
                { field: 'transferNumber' },
              );
            }
          }
        }

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

        // D2-1c — audit-log the tenant-settings mutation. Records WHICH
        // keys the actor touched so the timeline diffs reconstruct
        // without storing the full before/after payload (PII-safe).
        if (auditRepo) {
          await auditRepo.create(
            createAuditEvent({
              tenantId: req.auth!.tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'settings.tenant.updated',
              entityType: 'tenant_settings',
              entityId: result.id,
              metadata: { changedKeys: Object.keys(parsed) },
            }),
          );
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
