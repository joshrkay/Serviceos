/**
 * #1595 / D-040 — the settings service resolves `after_hours_voice_mode` to
 * 'ai_answering' whenever a tenant has not chosen otherwise. This is the one
 * read every caller of the after-hours fork goes through
 * (`resolveEscalationSettings`), so the default is pinned here at the
 * exported seam rather than on the constant.
 */
import { describe, it, expect } from 'vitest';
import { resolveEscalationSettings, type TenantSettings } from '../../src/settings/settings';

describe('#1595 — after-hours voice mode default (settings service read)', () => {
  it('a tenant with no settings row resolves to ai_answering', () => {
    expect(resolveEscalationSettings(null).after_hours_voice_mode).toBe('ai_answering');
  });

  it('a tenant whose stored escalation blob never set the key resolves to ai_answering', () => {
    // The Call Routing sheet saves the WHOLE blob; a tenant who only
    // unticked the SMS channel has a blob with no after-hours key once
    // migration 304 strips the materialised old default.
    const settings = {
      escalationSettings: { channel_sms: false },
    } as unknown as TenantSettings;

    expect(resolveEscalationSettings(settings).after_hours_voice_mode).toBe('ai_answering');
  });

  it("a tenant who explicitly chose 'voicemail' keeps it", () => {
    const settings = {
      escalationSettings: { after_hours_voice_mode: 'voicemail' },
    } as unknown as TenantSettings;

    expect(resolveEscalationSettings(settings).after_hours_voice_mode).toBe('voicemail');
  });
});
