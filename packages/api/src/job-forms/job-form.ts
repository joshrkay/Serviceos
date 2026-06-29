import { v4 as uuidv4 } from 'uuid';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ConflictError, NotFoundError, ValidationError } from '../shared/errors';

/**
 * J-FORM (Jobber parity) — tenant-defined job forms & checklists.
 *
 * Jobber's "Job Forms & Checklists" let a shop define reusable templates
 * (a furnace tune-up checklist, a safety inspection form) that technicians
 * fill out per job. We mirror that with two entities:
 *
 *  - JobFormTemplate: tenant-defined, an ordered list of typed fields. Fields
 *    are embedded (not a child table) because they are template-scoped and
 *    always read/written together.
 *  - JobFormSubmission: a filled instance attached to a job. It SNAPSHOTS the
 *    template name + fields at creation time so a completed record never
 *    changes if the template is later edited or archived (the same guarantee
 *    Jobber gives — a signed-off checklist is a historical document).
 *
 * Field types drive answer validation: `number` must parse, `date` must be
 * ISO (YYYY-MM-DD), `select` must be one of the field's options, `checkbox`
 * must be 'true'/'false'. Mirrors the customer custom-field domain shape
 * (port interface + pure functions + in-memory repo); Pg impl in
 * `pg-job-form.ts`.
 */

export type JobFormFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'select';

export const JOB_FORM_FIELD_TYPES: readonly JobFormFieldType[] = [
  'text',
  'textarea',
  'number',
  'date',
  'checkbox',
  'select',
];

export type JobFormSubmissionStatus = 'draft' | 'completed';

export interface JobFormField {
  /** Stable id within the template; answers reference it. */
  id: string;
  label: string;
  fieldType: JobFormFieldType;
  /** Only meaningful for `select`. */
  options: string[];
  required: boolean;
  sortOrder: number;
}

export interface JobFormTemplate {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  fields: JobFormField[];
  sortOrder: number;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobFormAnswer {
  fieldId: string;
  /** Raw string value; null/'' clears the answer. checkbox is 'true'/'false'. */
  value: string | null;
}

export interface JobFormSubmission {
  id: string;
  tenantId: string;
  jobId: string;
  templateId: string;
  /** Snapshot of the template name at submission time. */
  templateName: string;
  /** Snapshot of the template fields at submission time. */
  fields: JobFormField[];
  answers: JobFormAnswer[];
  status: JobFormSubmissionStatus;
  completedBy: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Field shape accepted from the API when defining/editing a template. */
export interface JobFormFieldInput {
  id?: string;
  label: string;
  fieldType?: JobFormFieldType;
  options?: string[];
  required?: boolean;
}

export interface CreateJobFormTemplateInput {
  tenantId: string;
  name: string;
  description?: string | null;
  fields: JobFormFieldInput[];
  sortOrder?: number;
  createdBy: string;
  actorRole?: string;
}

export interface UpdateJobFormTemplateInput {
  name?: string;
  description?: string | null;
  fields?: JobFormFieldInput[];
  sortOrder?: number;
}

export interface JobFormRepository {
  createTemplate(template: JobFormTemplate): Promise<JobFormTemplate>;
  findTemplateById(tenantId: string, id: string): Promise<JobFormTemplate | null>;
  listTemplates(tenantId: string, includeArchived?: boolean): Promise<JobFormTemplate[]>;
  updateTemplate(template: JobFormTemplate): Promise<JobFormTemplate>;
  archiveTemplate(tenantId: string, id: string): Promise<JobFormTemplate | null>;

