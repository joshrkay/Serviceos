/**
 * UB-D / D-015 (D1) — autonomous booking lane settings (migration 231):
 * autonomous_booking_enabled / autonomous_booking_threshold round-trip
 * through the settings service layer, the threshold is bounds-checked
 * (0.90–0.99, mirroring the DB CHECK), and the PUT /api/settings contract
 * (updateSettingsSchema) accepts/rejects the right shapes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSettings,
  updateSettings,
  InMemorySettingsRepository,
} from '../../src/settings/settings';
import { updateSettingsSchema } from '../../src/shared/contracts';

const TENANT = 'tenant-autonomous';

describe('autonomous booking settings persistence (UB-D / D-015)', () => {
  let repo: InMemorySettingsRepository;

  beforeEach(async () => {
    repo = new InMemorySettingsRepository();
    await createSettings({ tenantId: TENANT, businessName: 'ACME HVAC' }, repo);
  });

  it('defaults to lane-off for rows that never set the fields (pre-migration shape)', async () => {
    const settings = await repo.findByTenant(TENANT);
    // The lane resolver gates on `enabled === true`, so undefined = off.
    expect(settings?.autonomousBookingEnabled).not.toBe(true);
  });

  it('round-trips enabled + threshold through updateSettings', async () => {
    const updated = await updateSettings(
      TENANT,
      { autonomousBookingEnabled: true, autonomousBookingThreshold: 0.97 },
      repo,
    );
    expect(updated?.autonomousBookingEnabled).toBe(true);
    expect(updated?.autonomousBookingThreshold).toBe(0.97);

    const off = await updateSettings(TENANT, { autonomousBookingEnabled: false }, repo);
    expect(off?.autonomousBookingEnabled).toBe(false);
    expect(off?.autonomousBookingThreshold).toBe(0.97); // untouched fields persist
  });

  it('rejects an out-of-bounds threshold at the service layer (DB CHECK mirror)', async () => {
    await expect(
      updateSettings(TENANT, { autonomousBookingThreshold: 0.89 }, repo),
    ).rejects.toThrow(/autonomousBookingThreshold/);
    await expect(
      updateSettings(TENANT, { autonomousBookingThreshold: 1.0 }, repo),
    ).rejects.toThrow(/autonomousBookingThreshold/);
    await expect(
      updateSettings(TENANT, { autonomousBookingThreshold: Number.NaN }, repo),
    ).rejects.toThrow(/autonomousBookingThreshold/);
  });

  it('accepts the exact bounds (0.90 and 0.99)', async () => {
    const low = await updateSettings(TENANT, { autonomousBookingThreshold: 0.9 }, repo);
    expect(low?.autonomousBookingThreshold).toBe(0.9);
    const high = await updateSettings(TENANT, { autonomousBookingThreshold: 0.99 }, repo);
    expect(high?.autonomousBookingThreshold).toBe(0.99);
  });
});

describe('PUT /api/settings contract (updateSettingsSchema) — autonomous booking', () => {
  it('accepts the lane fields', () => {
    const parsed = updateSettingsSchema.parse({
      autonomousBookingEnabled: true,
      autonomousBookingThreshold: 0.95,
    });
    expect(parsed.autonomousBookingEnabled).toBe(true);
    expect(parsed.autonomousBookingThreshold).toBe(0.95);
  });

  it('accepts a payload that omits the lane fields (untouched)', () => {
    const parsed = updateSettingsSchema.parse({ businessName: 'X' });
    expect(parsed.autonomousBookingEnabled).toBeUndefined();
    expect(parsed.autonomousBookingThreshold).toBeUndefined();
  });

  it('rejects out-of-bounds thresholds and non-boolean enabled', () => {
    expect(() => updateSettingsSchema.parse({ autonomousBookingThreshold: 0.85 })).toThrow();
    expect(() => updateSettingsSchema.parse({ autonomousBookingThreshold: 1 })).toThrow();
    expect(() => updateSettingsSchema.parse({ autonomousBookingThreshold: '0.95' })).toThrow();
    expect(() => updateSettingsSchema.parse({ autonomousBookingEnabled: 'yes' })).toThrow();
  });
});
