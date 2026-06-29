/**
 * J-CF (Jobber parity) — job custom fields web client.
 *
 * Talks to /api/job-custom-fields: tenant-level definitions (managed in
 * settings) and per-job values (edited on the job detail).
 */
import { apiFetch } from '../utils/api-fetch';

export type JobCustomFieldType = 'text' | 'number' | 'date' | 'select';

export interface JobCustomFieldDef {
  id: string;
  tenantId: string;
  key: string;
  label: string;
  fieldType: JobCustomFieldType;
  options: string[];
  sortOrder: number;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedJobCustomField {
  fieldDefId: string;
  key: string;
  label: string;
  fieldType: JobCustomFieldType;
  options: string[];
  value: string | null;
}

export interface JobCustomFieldDefInput {
  key: string;
  label: string;
  fieldType?: JobCustomFieldType;
  options?: string[];
  sortOrder?: number;
}

async function readJsonOrThrow<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(json?.message ?? `Failed to ${action}: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listJobCustomFieldDefs(
  includeArchived = false,
): Promise<JobCustomFieldDef[]> {
  const qs = includeArchived ? '?includeArchived=true' : '';
  const res = await apiFetch(`/api/job-custom-fields/defs${qs}`);
  const data = await readJsonOrThrow<unknown>(res, 'load job custom fields');
  return Array.isArray(data) ? (data as JobCustomFieldDef[]) : [];
}

export async function createJobCustomFieldDef(
  input: JobCustomFieldDefInput,
): Promise<JobCustomFieldDef> {
  const res = await apiFetch('/api/job-custom-fields/defs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return readJsonOrThrow<JobCustomFieldDef>(res, 'create job custom field');
}

export async function archiveJobCustomFieldDef(id: string): Promise<void> {
  const res = await apiFetch(`/api/job-custom-fields/defs/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to archive job custom field: ${res.status}`);
}

export async function listJobCustomFields(jobId: string): Promise<ResolvedJobCustomField[]> {
  const res = await apiFetch(`/api/job-custom-fields/jobs/${encodeURIComponent(jobId)}`);
  const data = await readJsonOrThrow<unknown>(res, 'load job custom fields');
  return Array.isArray(data) ? (data as ResolvedJobCustomField[]) : [];
}

export async function setJobCustomFieldValue(
  jobId: string,
  fieldDefId: string,
  value: string | null,
): Promise<ResolvedJobCustomField[]> {
  const res = await apiFetch(
    `/api/job-custom-fields/jobs/${encodeURIComponent(jobId)}/values/${encodeURIComponent(fieldDefId)}`,
    { method: 'PUT', body: JSON.stringify({ value }) },
  );
  const data = await readJsonOrThrow<unknown>(res, 'save job custom field');
  return Array.isArray(data) ? (data as ResolvedJobCustomField[]) : [];
}