  createSubmission(submission: JobFormSubmission): Promise<JobFormSubmission>;
  findSubmissionById(tenantId: string, id: string): Promise<JobFormSubmission | null>;
  listSubmissionsByJob(tenantId: string, jobId: string): Promise<JobFormSubmission[]>;
  updateSubmission(submission: JobFormSubmission): Promise<JobFormSubmission>;
}

// ---------------------------------------------------------------------------
// Pure validation / normalization
// ---------------------------------------------------------------------------

/**
 * Strict 'YYYY-MM-DD' check: rejects rolled-over calendar dates (e.g.
 * 2026-02-30, which Date.parse would silently accept as March 2) by formatting
 * the parsed UTC date back and comparing.
 */
function isStrictIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Validate a single field definition. Returns error messages (empty = ok). */
export function validateJobFormField(field: JobFormFieldInput): string[] {
  const errors: string[] = [];
  if (!field.label || !field.label.trim()) errors.push('field label is required');
  if (field.fieldType && !JOB_FORM_FIELD_TYPES.includes(field.fieldType)) {
    errors.push(`invalid field type "${field.fieldType}"`);
  }
  if (field.fieldType === 'select' && (!field.options || field.options.length === 0)) {
    errors.push(`select field "${field.label ?? ''}" requires at least one option`);
  }
  return errors;
}

export function validateJobFormTemplateInput(input: {
  name?: string;
  fields?: JobFormFieldInput[];
}): string[] {
  const errors: string[] = [];
  if (!input.name || !input.name.trim()) errors.push('name is required');
  if (!input.fields || input.fields.length === 0) {
    errors.push('a template needs at least one field');
  } else {
    input.fields.forEach((f, i) => {
      for (const e of validateJobFormField(f)) errors.push(`field ${i + 1}: ${e}`);
    });
  }
  return errors;
}

/**
 * Turn raw field inputs into normalized fields: assign stable ids (preserving
 * any caller-supplied id so edits keep answers attached), default the type,
 * drop options on non-select fields, and stamp sortOrder by array position.
 */
export function normalizeFields(fields: JobFormFieldInput[]): JobFormField[] {
  return fields.map((f, i) => {
    const fieldType = f.fieldType ?? 'text';
    return {
      id: f.id && f.id.trim() ? f.id : uuidv4(),
      label: f.label.trim(),
      fieldType,
      options: fieldType === 'select' ? (f.options ?? []).map((o) => o.trim()).filter(Boolean) : [],
      required: f.required ?? false,
      sortOrder: i,
    };
  });
}

/**
 * Validate a single answer's raw value against its field type. Returns an error
 * message or null. Blank values are allowed here (the required-on-complete check
 * is separate, in validateSubmissionAnswers).
 */
export function validateAnswerValue(field: JobFormField, value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  switch (field.fieldType) {
    case 'number':
      return Number.isFinite(Number(value)) ? null : `"${field.label}" must be a number`;
    case 'date':
      return isStrictIsoDate(value) ? null : `"${field.label}" must be a date (YYYY-MM-DD)`;
    case 'checkbox':
      return value === 'true' || value === 'false' ? null : `"${field.label}" must be true or false`;
    case 'select':
      return field.options.includes(value)
        ? null
        : `"${value}" is not a valid option for "${field.label}"`;
    case 'text':
    case 'textarea':
    default:
      return null;
  }
}

/**
 * Validate a full set of answers against the submission's snapshot fields.
 * Unknown field ids are rejected. When `requireComplete` is true (i.e. the
 * submission is being marked completed), every `required` field must have a
 * non-blank value.
 */
export function validateSubmissionAnswers(
  fields: JobFormField[],
  answers: JobFormAnswer[],
  opts: { requireComplete?: boolean } = {}
): string[] {
  const errors: string[] = [];
  const fieldById = new Map(fields.map((f) => [f.id, f]));
  const answerById = new Map<string, string | null>();

  for (const ans of answers) {
    const field = fieldById.get(ans.fieldId);
    if (!field) {
      errors.push(`unknown field "${ans.fieldId}"`);
      continue;
    }
    const valueError = validateAnswerValue(field, ans.value);
    if (valueError) errors.push(valueError);
    answerById.set(ans.fieldId, ans.value);
  }

  if (opts.requireComplete) {
    for (const field of fields) {
      if (!field.required) continue;
      const v = answerById.get(field.id);
      const blank = v === undefined || v === null || v.trim() === '' || v === 'false';
      if (blank) errors.push(`"${field.label}" is required`);
    }
  }

  return errors;
}

/** Normalize answers: trim, drop blanks, keep only the latest per field id. */
export function normalizeAnswers(answers: JobFormAnswer[]): JobFormAnswer[] {
  const byId = new Map<string, string | null>();
  for (const ans of answers) {
    const v = ans.value === null ? null : ans.value.trim();
    byId.set(ans.fieldId, v === '' ? null : v);
  }
  return Array.from(byId.entries())
    .filter(([, v]) => v !== null)
    .map(([fieldId, value]) => ({ fieldId, value }));
}

// ---------------------------------------------------------------------------
// Orchestration (validate → persist → audit)
// ---------------------------------------------------------------------------

export async function createJobFormTemplate(
  input: CreateJobFormTemplateInput,
  repository: JobFormRepository,
  auditRepo?: AuditRepository
): Promise<JobFormTemplate> {
  const errors = validateJobFormTemplateInput(input);
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const now = new Date();
  const template: JobFormTemplate = {
    id: uuidv4(),
    tenantId: input.tenantId,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    fields: normalizeFields(input.fields),
    sortOrder: input.sortOrder ?? 0,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };
  const created = await repository.createTemplate(template);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: input.actorRole ?? 'unknown',
        eventType: 'job_form_template.created',
        entityType: 'job_form_template',
        entityId: created.id,
        metadata: { name: created.name, fieldCount: created.fields.length },
      })
    );
  }
  return created;
}

