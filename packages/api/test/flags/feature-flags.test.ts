import {
  InMemoryFeatureFlagStore,
  isFeatureEnabled,
} from '../../src/flags/feature-flags';

describe('P0-013 — Feature flags and environment gating', () => {
  it('happy path — flag enabled globally', () => {
    const store = new InMemoryFeatureFlagStore([
      { name: 'new-feature', enabled: true },
    ]);
    expect(isFeatureEnabled(store, 'new-feature', { environment: 'dev' })).toBe(true);
  });

  it('happy path — flag disabled', () => {
    const store = new InMemoryFeatureFlagStore([
      { name: 'new-feature', enabled: false },
    ]);
    expect(isFeatureEnabled(store, 'new-feature', { environment: 'dev' })).toBe(false);
  });

  it('happy path — flag scoped to environments', () => {
    const store = new InMemoryFeatureFlagStore([
      { name: 'beta', enabled: true, environments: ['dev', 'staging'] },
    ]);
    expect(isFeatureEnabled(store, 'beta', { environment: 'dev' })).toBe(true);
    expect(isFeatureEnabled(store, 'beta', { environment: 'prod' })).toBe(false);
  });

  it('happy path — flag scoped to tenants', () => {
    const store = new InMemoryFeatureFlagStore([
      { name: 'pilot', enabled: true, tenantIds: ['tenant-1'] },
    ]);
    expect(isFeatureEnabled(store, 'pilot', { environment: 'prod', tenantId: 'tenant-1' })).toBe(true);
    expect(isFeatureEnabled(store, 'pilot', { environment: 'prod', tenantId: 'tenant-2' })).toBe(false);
  });

  it('validation — unknown flag returns false', () => {
    const store = new InMemoryFeatureFlagStore();
    expect(isFeatureEnabled(store, 'nonexistent', { environment: 'dev' })).toBe(false);
  });

  it('validation — setFlag rejects empty name', () => {
    const store = new InMemoryFeatureFlagStore();
    expect(() => store.setFlag({ name: '', enabled: true })).toThrow('Flag name is required');
  });

  it('happy path — can add and remove flags', () => {
    const store = new InMemoryFeatureFlagStore();
    store.setFlag({ name: 'temp', enabled: true });
    expect(store.getFlag('temp')).toBeDefined();
    store.removeFlag('temp');
    expect(store.getFlag('temp')).toBeUndefined();
  });
});
