import { describe, it, expect, vi } from 'vitest';
import { saveVoiceConfig, refreshVapiFirstMessage } from '../../src/voice/voice-config';
import { resolveVoicePreset } from '../../src/integrations/vapi/assistant-config';

function makePool(settings: { business_name?: string | null; services_offered?: string[] | null; vapi_assistant_id?: string | null; default_language?: string | null }) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/SELECT[\s\S]*FROM tenant_settings/i.test(sql)) {
        return { rows: [{
          business_name: settings.business_name ?? 'Acme HVAC',
          services_offered: settings.services_offered ?? [],
          vapi_assistant_id: settings.vapi_assistant_id ?? null,
          default_language: settings.default_language ?? 'en',
        }] };
      }
      if (/UPDATE tenant_settings/i.test(sql)) {
        updates.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    }),
  };
  return { pool: pool as never, updates };
}

const auditRepo = { create: vi.fn(async () => undefined) } as never;

describe('saveVoiceConfig', () => {
  it('persists the preset + auto-greeting and pushes them to the Vapi assistant', async () => {
    const { pool, updates } = makePool({ business_name: 'Acme HVAC', services_offered: ['heating'], vapi_assistant_id: 'asst_1' });
    const vapiClient = { createAssistant: vi.fn(), updateAssistant: vi.fn(async () => undefined), linkPhoneNumber: vi.fn(), deletePhoneNumber: vi.fn() };

    const res = await saveVoiceConfig({ pool, auditRepo, vapiClient }, { tenantId: 't1', actorId: 'u1', voiceId: 'adam' });

    expect(res.voiceId).toBe('adam');
    expect(res.greeting).toContain('Thanks for calling Acme HVAC');
    expect(res.assistantUpdated).toBe(true);
    // tenant_settings updated with the preset id + greeting
    expect(updates[0].params).toEqual(['adam', res.greeting, 't1']);
    // assistant updated with the elevenlabs voice id for the preset
    // PRIV-4 — the Vapi first message carries the virtual-assistant notice;
    // the stored greeting does not (the phone path appends its own).
    expect(vapiClient.updateAssistant).toHaveBeenCalledWith('asst_1', {
      firstMessage: `${res.greeting} Just so you know, I'm a virtual assistant, not a live person.`,
      voiceId: resolveVoicePreset('adam').elevenLabsVoiceId,
    });
  });

  it('honors an explicit greeting override, and the Vapi first message adds the notice after it', async () => {
    const { pool, updates } = makePool({ vapi_assistant_id: 'asst_1' });
    const vapiClient = { createAssistant: vi.fn(), updateAssistant: vi.fn(async () => undefined), linkPhoneNumber: vi.fn(), deletePhoneNumber: vi.fn() };
    const res = await saveVoiceConfig({ pool, auditRepo, vapiClient }, { tenantId: 't1', actorId: 'u1', voiceId: 'rachel', greeting: 'Hi, Acme here!' });
    expect(res.greeting).toBe('Hi, Acme here!');
    expect(updates[0].params).toEqual(['rachel', 'Hi, Acme here!', 't1']);
    expect(vapiClient.updateAssistant).toHaveBeenCalledWith('asst_1', {
      firstMessage: "Hi, Acme here! Just so you know, I'm a virtual assistant, not a live person.",
      voiceId: resolveVoicePreset('rachel').elevenLabsVoiceId,
    });
  });

  it("pushes the Spanish notice for a Spanish tenant", async () => {
    const { pool } = makePool({ vapi_assistant_id: 'asst_1', default_language: 'es' });
    const vapiClient = { createAssistant: vi.fn(), updateAssistant: vi.fn(async () => undefined), linkPhoneNumber: vi.fn(), deletePhoneNumber: vi.fn() };
    await saveVoiceConfig({ pool, auditRepo, vapiClient }, { tenantId: 't1', actorId: 'u1', voiceId: 'rachel', greeting: 'Gracias por llamar.' });
    expect(vapiClient.updateAssistant).toHaveBeenCalledWith('asst_1', {
      firstMessage: 'Gracias por llamar. Para que lo sepa, soy un asistente virtual, no una persona real.',
      voiceId: resolveVoicePreset('rachel').elevenLabsVoiceId,
    });
  });

  it('persists the preference even when no Vapi assistant exists yet (no push)', async () => {
    const { pool } = makePool({ vapi_assistant_id: null });
    const res = await saveVoiceConfig({ pool, auditRepo, vapiClient: null }, { tenantId: 't1', actorId: 'u1', voiceId: 'bella' });
    expect(res.voiceId).toBe('bella');
    expect(res.assistantUpdated).toBe(false);
  });

  it('falls back to the default preset for an unknown voice id', async () => {
    const { pool, updates } = makePool({});
    const res = await saveVoiceConfig({ pool, auditRepo }, { tenantId: 't1', actorId: 'u1', voiceId: 'nope' });
    expect(res.voiceId).toBe('rachel');
    expect(updates[0].params[0]).toBe('rachel');
  });
});

describe('refreshVapiFirstMessage (PRIV-4 language change)', () => {
  function settingsPool(row: Record<string, unknown> | undefined) {
    return { query: vi.fn(async () => ({ rows: row ? [row] : [] })) } as never;
  }
  const spanish = {
    vapi_assistant_id: 'asst_1',
    business_name: 'Acme HVAC',
    voice_greeting: null,
    services_offered: ['heating'],
    default_language: 'es',
  };

  it('pushes only the first message, rebuilt in the new language', async () => {
    const updateAssistant = vi.fn(async () => undefined);
    const outcome = await refreshVapiFirstMessage({ pool: settingsPool(spanish), vapiClient: { updateAssistant } }, 't1');
    expect(outcome).toBe('updated');
    expect(updateAssistant).toHaveBeenCalledWith('asst_1', {
      firstMessage:
        'Thanks for calling Acme HVAC. We handle heating. How can I help you today? Para que lo sepa, soy un asistente virtual, no una persona real.',
    });
  });

  it('does nothing for a tenant without an assistant', async () => {
    const updateAssistant = vi.fn(async () => undefined);
    const noAssistant = { ...spanish, vapi_assistant_id: null };
    expect(await refreshVapiFirstMessage({ pool: settingsPool(noAssistant), vapiClient: { updateAssistant } }, 't1')).toBe('no_assistant');
    expect(await refreshVapiFirstMessage({ pool: settingsPool(undefined), vapiClient: { updateAssistant } }, 't1')).toBe('no_assistant');
    expect(updateAssistant).not.toHaveBeenCalled();
  });

  it('reports a Vapi failure instead of throwing', async () => {
    const updateAssistant = vi.fn(async () => {
      throw new Error('vapi 503');
    });
    expect(await refreshVapiFirstMessage({ pool: settingsPool(spanish), vapiClient: { updateAssistant } }, 't1')).toBe('failed');
  });
});
