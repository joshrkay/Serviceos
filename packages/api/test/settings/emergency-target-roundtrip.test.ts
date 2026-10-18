/**
 * "Pick, don't build" onboarding — `emergency_target` lives in the
 * escalation_settings blob next to `after_hours_voice_mode`. The Call Routing
 * sheet replaces the whole blob on save, and the blob's sub-schema is
 * strip-mode, so a key missing from updateSettingsSchema would be silently
 * dropped on the owner's next save.
 */
import { describe, it, expect } from 'vitest';
import { updateSettingsSchema } from '../../src/shared/contracts';
import { EMERGENCY_TARGETS } from '../../src/settings/settings';

describe('updateSettingsSchema escalationSettings.emergency_target', () => {
  it.each(EMERGENCY_TARGETS)('keeps emergency_target "%s" alongside after_hours_voice_mode', (target) => {
    const parsed = updateSettingsSchema.parse({
      escalationSettings: { after_hours_voice_mode: 'voicemail', emergency_target: target },
    });
    expect(parsed.escalationSettings).toEqual({ after_hours_voice_mode: 'voicemail', emergency_target: target });
  });

  it('rejects an unknown emergency_target instead of storing it', () => {
    expect(updateSettingsSchema.safeParse({ escalationSettings: { emergency_target: 'neighbor' } }).success).toBe(false);
  });

  it('still strips unrelated keys (voice-approval PIN stays unwritable here)', () => {
    const parsed = updateSettingsSchema.parse({
      escalationSettings: { emergency_target: 'owner_cell', voice_approval_pin_hash: 'x' },
    });
    expect(parsed.escalationSettings).toEqual({ emergency_target: 'owner_cell' });
  });
});
