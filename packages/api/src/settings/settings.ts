import { v4 as uuidv4 } from 'uuid';
import { ValidationError } from '../shared/errors';

import { isValidTimezone } from '../shared/timezone';

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

export interface ActiveVerticalPackValidationOptions {
  normalizePackId?: (packId: string) => string;
  isKnownPackId?: (packId: string) => boolean;
  knownPackIds?: string[];
}

export const VALID_TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'America/Detroit',
  'America/Indiana/Indianapolis', 'America/Boise', 'UTC',
];

export function validateSettingsInput(
  input: CreateSettingsInput,
  options?: ActiveVerticalPackValidationOptions
): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.businessName) errors.push('businessName is required');
  errors.push(...validateCommonSettingsFields(input));
  errors.push(...validateActiveVerticalPacks(input.activeVerticalPacks, options));
  return errors;
}

export function validateUpdateSettingsInput(
  input: UpdateSettingsInput,
  options?: ActiveVerticalPackValidationOptions
): string[] {
  const errors: string[] = [];
  errors.push(...validateCommonSettingsFields(input));
  errors.push(...validateActiveVerticalPacks(input.activeVerticalPacks, options));
  return errors;
}

function validateCommonSettingsFields(
  input: Pick<CreateSettingsInput, 'timezone' | 'estimatePrefix' | 'invoicePrefix' | 'defaultPaymentTermDays'>
): string[] {
  const errors: string[] = [];
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

export function normalizePackId(packId: string): string {
  return packId.trim().toLowerCase();
}

export function normalizeActiveVerticalPacks(
  activeVerticalPacks?: string[],
  normalizeFn: (packId: string) => string = normalizePackId
): string[] | undefined {
  if (!Array.isArray(activeVerticalPacks)) {
    return undefined;
  }

  return activeVerticalPacks.map((packId) => normalizeFn(packId));
}

function validateActiveVerticalPacks(
  activeVerticalPacks?: string[],
  options?: ActiveVerticalPackValidationOptions
): string[] {
  const errors: string[] = [];
  if (activeVerticalPacks === undefined) {
    return errors;
  }

  if (!Array.isArray(activeVerticalPacks)) {
    errors.push('activeVerticalPacks must be an array');
    return errors;
  }

  const normalizeFn = options?.normalizePackId ?? normalizePackId;
  const normalizedKnownPackIds = options?.knownPackIds
    ? new Set(options.knownPackIds.map((id) => normalizeFn(id)))
    : undefined;
  const seen = new Set<string>();

  for (let i = 0; i < activeVerticalPacks.length; i += 1) {
    const value = activeVerticalPacks[i];
    if (typeof value !== 'string') {
      errors.push(`activeVerticalPacks[${i}] must be a string`);
      continue;
    }

    const normalized = normalizeFn(value);
    if (normalized.length === 0) {
      errors.push(`activeVerticalPacks[${i}] must be a non-empty string`);
      continue;
    }

    if (seen.has(normalized)) {
      errors.push(`activeVerticalPacks contains duplicate pack ID: ${normalized}`);
      continue;
    }
    seen.add(normalized);

    if (normalizedKnownPackIds && !normalizedKnownPackIds.has(normalized)) {
      errors.push(`activeVerticalPacks contains unknown pack ID: ${normalized}`);
      continue;
    }

    if (options?.isKnownPackId && !options.isKnownPackId(normalized)) {
      errors.push(`activeVerticalPacks contains unknown pack ID: ${normalized}`);
    }
  }

  return errors;
}

export async function createSettings(
  input: CreateSettingsInput,
  repository: SettingsRepository,
  options?: ActiveVerticalPackValidationOptions
): Promise<TenantSettings> {
  const errors = validateSettingsInput({
    ...input,
    activeVerticalPacks: normalizeActiveVerticalPacks(
      input.activeVerticalPacks,
      options?.normalizePackId ?? normalizePackId
    ),
  }, options);
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.join('; ')}`);
  }

  const existing = await repository.findByTenant(input.tenantId);
  if (existing) {
    throw new ValidationError('Settings already exist for this tenant');
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
    activeVerticalPacks: normalizeActiveVerticalPacks(
      input.activeVerticalPacks,
      options?.normalizePackId ?? normalizePackId
    ),
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
  repository: SettingsRepository,
  options?: ActiveVerticalPackValidationOptions
): Promise<TenantSettings | null> {
  const normalizedInput: UpdateSettingsInput = {
    ...input,
    activeVerticalPacks: normalizeActiveVerticalPacks(
      input.activeVerticalPacks,
      options?.normalizePackId ?? normalizePackId
    ),
  };
  const errors = validateUpdateSettingsInput(normalizedInput, options);
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.join('; ')}`);
  }

  return repository.update(tenantId, { ...normalizedInput, updatedAt: new Date() });
}

export async function getNextEstimateNumber(
  tenantId: string,
  repository: SettingsRepository
): Promise<string> {
  const settings = await repository.findByTenant(tenantId);
  if (!settings) throw new ValidationError('Tenant settings not found');
  const num = await repository.incrementEstimateNumber(tenantId);
  // padStart(4, '0') pads numbers under 10000; larger numbers naturally produce wider strings
  return `${settings.estimatePrefix}${String(num).padStart(4, '0')}`;
}

export async function getNextInvoiceNumber(
  tenantId: string,
  repository: SettingsRepository
): Promise<string> {
  const settings = await repository.findByTenant(tenantId);
  if (!settings) throw new ValidationError('Tenant settings not found');
  const num = await repository.incrementInvoiceNumber(tenantId);
  // padStart(4, '0') pads numbers under 10000; larger numbers naturally produce wider strings
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
    if (!s) throw new ValidationError('Settings not found');
    const num = s.nextEstimateNumber;
    s.nextEstimateNumber += 1;
    this.settings.set(tenantId, s);
    return num;
  }

  async incrementInvoiceNumber(tenantId: string): Promise<number> {
    const s = this.settings.get(tenantId);
    if (!s) throw new ValidationError('Settings not found');
    const num = s.nextInvoiceNumber;
    s.nextInvoiceNumber += 1;
    this.settings.set(tenantId, s);
    return num;
  }
}
