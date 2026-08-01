/**
 * J-FORM (Jobber parity) — job forms & checklists web client.
 *
 * Mirrors the API at /api/job-forms: tenant-defined templates (managed in
 * settings) and per-job submissions (filled by technicians on a job).
 */
import { apiFetch } from '../utils/api-fetch';

export type JobFormFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'select';

export interface JobFormField {
  id: string;
  label: string;
  fieldType: JobFormFieldType;
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
  createdAt: string;
  updatedAt: string;
}

export interface JobFormAnswer {
  fieldId: string;
  value: string | null;
}

export interface JobFormSubmission {
  id: string;
  tenantId: string;
  jobId: string;
  templateId: string;
  templateName: string;
  fields: JobFormField[];
  answers: JobFormAnswer[];
  status: 'draft' | 'completed';
  completedBy: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobFormFieldInput {
  id?: string;
  label: string;
  fieldType?: JobFormFieldType;
  options?: string[];
  required?: boolean;
}

export interface JobFormTemplateInput {
  name: string;
  description?: string | null;
  fields: JobFormFieldInput[];
  sortOrder?: number;
}

async function readJsonOrThrow<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(json?.message ?? `Failed to ${action}: ${res.status}`);
  }
  return (await res.json()) as T;
}

// --- Templates -------------------------------------------------------------

export async function listJobFormTemplates(
  includeArchived = false,
): Promise<JobFormTemplate[]> {
  const qs = includeArchived ? '?includeArchived=true' : '';
  const res = await apiFetch(`/api/job-forms/templates${qs}`);
  const data = await readJsonOrThrow<unknown>(res, 'load job form templates');
  return Array.isArray(data) ? (data as JobFormTemplate[]) : [];
}

export async function createJobFormTemplate(
  input: JobFormTemplateInput,
): Promise<JobFormTemplate> {
  const res = await apiFetch('/api/job-forms/templates', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return readJsonOrThrow<JobFormTemplate>(res, 'create job form template');
}

export async function updateJobFormTemplate(
  templateId: string,
  input: Partial<JobFormTemplateInput>,
): Promise<JobFormTemplate> {
  const res = await apiFetch(`/api/job-forms/templates/${encodeURIComponent(templateId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return readJsonOrThrow<JobFormTemplate>(res, 'update job form template');
}

export async function archiveJobFormTemplate(templateId: string): Promise<void> {
  const res = await apiFetch(
    `/api/job-forms/templates/${encodeURIComponent(templateId)}/archive`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`Failed to archive template: ${res.status}`);
}

// --- Submissions (per job) -------------------------------------------------

export async function listJobFormSubmissions(jobId: string): Promise<JobFormSubmission[]> {
  const res = await apiFetch(`/api/job-forms/jobs/${encodeURIComponent(jobId)}/submissions`);
  const data = await readJsonOrThrow<unknown>(res, 'load job forms');
  return Array.isArray(data) ? (data as JobFormSubmission[]) : [];
}

export async function createJobFormSubmission(
  jobId: string,
  input: { templateId: string; answers?: JobFormAnswer[]; complete?: boolean },
): Promise<JobFormSubmission> {
  const res = await apiFetch(`/api/job-forms/jobs/${encodeURIComponent(jobId)}/submissions`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return readJsonOrThrow<JobFormSubmission>(res, 'add job form');
}

export async function updateJobFormSubmission(
  submissionId: string,
  input: { answers?: JobFormAnswer[]; complete?: boolean },
): Promise<JobFormSubmission> {
  const res = await apiFetch(`/api/job-forms/submissions/${encodeURIComponent(submissionId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return readJsonOrThrow<JobFormSubmission>(res, 'save job form');
}
