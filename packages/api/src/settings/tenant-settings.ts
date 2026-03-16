import { v4 as uuidv4 } from 'uuid';

export interface TenantSettings {
  id: string;
  tenantId: string;
  settings: Record<string, unknown>;
  updatedAt: Date;
  updatedBy: string;
}

export interface TenantSettingsRepository {
  findByTenant(tenantId: string): Promise<TenantSettings | null>;
  upsert(settings: TenantSettings): Promise<TenantSettings>;
}

export function createDefaultSettings(tenantId: string, updatedBy: string = 'system'): TenantSettings {
  return {
    id: uuidv4(),
    tenantId,
    settings: {},
    updatedAt: new Date(),
    updatedBy,
  };
}

export function getSetting<T>(settings: TenantSettings, key: string, defaultValue: T): T {
  const value = settings.settings[key];
  if (value === undefined) return defaultValue;
  return value as T;
}

export function updateSetting(settings: TenantSettings, key: string, value: unknown, updatedBy: string): TenantSettings {
  return {
    ...settings,
    settings: { ...settings.settings, [key]: value },
    updatedAt: new Date(),
    updatedBy,
  };
}

export class InMemoryTenantSettingsRepository implements TenantSettingsRepository {
  private store: Map<string, TenantSettings> = new Map();

  async findByTenant(tenantId: string): Promise<TenantSettings | null> {
    for (const s of this.store.values()) {
      if (s.tenantId === tenantId) return { ...s };
    }
    return null;
  }

  async upsert(settings: TenantSettings): Promise<TenantSettings> {
    this.store.set(settings.id, { ...settings });
    return { ...settings };
  }
}
