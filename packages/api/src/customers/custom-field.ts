import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';

/**
 * U2 (CRM Jobber parity) — tenant-defined custom fields on customers.
 *
 * A def/value split (rather than a JSONB blob on `customers`) keeps fields
 * typed, enumerable for the editor UI, and segmentable. The field type drives
 * value validation: `number` must parse, `date` must be ISO (YYYY-MM-DD), and
 * `select` must be one of the def's options. Mirrors the customer domain shape
 * (port interface + pure functions + in-memory repo); Pg impl in
 * `pg-custom-field.ts`.
 */

export type CustomFieldType = 'text' | 'number' | 'date' | 'select';

export const CUSTOM_FIELD_TYPES: readonly CustomFieldType[] = ['text', 'number', 'date', 'select'];

export interface CustomFieldDef {
  id: string;
  tenantId: string;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[];
  sortOrder: number;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomFieldValueRow {
  fieldDefId: string;
  value: string | null;
}

/** A value joined to its (active) def — the shape the editor UI consumes. */
export interface ResolvedCustomFieldValue {
  fieldDefId: string;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[];
  value: string | null;
}

export interface CreateCustomFieldDefInput {
  tenantId: string;
  key: string;
  label: string;
  fieldType?: CustomFieldType;
  options?: string[];
  sortOrder?: number;
  createdBy: string;
  actorRole?: string;
}

export interface CustomFieldRepository {
  createDef(def: CustomFieldDef): Promise<CustomFieldDef>;
  findDefById(tenantId: string, id: string): Promise<CustomFieldDef | null>;
  findDefByKey(tenantId: string, key: string): Promise<CustomFieldDef | null>;
  listDefs(tenantId: string, includeArchived?: boolean): Promise<CustomFieldDef[]>;
  archiveDef(tenantId: string, id: string): Promise<CustomFieldDef | null>;
  /** Upsert a single value (delete the row when value is null/empty). */
  setValue(tenantId: string, customerId: string, fieldDefId: string, value: string | null): Promise<void>;
  listValues(tenantId: string, customerId: string): Promise<CustomFieldValueRow[]>;
}

/** Field key: lowercase letters/digits/underscore, must start with a letter. */
export function isValidFieldKey(key: string): boolean {
  return /^[a-z][a-z0-9_]{0,49}$/.test(key);
}

export function validateCustomFieldDef(input: {
  key?: string;
  label?: string;
  fieldType?: string;
  options?: string[];
}): string[] {
  const errors: string[] = [];
  if (!input.key || !isValidFieldKey(input.key)) {
    errors.push('key must be lowercase alphanumeric/underscore, starting with a letter');
  }
  if (!input.label || !input.label.trim()) errors.push('label is required');
  if (input.fieldType && !CUSTOM_FIELD_TYPES.includes(input.fieldType as CustomFieldType)) {
    errors.push('Invalid fieldType');
  }
  if (input.fieldType === 'select' && (!input.options || input.options.length === 0)) {
    errors.push('select fields require at least one option');
  }
  return errors;
}

/**
 * Validate a raw string value against a def's type. Returns an error message
 * or null. An empty/blank value clears the field and is always allowed.
 */
export function validateCustomFieldValue(def: CustomFieldDef, value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  switch (def.fieldType) {
    case 'number':
      return Number.isFinite(Number(value)) ? null : `"${def.label}" must be a number`;
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
        ? null
        : `"${def.label}" must be a date (YYYY-MM-DD)`;
    case 'select':
      return def.options.includes(value) ? null : `"${value}" is not a valid option for "${def.label}"`;
    case 'text':
    default:
      return null;
  }
}

export async function createCustomFieldDef(
  input: CreateCustomFieldDefInput,
  repository: CustomFieldRepository,
  auditRepo?: AuditRepository
): Promise<CustomFieldDef> {
  const errors = validateCustomFieldDef(input);
  if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(', ')}`);

  const existing = await repository.findDefByKey(input.tenantId, input.key);
  if (existing) throw new Error(`A custom field with key "${input.key}" already exists`);

  const now = new Date();
  const def: CustomFieldDef = {
    id: uuidv4(),
    tenantId: input.tenantId,
    key: input.key,
    label: input.label.trim(),
    fieldType: input.fieldType ?? 'text',
    options: input.fieldType === 'select' ? input.options ?? [] : [],
    sortOrder: input.sortOrder ?? 0,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };
  const created = await repository.createDef(def);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: input.actorRole ?? 'unknown',
        eventType: 'customer_custom_field.created',
        entityType: 'customer_custom_field_def',
        entityId: created.id,
        metadata: { key: created.key, fieldType: created.fieldType },
      })
    );
  }
  return created;
}

export async function setCustomFieldValue(
  tenantId: string,
  customerId: string,
  fieldDefId: string,
  value: string | null,
  repository: CustomFieldRepository,
  actorId?: string,
  auditRepo?: AuditRepository
): Promise<void> {
  const def = await repository.findDefById(tenantId, fieldDefId);
  if (!def) throw new Error('Custom field definition not found');
  if (def.isArchived) throw new Error('Cannot set a value on an archived custom field');

  const validationError = validateCustomFieldValue(def, value);
  if (validationError) throw new Error(`Validation failed: ${validationError}`);

  const normalized = value === null || value.trim() === '' ? null : value.trim();
  await repository.setValue(tenantId, customerId, fieldDefId, normalized);

  if (auditRepo && actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: 'unknown',
        eventType: 'customer_custom_field.value_set',
        entityType: 'customer',
        entityId: customerId,
        metadata: { fieldDefId, key: def.key },
      })
    );
  }
}

/** Join active defs with the customer's values for the editor UI. */
export async function listResolvedCustomFields(
  tenantId: string,
  customerId: string,
  repository: CustomFieldRepository
): Promise<ResolvedCustomFieldValue[]> {
  const defs = await repository.listDefs(tenantId, false);
  const values = await repository.listValues(tenantId, customerId);
  const valueByDef = new Map(values.map((v) => [v.fieldDefId, v.value]));
  return defs.map((def) => ({
    fieldDefId: def.id,
    key: def.key,
    label: def.label,
    fieldType: def.fieldType,
    options: def.options,
    value: valueByDef.get(def.id) ?? null,
  }));
}

export class InMemoryCustomFieldRepository implements CustomFieldRepository {
  private defs: Map<string, CustomFieldDef> = new Map();
  // key = `${tenantId}:${customerId}:${fieldDefId}`
  private values: Map<string, string | null> = new Map();

  async createDef(def: CustomFieldDef): Promise<CustomFieldDef> {
    this.defs.set(def.id, { ...def });
    return { ...def };
  }

  async findDefById(tenantId: string, id: string): Promise<CustomFieldDef | null> {
    const d = this.defs.get(id);
    if (!d || d.tenantId !== tenantId) return null;
    return { ...d };
  }

  async findDefByKey(tenantId: string, key: string): Promise<CustomFieldDef | null> {
    for (const d of this.defs.values()) {
      if (d.tenantId === tenantId && d.key === key) return { ...d };
    }
    return null;
  }

  async listDefs(tenantId: string, includeArchived = false): Promise<CustomFieldDef[]> {
    return Array.from(this.defs.values())
      .filter((d) => d.tenantId === tenantId && (includeArchived || !d.isArchived))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
      .map((d) => ({ ...d }));
  }

  async archiveDef(tenantId: string, id: string): Promise<CustomFieldDef | null> {
    const d = this.defs.get(id);
    if (!d || d.tenantId !== tenantId) return null;
    const updated = { ...d, isArchived: true, updatedAt: new Date() };
    this.defs.set(id, updated);
    return { ...updated };
  }

  async setValue(
    tenantId: string,
    customerId: string,
    fieldDefId: string,
    value: string | null
  ): Promise<void> {
    const k = `${tenantId}:${customerId}:${fieldDefId}`;
    if (value === null) this.values.delete(k);
    else this.values.set(k, value);
  }

  async listValues(tenantId: string, customerId: string): Promise<CustomFieldValueRow[]> {
    const prefix = `${tenantId}:${customerId}:`;
    const rows: CustomFieldValueRow[] = [];
    for (const [k, value] of this.values.entries()) {
      if (k.startsWith(prefix)) {
        rows.push({ fieldDefId: k.slice(prefix.length), value });
      }
    }
    return rows;
  }
}
