import { v4 as uuidv4 } from 'uuid';

export interface TenantSettings {
  id: string;
  tenantId: string;
  businessName: string;
  businessPhone?: string;
  businessEmail?: string;
  timezone: string;
  estimatePrefix: string;
  invoicePrefix: string;
  nextEstimateNumber: number;
  nextInvoiceNumber: number;
  defaultPaymentTermDays: number;
  terminologyPreferences?: Record<string, string>;
  activeVerticalPacks?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSettingsInput {
  tenantId: string;
  businessName: string;
  businessPhone?: string;
  businessEmail?: string;
  timezone?: string;
  estimatePrefix?: string;
  invoicePrefix?: string;
  defaultPaymentTermDays?: number;
  terminologyPreferences?: Record<string, string>;
  activeVerticalPacks?: string[];
}

export interface UpdateSettingsInput {
  businessName?: string;
  businessPhone?: string;
  businessEmail?: string;
  timezone?: string;
  estimatePrefix?: string;
  invoicePrefix?: string;
  defaultPaymentTermDays?: number;
  terminologyPreferences?: Record<string, string>;
  activeVerticalPacks?: string[];
}

export interface SettingsRepository {
  create(settings: TenantSettings): Promise<TenantSettings>;
  findByTenant(tenantId: string): Promise<TenantSettings | null>;
  update(tenantId: string, updates: Partial<TenantSettings>): Promise<TenantSettings | null>;
  incrementEstimateNumber(tenantId: string): Promise<number>;
  incrementInvoiceNumber(tenantId: string): Promise<number>;
}

const VALID_TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'America/Detroit',
  'America/Indiana/Indianapolis', 'America/Boise', 'UTC',
];

export function validateSettingsInput(input: CreateSettingsInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.businessName) errors.push('businessName is required');
  if (input.timezone && !VALID_TIMEZONES.includes(input.timezone)) {
    errors.push('Invalid timezone');
  }
  if (input.estimatePrefix !== undefined && input.estimatePrefix.length === 0) {
    errors.push('estimatePrefix cannot be empty');
  }
  if (input.invoicePrefix !== undefined && input.invoicePrefix.length === 0) {
    errors.push('invoicePrefix cannot be empty');
  }
  if (input.defaultPaymentTermDays !== undefined && input.defaultPaymentTermDays < 0) {
    errors.push('defaultPaymentTermDays must be non-negative');
  }
  return errors;
}

export async function createSettings(
  input: CreateSettingsInput,
  repository: SettingsRepository
): Promise<TenantSettings> {
  const existing = await repository.findByTenant(input.tenantId);
  if (existing) {
    throw new Error('Settings already exist for this tenant');
  }

  const settings: TenantSettings = {
    id: uuidv4(),
    tenantId: input.tenantId,
    businessName: input.businessName,
    businessPhone: input.businessPhone,
    businessEmail: input.businessEmail,
    timezone: input.timezone || 'America/New_York',
    estimatePrefix: input.estimatePrefix || 'EST-',
    invoicePrefix: input.invoicePrefix || 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: input.defaultPaymentTermDays ?? 30,
    terminologyPreferences: input.terminologyPreferences,
    activeVerticalPacks: input.activeVerticalPacks,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return repository.create(settings);
}

export async function getSettings(
  tenantId: string,
  repository: SettingsRepository
): Promise<TenantSettings | null> {
  return repository.findByTenant(tenantId);
}

export async function updateSettings(
  tenantId: string,
  input: UpdateSettingsInput,
  repository: SettingsRepository
): Promise<TenantSettings | null> {
  return repository.update(tenantId, { ...input, updatedAt: new Date() });
}

export async function getNextEstimateNumber(
  tenantId: string,
  repository: SettingsRepository
): Promise<string> {
  const settings = await repository.findByTenant(tenantId);
  if (!settings) throw new Error('Tenant settings not found');
  const num = await repository.incrementEstimateNumber(tenantId);
  return `${settings.estimatePrefix}${String(num).padStart(4, '0')}`;
}

export async function getNextInvoiceNumber(
  tenantId: string,
  repository: SettingsRepository
): Promise<string> {
  const settings = await repository.findByTenant(tenantId);
  if (!settings) throw new Error('Tenant settings not found');
  const num = await repository.incrementInvoiceNumber(tenantId);
  return `${settings.invoicePrefix}${String(num).padStart(4, '0')}`;
}

export function validateTerminologyPreferences(
  preferences: Record<string, string>,
  validKeys?: string[]
): string[] {
  const errors: string[] = [];
  if (!preferences || typeof preferences !== 'object') {
    errors.push('terminologyPreferences must be an object');
    return errors;
  }
  for (const [key, value] of Object.entries(preferences)) {
    if (!key || key.trim().length === 0) {
      errors.push('terminologyPreferences key must not be empty');
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`terminologyPreferences value for "${key}" must be a non-empty string`);
    }
    if (validKeys && !validKeys.includes(key)) {
      errors.push(`terminologyPreferences key "${key}" is not a recognized term for the active vertical`);
    }
  }
  return errors;
}

export async function updateTerminologyPreferences(
  tenantId: string,
  preferences: Record<string, string>,
  repository: SettingsRepository
): Promise<TenantSettings | null> {
  return repository.update(tenantId, {
    terminologyPreferences: preferences,
    updatedAt: new Date(),
  });
}

export class InMemorySettingsRepository implements SettingsRepository {
  private settings: Map<string, TenantSettings> = new Map();

  async create(settings: TenantSettings): Promise<TenantSettings> {
    this.settings.set(settings.tenantId, { ...settings });
    return { ...settings };
  }

  async findByTenant(tenantId: string): Promise<TenantSettings | null> {
    const s = this.settings.get(tenantId);
    return s ? { ...s } : null;
  }

  async update(tenantId: string, updates: Partial<TenantSettings>): Promise<TenantSettings | null> {
    const s = this.settings.get(tenantId);
    if (!s) return null;
    const { id: _id, tenantId: _tid, createdAt: _ca, ...safeUpdates } = updates;
    const updated = { ...s, ...safeUpdates };
    this.settings.set(tenantId, updated);
    return { ...updated };
  }

  async incrementEstimateNumber(tenantId: string): Promise<number> {
    const s = this.settings.get(tenantId);
    if (!s) throw new Error('Settings not found');
    const num = s.nextEstimateNumber;
    s.nextEstimateNumber += 1;
    this.settings.set(tenantId, s);
    return num;
  }

  async incrementInvoiceNumber(tenantId: string): Promise<number> {
    const s = this.settings.get(tenantId);
    if (!s) throw new Error('Settings not found');
    const num = s.nextInvoiceNumber;
    s.nextInvoiceNumber += 1;
    this.settings.set(tenantId, s);
    return num;
  }
}
