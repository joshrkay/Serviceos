/**
 * RV-063 — digest delivery settings (migration 163):
 * digest_enabled / digest_time / digest_channel round-trip through the
 * settings repo + service layer, and the PUT /api/settings contract
 * (updateSettingsSchema) accepts/rejects the right shapes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSettings,
  updateSettings,
  InMemorySettingsRepository,
  DIGEST_CHANNEL_VALUES,
  DIGEST_TIME_RE,
} from '../../src/settings/settings';
import { updateSettingsSchema } from '../../src/shared/contracts';

const TENANT = 'tenant-digest';

describe('digest settings persistence (RV-063)', () => {
  let repo: InMemorySettingsRepository;

  beforeEach(async () => {
    repo = new InMemorySettingsRepository();
    await createSettings({ tenantId: TENANT, businessName: 'ACME HVAC' }, repo);
  });

  it('defaults to digest-off for rows that never set the fields (pre-migration shape)', async () => {
    const settings = await repo.findByTenant(TENANT);
    // The worker gates on `digestEnabled === true`, so undefined = off.
    expect(settings?.digestEnabled).not.toBe(true);
  });

  it('round-trips digestEnabled / digestTime / digestChannel through updateSettings', async () => {
    const updated = await updateSettings(
      TENANT,
      { digestEnabled: true, digestTime: '19:30', digestChannel: 'sms' },
      repo,
    );
    expect(updated?.digestEnabled).toBe(true);
    expect(updated?.digestTime).toBe('19:30');
    expect(updated?.digestChannel).toBe('sms');

    const off = await updateSettings(TENANT, { digestChannel: 'none' }, repo);
    expect(off?.digestChannel).toBe('none');
    expect(off?.digestEnabled).toBe(true); // untouched fields persist
  });

  it('rejects a malformed digestTime at the service layer', async () => {
    await expect(
      updateSettings(TENANT, { digestTime: '25:00' }, repo),
    ).rejects.toThrow(/digestTime/);
    await expect(
      updateSettings(TENANT, { digestTime: '6pm' }, repo),
    ).rejects.toThrow(/digestTime/);
  });

  it('rejects an unknown digestChannel at the service layer', async () => {
    await expect(
      updateSettings(TENANT, { digestChannel: 'email' as never }, repo),
    ).rejects.toThrow(/digestChannel/);
  });

  it('locks the channel vocabulary', () => {
    expect(DIGEST_CHANNEL_VALUES).toEqual(['sms', 'none']);
    expect(DIGEST_TIME_RE.test('18:00')).toBe(true);
    expect(DIGEST_TIME_RE.test('23:59')).toBe(true);
    expect(DIGEST_TIME_RE.test('24:00')).toBe(false);
  });
});

describe('PUT /api/settings contract (updateSettingsSchema)', () => {
  it('accepts the digest fields', () => {
    const parsed = updateSettingsSchema.parse({
      digestEnabled: true,
      digestTime: '07:15',
      digestChannel: 'none',
    });
    expect(parsed.digestEnabled).toBe(true);
    expect(parsed.digestTime).toBe('07:15');
    expect(parsed.digestChannel).toBe('none');
  });

  it('accepts a payload that omits digest fields (untouched)', () => {
    const parsed = updateSettingsSchema.parse({ businessName: 'X' });
    expect(parsed.digestEnabled).toBeUndefined();
    expect(parsed.digestTime).toBeUndefined();
    expect(parsed.digestChannel).toBeUndefined();
  });

  it('rejects malformed digestTime and unknown channel values', () => {
    expect(() => updateSettingsSchema.parse({ digestTime: '6pm' })).toThrow();
    expect(() => updateSettingsSchema.parse({ digestTime: '24:00' })).toThrow();
    expect(() => updateSettingsSchema.parse({ digestChannel: 'email' })).toThrow();
    expect(() => updateSettingsSchema.parse({ digestEnabled: 'yes' })).toThrow();
  });
});
