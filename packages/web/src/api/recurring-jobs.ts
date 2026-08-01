/**
 * R-JOB (Jobber parity) — recurring job series web client.
 *
 * Talks to /api/recurring-jobs. A series stores a recurrence rule; upcoming
 * visit dates are computed server-side (GET /:id/occurrences).
 */
import { apiFetch } from '../utils/api-fetch';

export type RecurrenceFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly';

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval: number;
  count?: number;
  until?: string;
}

export interface RecurringJob {
  id: string;
  tenantId: string;
  customerId: string;
  title: string;
  anchorDate: string;
  rule: RecurrenceRule;
  notes: string | null;
  isArchived: boolean;
  scheduleSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringJobInput {
  customerId: string;
  title: string;
  anchorDate: string;
  rule: RecurrenceRule;
  notes?: string | null;
}

async function readJsonOrThrow<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(json?.message ?? `Failed to ${action}: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listRecurringJobs(customerId?: string): Promise<RecurringJob[]> {
  const qs = customerId ? `?customerId=${encodeURIComponent(customerId)}` : '';
  const res = await apiFetch(`/api/recurring-jobs${qs}`);
  const data = await readJsonOrThrow<unknown>(res, 'load recurring jobs');
  return Array.isArray(data) ? (data as RecurringJob[]) : [];
}

export async function createRecurringJob(input: RecurringJobInput): Promise<RecurringJob> {
  const res = await apiFetch('/api/recurring-jobs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return readJsonOrThrow<RecurringJob>(res, 'create recurring job');
}

export async function archiveRecurringJob(id: string): Promise<void> {
  const res = await apiFetch(`/api/recurring-jobs/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to archive recurring job: ${res.status}`);
}

export interface GeneratedVisit {
  occurrenceDate: string;
  jobId: string;
  appointmentId: string;
}

export interface GenerateVisitsResult {
  generated: GeneratedVisit[];
  skippedReason?: 'no_location';
}

/** Materialize due occurrences into real jobs + appointments (idempotent). */
export async function generateRecurringJobVisits(
  id: string,
  horizonDays?: number,
): Promise<GenerateVisitsResult> {
  const res = await apiFetch(`/api/recurring-jobs/${encodeURIComponent(id)}/generate`, {
    method: 'POST',
    body: JSON.stringify(horizonDays ? { horizonDays } : {}),
  });
  return readJsonOrThrow<GenerateVisitsResult>(res, 'generate visits');
}

export async function getRecurringJobOccurrences(
  id: string,
  opts: { from?: string; limit?: number } = {},
): Promise<string[]> {
  const params = new URLSearchParams();
  if (opts.from) params.set('from', opts.from);
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await apiFetch(`/api/recurring-jobs/${encodeURIComponent(id)}/occurrences${qs}`);
  const data = await readJsonOrThrow<{ occurrences?: string[] }>(res, 'load visit dates');
  return Array.isArray(data.occurrences) ? data.occurrences : [];
}
