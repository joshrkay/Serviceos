import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors';
import {
  CustomFieldType,
  isValidFieldKey,
  validateCustomFieldDef,
  validateCustomFieldValue,
} from '../customers/custom-field';

/**
 * J-CF (Jobber parity) — tenant-defined custom fields on jobs.
 *
 * Jobber lets a shop attach custom fields to jobs (and quotes/clients); we
 * already have client custom fields (`customers/custom-field.ts`) — this is the
 * job-scoped twin. Distinct from Job Forms (fillable per-visit checklists):
 * custom fields are structured, reportable attributes on the job record itself
 * (PO number, permit #, gate code for this job).
 *
 * Reuses the generic field-type model + validators from the customer custom
 * field module (type/key/value validation are not customer-specific); only the
 * persistence (def/value tables keyed by job) differs. Pg impl in
 * `pg-job-custom-field.ts`.
 */

export interface JobCustomFieldDef {
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

export interface JobCustomFieldValueRow {
  fieldDefId: string;
  value: string | null;
}

/** A value joined to its (active) def — the shape the editor UI consumes. */
export interface ResolvedJobCustomFieldValue {
  fieldDefId: string;
  key: string;
  label: string;
  fieldType: CustomFieldType;
  options: string[];
  value: string | null;
}

export interface CreateJobCustomFieldDefInput {
  tenantId: string;
  key: string;
  label: string;
  fieldType?: CustomFieldType;
  options?: string[];
  sortOrder?: number;
  createdBy: string;
  actorRole?: string;
}

export interface JobCustomFieldRepository {
  createDef(def: JobCustomFieldDef): Promise<JobCustomFieldDef>;
  findDefById(tenantId: string, id: string): Promise<JobCustomFieldDef | null>;
  findDefByKey(tenantId: string, key: string): Promise<JobCustomFieldDef | null>;
  listDefs(tenantId: string, includeArchived?: boolean): Promise<JobCustomFieldDef[]>;
  archiveDef(tenantId: string, id: string): Promise<JobCustomFieldDef | null>;
  setValue(tenantId: string, jobId: string, fieldDefId: string, value: string | null): Promise<void>;
  listValues(tenantId: string, jobId: string): Promise<JobCustomFieldValueRow[]>;
}

export async function createJobCustomFieldDef(
  input: CreateJobCustomFieldDefInput,
  repository: JobCustomFieldRepository,
  auditRepo?: AuditRepository
): Promise<JobCustomFieldDef> {
  const errors = validateCustomFieldDef(input);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);
  if (!isValidFieldKey(input.key)) throw new ValidationError('Validation failed: invalid key');

  const existing = await repository.findDefByKey(input.tenantId, input.key);
  if (existing) throw new ConflictError(`A job custom field with key "${input.key}" already exists`);

  const now = new Date();
  const def: JobCustomFieldDef = {
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
        eventType: 'job_custom_field.created',
        entityType: 'job_custom_field_def',
        entityId: created.id,
        metadata: { key: created.key, fieldType: created.fieldType },
      })
    );
  }
  return created;
}

export async function setJobCustomFieldValue(
  tenantId: string,
  jobId: string,
  fieldDefId: string,
  value: string | null,
  repository: JobCustomFieldRepository,
  actorId?: string,
  auditRepo?: AuditRepository
): Promise<void> {
  const def = await repository.findDefById(tenantId, fieldDefId);
  if (!def) throw new NotFoundError('Job custom field', fieldDefId);
  if (def.isArchived) throw new ConflictError('Cannot set a value on an archived custom field');

  const validationError = validateCustomFieldValue(def, value);
  if (validationError) throw new ValidationError(`Validation failed: ${validationError}`);

  const normalized = value === null || value.trim() === '' ? null : value.trim();
  await repository.setValue(tenantId, jobId, fieldDefId, normalized);

  if (auditRepo && actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: 'unknown',
        eventType: 'job_custom_field.value_set',
        entityType: 'job',
        entityId: jobId,
        metadata: { fieldDefId, key: def.key },
      })
    );
  }
}

/** Join active defs with the job's values for the editor UI. */
export async function listResolvedJobCustomFields(
  tenantId: string,
  jobId: string,
  repository: JobCustomFieldRepository
): Promise<ResolvedJobCustomFieldValue[]> {
  const defs = await repository.listDefs(tenantId, false);
  const values = await repository.listValues(tenantId, jobId);
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

export class InMemoryJobCustomFieldRepository implements JobCustomFieldRepository {
  private defs: Map<string, JobCustomFieldDef> = new Map();
  // key = `${tenantId}:${jobId}:${fieldDefId}`
  private values: Map<string, string | null> = new Map();

  async createDef(def: JobCustomFieldDef): Promise<JobCustomFieldDef> {
    this.defs.set(def.id, { ...def });
    return { ...def };
  }

  async findDefById(tenantId: string, id: string): Promise<JobCustomFieldDef | null> {
    const d = this.defs.get(id);
    if (!d || d.tenantId !== tenantId) return null;
    return { ...d };
  }

  async findDefByKey(tenantId: string, key: string): Promise<JobCustomFieldDef | null> {
    for (const d of this.defs.values()) {
      if (d.tenantId === tenantId && d.key === key) return { ...d };
    }
    return null;
  }

  async listDefs(tenantId: string, includeArchived = false): Promise<JobCustomFieldDef[]> {
    return Array.from(this.defs.values())
      .filter((d) => d.tenantId === tenantId && (includeArchived || !d.isArchived))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
      .map((d) => ({ ...d }));
  }

  async archiveDef(tenantId: string, id: string): Promise<JobCustomFieldDef | null> {
    const d = this.defs.get(id);
    if (!d || d.tenantId !== tenantId) return null;
    const updated = { ...d, isArchived: true, updatedAt: new Date() };
    this.defs.set(id, updated);
    return { ...updated };
  }

  async setValue(tenantId: string, jobId: string, fieldDefId: string, value: string | null): Promise<void> {
    const k = `${tenantId}:${jobId}:${fieldDefId}`;
    if (value === null) this.values.delete(k);
    else this.values.set(k, value);
  }

  async listValues(tenantId: string, jobId: string): Promise<JobCustomFieldValueRow[]> {
    const prefix = `${tenantId}:${jobId}:`;
    const rows: JobCustomFieldValueRow[] = [];
    for (const [k, value] of this.values.entries()) {
      if (k.startsWith(prefix)) rows.push({ fieldDefId: k.slice(prefix.length), value });
    }
    return rows;
  }
}