export async function updateJobFormTemplate(
  tenantId: string,
  templateId: string,
  input: UpdateJobFormTemplateInput,
  repository: JobFormRepository,
  actorId?: string,
  auditRepo?: AuditRepository,
  actorRole?: string
): Promise<JobFormTemplate> {
  const existing = await repository.findTemplateById(tenantId, templateId);
  if (!existing) throw new NotFoundError('Job form template', templateId);

  const merged = {
    name: input.name ?? existing.name,
    fields: input.fields,
  };
  // Only re-validate the parts being changed.
  const errors: string[] = [];
  if (input.name !== undefined && (!input.name || !input.name.trim())) {
    errors.push('name is required');
  }
  if (input.fields !== undefined) {
    for (const e of validateJobFormTemplateInput({ name: merged.name, fields: input.fields })) {
      if (e !== 'name is required' || input.name !== undefined) errors.push(e);
    }
  }
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const updated: JobFormTemplate = {
    ...existing,
    name: input.name !== undefined ? input.name.trim() : existing.name,
    description:
      input.description !== undefined ? input.description?.trim() || null : existing.description,
    fields: input.fields !== undefined ? normalizeFields(input.fields) : existing.fields,
    sortOrder: input.sortOrder ?? existing.sortOrder,
    updatedAt: new Date(),
  };
  const saved = await repository.updateTemplate(updated);

  if (auditRepo && actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: actorRole ?? 'unknown',
        eventType: 'job_form_template.updated',
        entityType: 'job_form_template',
        entityId: saved.id,
        metadata: { name: saved.name, fieldCount: saved.fields.length },
      })
    );
  }
  return saved;
}

export async function archiveJobFormTemplate(
  tenantId: string,
  templateId: string,
  repository: JobFormRepository,
  actorId?: string,
  auditRepo?: AuditRepository,
  actorRole?: string
): Promise<JobFormTemplate | null> {
  const archived = await repository.archiveTemplate(tenantId, templateId);
  if (archived && auditRepo && actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: actorRole ?? 'unknown',
        eventType: 'job_form_template.archived',
        entityType: 'job_form_template',
        entityId: archived.id,
        metadata: { name: archived.name },
      })
    );
  }
  return archived;
}

export interface CreateJobFormSubmissionInput {
  tenantId: string;
  jobId: string;
  templateId: string;
  answers?: JobFormAnswer[];
  complete?: boolean;
  createdBy: string;
  actorRole?: string;
}

export async function createJobFormSubmission(
  input: CreateJobFormSubmissionInput,
  repository: JobFormRepository,
  auditRepo?: AuditRepository
): Promise<JobFormSubmission> {
  const template = await repository.findTemplateById(input.tenantId, input.templateId);
  if (!template) throw new NotFoundError('Job form template', input.templateId);

  const answers = normalizeAnswers(input.answers ?? []);
  const requireComplete = input.complete === true;
  const errors = validateSubmissionAnswers(template.fields, answers, { requireComplete });
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const now = new Date();
  const submission: JobFormSubmission = {
    id: uuidv4(),
    tenantId: input.tenantId,
    jobId: input.jobId,
    templateId: template.id,
    templateName: template.name,
    fields: template.fields,
    answers,
    status: requireComplete ? 'completed' : 'draft',
    completedBy: requireComplete ? input.createdBy : null,
    completedAt: requireComplete ? now : null,
    createdAt: now,
    updatedAt: now,
  };
  const created = await repository.createSubmission(submission);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: input.actorRole ?? 'unknown',
        eventType:
          created.status === 'completed'
            ? 'job_form_submission.completed'
            : 'job_form_submission.created',
        entityType: 'job',
        entityId: input.jobId,
        metadata: { submissionId: created.id, templateId: created.templateId, status: created.status },
      })
    );
  }
  return created;
}

