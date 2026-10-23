import type { Pool } from 'pg';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import type { VapiClient } from '../integrations/vapi/client';
import {
  resolveVoicePreset,
  autoGenerateGreeting,
  vapiFirstMessage,
  vapiNoticeLanguage,
  vapiFirstMessageForSettings,
} from '../integrations/vapi/assistant-config';

/**
 * Save the onboarding voice-agent configuration (feature 4).
 *
 * Persists the chosen ElevenLabs preset (voice_id) and greeting to
 * tenant_settings, and — when the tenant already has a Vapi assistant —
 * pushes the new voice + greeting onto that assistant. Greeting precedence:
 * explicit override → auto-generated from business name + services.
 *
 * The Vapi push is best-effort: a Vapi hiccup must not lose the operator's
 * saved preference (it's persisted first), and is retried next time they save.
 */
export interface SaveVoiceConfigDeps {
  pool: Pool;
  auditRepo: AuditRepository;
  /** Injectable; null/absent → skip the assistant push (off-by-default). */
  vapiClient?: VapiClient | null;
}

export interface SaveVoiceConfigInput {
  tenantId: string;
  actorId: string;
  /** Preset id (e.g. 'rachel'). Falls back to the default if unknown. */
  voiceId: string;
  /** Optional greeting override; empty/absent → auto-generate. */
  greeting?: string | null;
}

export interface SaveVoiceConfigResult {
  voiceId: string;
  greeting: string;
  assistantUpdated: boolean;
}

export async function saveVoiceConfig(
  deps: SaveVoiceConfigDeps,
  input: SaveVoiceConfigInput,
): Promise<SaveVoiceConfigResult> {
  const preset = resolveVoicePreset(input.voiceId);

  const settingsRes = await deps.pool.query<{
    business_name: string | null;
    services_offered: string[] | null;
    vapi_assistant_id: string | null;
    default_language: string | null;
  }>(
    `SELECT business_name, services_offered, vapi_assistant_id, default_language
       FROM tenant_settings WHERE tenant_id = $1`,
    [input.tenantId],
  );
  const settings = settingsRes.rows[0];
  const greeting =
    input.greeting && input.greeting.trim()
      ? input.greeting.trim()
      : autoGenerateGreeting(settings?.business_name ?? 'ServiceOS', settings?.services_offered ?? []);

  await deps.pool.query(
    `UPDATE tenant_settings
        SET voice_id = $1, voice_greeting = $2, updated_at = now()
      WHERE tenant_id = $3`,
    [preset.id, greeting, input.tenantId],
  );

  let assistantUpdated = false;
  if (deps.vapiClient && settings?.vapi_assistant_id) {
    try {
      await deps.vapiClient.updateAssistant(settings.vapi_assistant_id, {
        firstMessage: vapiFirstMessage(
          greeting,
          settings.business_name ?? '',
          vapiNoticeLanguage(settings.default_language),
        ),
        voiceId: preset.elevenLabsVoiceId,
      });
      assistantUpdated = true;
    } catch {
      // best-effort — preference already persisted; retried on next save
    }
  }

  await deps.auditRepo.create(
    createAuditEvent({
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorRole: 'owner',
      eventType: 'tenant.voice_config_saved',
      entityType: 'tenant_settings',
      entityId: input.tenantId,
      metadata: { voiceId: preset.id, assistantUpdated, greetingOverridden: Boolean(input.greeting && input.greeting.trim()) },
    }),
  );

  return { voiceId: preset.id, greeting, assistantUpdated };
}

export type VapiFirstMessageRefresh = 'updated' | 'no_assistant' | 'failed';

/**
 * PRIV-4 — re-push an existing assistant's first message after a settings
 * change that alters it without a voice-config save (the tenant's
 * `default_language`, which picks the virtual-assistant notice's language).
 * Only `firstMessage` is written. Best-effort like {@link saveVoiceConfig}:
 * the setting is already persisted, so a Vapi failure is reported to the
 * caller as `'failed'` rather than thrown.
 */
export async function refreshVapiFirstMessage(
  deps: { pool: Pick<Pool, 'query'>; vapiClient: Pick<VapiClient, 'updateAssistant'> },
  tenantId: string,
): Promise<VapiFirstMessageRefresh> {
  const { rows } = await deps.pool.query<{
    vapi_assistant_id: string | null;
    business_name: string | null;
    voice_greeting: string | null;
    services_offered: string[] | null;
    default_language: string | null;
  }>(
    `SELECT vapi_assistant_id, business_name, voice_greeting, services_offered, default_language
       FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  const s = rows[0];
  if (!s?.vapi_assistant_id) return 'no_assistant';
  try {
    await deps.vapiClient.updateAssistant(s.vapi_assistant_id, {
      firstMessage: vapiFirstMessageForSettings({
        businessName: s.business_name,
        greeting: s.voice_greeting,
        services: s.services_offered,
        defaultLanguage: s.default_language,
      }),
    });
    return 'updated';
  } catch {
    return 'failed';
  }
}
