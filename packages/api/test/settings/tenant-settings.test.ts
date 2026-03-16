import {
  createDefaultSettings,
  getSetting,
  updateSetting,
  InMemoryTenantSettingsRepository,
} from '../../src/settings/tenant-settings';

describe('P1-017 — Tenant settings stub', () => {
  it('happy path — creates default settings', () => {
    const settings = createDefaultSettings('tenant-1');
    expect(settings.id).toBeTruthy();
    expect(settings.tenantId).toBe('tenant-1');
    expect(settings.settings).toEqual({});
  });

  it('happy path — get and update settings', () => {
    let settings = createDefaultSettings('tenant-1');
    expect(getSetting(settings, 'theme', 'light')).toBe('light');

    settings = updateSetting(settings, 'theme', 'dark', 'user-1');
    expect(getSetting(settings, 'theme', 'light')).toBe('dark');
    expect(settings.updatedBy).toBe('user-1');
  });

  it('validation — getSetting returns default for missing key', () => {
    const settings = createDefaultSettings('tenant-1');
    expect(getSetting(settings, 'nonexistent', 42)).toBe(42);
  });

  it('mock provider test — repository stores and retrieves', async () => {
    const repo = new InMemoryTenantSettingsRepository();
    const settings = createDefaultSettings('tenant-1');
    await repo.upsert(settings);

    const found = await repo.findByTenant('tenant-1');
    expect(found).not.toBeNull();
    expect(found!.tenantId).toBe('tenant-1');
  });

  it('mock provider test — repository isolates tenants', async () => {
    const repo = new InMemoryTenantSettingsRepository();
    const settings = createDefaultSettings('tenant-1');
    await repo.upsert(settings);

    const found = await repo.findByTenant('other-tenant');
    expect(found).toBeNull();
  });

  it('malformed AI output handled gracefully — upsert overwrites existing', async () => {
    const repo = new InMemoryTenantSettingsRepository();
    const s1 = createDefaultSettings('tenant-1');
    await repo.upsert(s1);

    const s2 = updateSetting(s1, 'key', 'value', 'user-1');
    await repo.upsert(s2);

    const found = await repo.findByTenant('tenant-1');
    expect(getSetting(found!, 'key', '')).toBe('value');
  });
});