export interface UpdateJobFormSubmissionInput {
  answers?: JobFormAnswer[];
  complete?: boolean;
}

export async function updateJobFormSubmission(
  tenantId: string,
  submissionId: string,
  input: UpdateJobFormSubmissionInput,
  repository: JobFormRepository,
  actorId?: string,
  auditRepo?: AuditRepository,
  actorRole?: string
): Promise<JobFormSubmission> {
  const existing = await repository.findSubmissionById(tenantId, submissionId);
  if (!existing) throw new NotFoundError('Job form submission', submissionId);
  // A completed submission is locked history — reject further edits so a stale
  // client can't overwrite a signed-off checklist (the feature's promise).
  if (existing.status === 'completed') {
    throw new ConflictError('This form is completed and can no longer be edited');
  }

  // `existing` is guaranteed draft here (completed submissions threw above).
  const answers =
    input.answers !== undefined ? normalizeAnswers(input.answers) : existing.answers;
  const completing = input.complete === true;
  const errors = validateSubmissionAnswers(existing.fields, answers, {
    requireComplete: completing,
  });
  if (errors.length > 0) throw new ValidationError(`Validation failed: ${errors.join(', ')}`);

  const updated: JobFormSubmission = {
    ...existing,
    answers,
    status: completing ? 'completed' : 'draft',
    completedBy: completing ? actorId ?? existing.completedBy : existing.completedBy,
    completedAt: completing ? new Date() : existing.completedAt,
    updatedAt: new Date(),
  };
  const saved = await repository.updateSubmission(updated);

  if (auditRepo && actorId) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole: actorRole ?? 'unknown',
        eventType: completing
          ? 'job_form_submission.completed'
          : 'job_form_submission.updated',
        entityType: 'job',
        entityId: saved.jobId,
        metadata: { submissionId: saved.id, status: saved.status },
      })
    );
  }
  return saved;
}

// ---------------------------------------------------------------------------
// In-memory repository (tests + no-DB local dev)
// ---------------------------------------------------------------------------

export class InMemoryJobFormRepository implements JobFormRepository {
  private templates: Map<string, JobFormTemplate> = new Map();
  private submissions: Map<string, JobFormSubmission> = new Map();

  async createTemplate(template: JobFormTemplate): Promise<JobFormTemplate> {
    this.templates.set(template.id, clone(template));
    return clone(template);
  }

  async findTemplateById(tenantId: string, id: string): Promise<JobFormTemplate | null> {
    const t = this.templates.get(id);
    if (!t || t.tenantId !== tenantId) return null;
    return clone(t);
  }

  async listTemplates(tenantId: string, includeArchived = false): Promise<JobFormTemplate[]> {
    return Array.from(this.templates.values())
      .filter((t) => t.tenantId === tenantId && (includeArchived || !t.isArchived))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map(clone);
  }

  async updateTemplate(template: JobFormTemplate): Promise<JobFormTemplate> {
    this.templates.set(template.id, clone(template));
    return clone(template);
  }

  async archiveTemplate(tenantId: string, id: string): Promise<JobFormTemplate | null> {
    const t = this.templates.get(id);
    if (!t || t.tenantId !== tenantId) return null;
    const updated = { ...t, isArchived: true, updatedAt: new Date() };
    this.templates.set(id, updated);
    return clone(updated);
  }

  async createSubmission(submission: JobFormSubmission): Promise<JobFormSubmission> {
    this.submissions.set(submission.id, clone(submission));
    return clone(submission);
  }

  async findSubmissionById(tenantId: string, id: string): Promise<JobFormSubmission | null> {
    const s = this.submissions.get(id);
    if (!s || s.tenantId !== tenantId) return null;
    return clone(s);
  }

  async listSubmissionsByJob(tenantId: string, jobId: string): Promise<JobFormSubmission[]> {
    return Array.from(this.submissions.values())
      .filter((s) => s.tenantId === tenantId && s.jobId === jobId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);
  }

  async updateSubmission(submission: JobFormSubmission): Promise<JobFormSubmission> {
    this.submissions.set(submission.id, clone(submission));
    return clone(submission);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key, v) =>
    (key === 'createdAt' || key === 'updatedAt' || key === 'completedAt') && typeof v === 'string'
      ? new Date(v)
      : v
  );
}
