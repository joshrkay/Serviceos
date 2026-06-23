import type { AuthedFetch } from './me';

export interface CreateJobInput {
  customerId: string;
  locationId: string;
  summary: string;
  scheduledStart?: string;
}

export async function createJob(client: AuthedFetch, input: CreateJobInput): Promise<{ id: string }> {
  const res = await client('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`createJob: ${res.status}`);
  return (await res.json()) as { id: string };
}

export async function transitionJob(
  client: AuthedFetch,
  id: string,
  status: string,
): Promise<void> {
  const res = await client(`/api/jobs/${id}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`transitionJob: ${res.status}`);
}

export async function clockTimeEntry(
  client: AuthedFetch,
  jobId: string,
  action: 'clock_in' | 'clock_out',
): Promise<void> {
  const res = await client('/api/time-entries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, action }),
  });
  if (!res.ok) throw new Error(`clockTimeEntry: ${res.status}`);
}
