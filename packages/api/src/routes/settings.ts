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
  resolveEscalationSettings,
  SettingsRepository,
  TenantSettings,
  EscalationSettings,
  validateTerminologyPreferences,
} from '../settings/settings';
import {
  isEnrollablePin,
  normalizeEnrollmentPin,
  hashVoiceApprovalPin,
  resolveVoiceApprovalPinSecret,
  MIN_PIN_DIGITS,
  MAX_PIN_DIGITS,
} from '../settings/voice-approval-pin';

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

// WS21a — the voice-approval PIN enrollment payload. Accepts a raw 4–6 digit
// string (spaces/dashes tolerated, normalized server-side); the hash is
// computed here and only the hash is persisted.
const voiceApprovalPinSchema = z.object({
  pin: z.string().min(1).max(32),
});

/**
 * WS21a — strip the money-approval PIN credential out of any settings payload
 * returned to a client. Both the HMAC hash and the deprecated plaintext
 * challenge are secrets; the client only needs to know WHETHER a PIN is
 * enrolled, surfaced as `voiceApprovalPinEnrolled`.
 */
function redactSettingsForResponse(settings: TenantSettings): TenantSettings & {
  voiceApprovalPinEnrolled: boolean;
} {
  const escalation = settings.escalationSettings;
  const enrolled = !!(
    escalation?.voice_approval_pin_hash ||
    (typeof escalation?.voice_approval_challenge === 'string' &&
      escalation.voice_approval_challenge.trim().length > 0)
  );
  let redactedEscalation = escalation;
  if (escalation) {
    const {
      voice_approval_pin_hash: _hash,
      voice_approval_challenge: _legacy,
      ...rest
    } = escalation;
    redactedEscalation = rest;
  }
  return {
    ...settings,
    ...(redactedEscalation ? { escalationSettings: redactedEscalation } : {}),
    voiceApprovalPinEnrolled: enrolled,
  };
}

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
        // WS21a — never echo the money-approval PIN (hash or legacy plaintext).
        res.json(redactSettingsForResponse(result));
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

        res.json(redactSettingsForResponse(result));
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    }
  );

  // ── WS21a — enrolled voice-approval PIN (money-class approvals) ──────────
  // Set/change or clear the spoken PIN that gates money/irreversible VOICE
  // approvals on a caller-ID-recognized owner line. The PIN is hashed
  // (HMAC-SHA256, tenant-salted) server-side and ONLY the hash is stored;
  // the raw PIN is never persisted and never echoed back. Owner-gated: this
  // credential protects money movement, so it sits at the same permission
  // tier as owner_phone (settings:update).
  router.put(
    '/voice-approval-pin',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const { pin } = voiceApprovalPinSchema.parse(req.body ?? {});
        if (!isEnrollablePin(pin)) {
          throw new ValidationError(
            `PIN must be ${MIN_PIN_DIGITS}–${MAX_PIN_DIGITS} digits`,
            { field: 'pin' },
          );
        }
        const secret = resolveVoiceApprovalPinSecret();
        if (!secret) {
          // No server secret configured — refuse rather than store an
          // unhashable (or weakly hashed) credential.
          throw new ValidationError(
            'Voice-approval PIN cannot be set: server encryption key is not configured',
            { field: 'pin' },
          );
        }
        const digits = normalizeEnrollmentPin(pin);
        const hash = hashVoiceApprovalPin(digits, tenantId, secret);

        // Merge into the existing escalation blob (the JSONB write REPLACES
        // the whole object) and drop the deprecated plaintext so exactly one
        // credential — the hash — remains.
        const existing = await ensureTenantSettings(tenantId, settingsRepo);
        const nextEscalation: Partial<EscalationSettings> = {
          ...(existing.escalationSettings ?? {}),
          voice_approval_pin_hash: hash,
        };
        delete nextEscalation.voice_approval_challenge;
        const updated = await updateSettings(
          tenantId,
          { escalationSettings: nextEscalation },
          settingsRepo,
        );
        if (!updated) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Settings not found' });
          return;
        }

        if (auditRepo) {
          await auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'settings.voice_approval_pin.set',
              entityType: 'tenant_settings',
              entityId: updated.id,
              // Never log the PIN or its hash — only that enrollment happened.
              metadata: { enrolled: true },
            }),
          );
        }

        res.status(204).end();
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  router.delete(
    '/voice-approval-pin',
    requireAuth,
    requireTenant,
    requirePermission('settings:update'),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const existing = await getSettings(tenantId, settingsRepo);
        if (!existing) {
          res.status(404).json({ error: 'NOT_FOUND', message: 'Settings not found' });
          return;
        }
        // Remove BOTH the hash and any lingering deprecated plaintext, so a
        // cleared PIN can never fall back to a stale legacy credential. After
        // this, money/irreversible voice approvals refuse with the one-tap SMS.
        const escalation = resolveEscalationSettings(existing);
        const nextEscalation: Partial<EscalationSettings> = { ...escalation };
        delete nextEscalation.voice_approval_pin_hash;
        delete nextEscalation.voice_approval_challenge;
        const updated = await updateSettings(
          tenantId,
          { escalationSettings: nextEscalation },
          settingsRepo,
        );

        if (auditRepo && updated) {
          await auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: req.auth!.userId,
              actorRole: req.auth!.role,
              eventType: 'settings.voice_approval_pin.cleared',
              entityType: 'tenant_settings',
              entityId: updated.id,
              metadata: { enrolled: false },
            }),
          );
        }

        res.status(204).end();
      } catch (err) {
        const { statusCode, body } = toErrorResponse(err);
        res.status(statusCode).json(body);
      }
    },
  );

  return router;
}
