/**
 * #1735 — outbound multi-step drip campaigns web client.
 *
 * Talks to /api/drip-campaigns (owner-only; 404 until the tenant has the
 * `drip_campaigns` flag, so `getDripStatus` is the one call that always answers).
 */
import { apiFetch } from '../utils/api-fetch';

export type DripChannel = 'sms' | 'call' | 'email';
export type DripTargetKind = 'lapsed_customers' | 'unsold_estimates';

export type DripStep =
  | { channel: 'sms'; delayMinutes: number; body: string }
  | { channel: 'email'; delayMinutes: number; subject: string; body: string }
  | { channel: 'call'; delayMinutes: number; agentPhone: string };

export interface DripSequenceStats {
  sequenceId: string;
  enrolled: number;
  active: number;
  completed: number;
  booked: number;
}

export interface DripSequence {
  id: string;
  name: string;
  targetKind: DripTargetKind;
  targetDays: number;
  steps: DripStep[];
  status: 'active' | 'paused';
  stats?: DripSequenceStats;
}

export interface DripSequenceInput {
  name: string;
  targetKind: DripTargetKind;
  targetDays?: number;
  steps: DripStep[];
}

async function readJsonOrThrow<T>(res: Response, action: string): Promise<T> {
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(json?.message ?? `Failed to ${action}: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getDripStatus(): Promise<{ enabled: boolean }> {
  const res = await apiFetch('/api/drip-campaigns/status');
  return readJsonOrThrow<{ enabled: boolean }>(res, 'load drip campaign status');
}

export async function listDripSequences(): Promise<DripSequence[]> {
  const res = await apiFetch('/api/drip-campaigns/sequences');
  const data = await readJsonOrThrow<unknown>(res, 'load drip campaigns');
  return Array.isArray(data) ? (data as DripSequence[]) : [];
}

export async function createDripSequence(input: DripSequenceInput): Promise<DripSequence> {
  const res = await apiFetch('/api/drip-campaigns/sequences', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return readJsonOrThrow<DripSequence>(res, 'create drip campaign');
}

export async function setDripSequenceRunning(id: string, running: boolean): Promise<DripSequence> {
  const res = await apiFetch(
    `/api/drip-campaigns/sequences/${encodeURIComponent(id)}/${running ? 'resume' : 'pause'}`,
    { method: 'POST' },
  );
  return readJsonOrThrow<DripSequence>(res, running ? 'resume drip campaign' : 'pause drip campaign');
}

export async function enrollDripTargets(id: string): Promise<{ enrolled: number }> {
  const res = await apiFetch(`/api/drip-campaigns/sequences/${encodeURIComponent(id)}/enroll`, {
    method: 'POST',
  });
  return readJsonOrThrow<{ enrolled: number }>(res, 'enroll customers');
}
