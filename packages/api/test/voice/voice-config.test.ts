import { describe, it, expect, vi } from 'vitest';
import { saveVoiceConfig } from '../../src/voice/voice-config';
import { resolveVoicePreset } from '../../src/integrations/vapi/assistant-config';

function makePool(settings: { business_name?: string | null; services_offered?: string[] | null; vapi_assistant_id?: string | null }) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/SELECT[\s\S]*FROM tenant_settings/i.test(sql)) {
        return { rows: [{
          business_name: settings.business_name ?? 'Acme HVAC',
          services_offered: settings.services_offered ?? [],
          vapi_assistant_id: settings.vapi_assistant_id ?? null,
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
    const vapiClient = { createAssistant: vi.fn(), updateAssistant: vi.fn(async () => undefined), linkPhoneNumber: vi.fn() };

    const res = await saveVoiceConfig({ pool, auditRepo, vapiClient }, { tenantId: 't1', actorId: 'u1', voiceId: 'adam' });

    expect(res.voiceId).toBe('adam');
    expect(res.greeting).toContain('Thanks for calling Acme HVAC');
    expect(res.assistantUpdated).toBe(true);
    // tenant_settings updated with the preset id + greeting
    expect(updates[0].params).toEqual(['adam', res.greeting, 't1']);
    // assistant updated with the elevenlabs voice id for the preset
    expect(vapiClient.updateAssistant).toHaveBeenCalledWith('asst_1', {
      firstMessage: res.greeting,
      voiceId: resolveVoicePreset('adam').elevenLabsVoiceId,
    });
  });

  it('honors an explicit greeting override', async () => {
    const { pool } = makePool({ vapi_assistant_id: 'asst_1' });
    const vapiClient = { createAssistant: vi.fn(), updateAssistant: vi.fn(async () => undefined), linkPhoneNumber: vi.fn() };
    const res = await saveVoiceConfig({ pool, auditRepo, vapiClient }, { tenantId: 't1', actorId: 'u1', voiceId: 'rachel', greeting: 'Hi, Acme here!' });
    expect(res.greeting).toBe('Hi, Acme here!');
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
