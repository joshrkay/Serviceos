import { randomUUID } from 'crypto';

const revisions = new Map<string, string>();

function revisionKey(tenantId: string, date: string): string {
  return `${tenantId}:${date}`;
}

export function bumpDispatchBoardRevision(tenantId: string, date: string): string {
  const rev = randomUUID();
  revisions.set(revisionKey(tenantId, date), rev);
  return rev;
}

export function getDispatchBoardRevision(tenantId: string, date: string): string {
  const key = revisionKey(tenantId, date);
  const existing = revisions.get(key);
  if (existing) return existing;
  const initial = randomUUID();
  revisions.set(key, initial);
  return initial;
}

/** Board calendar date from an appointment instant (UTC day). */
export function boardDateFromAppointment(scheduledStart: Date): string {
  return scheduledStart.toISOString().slice(0, 10);
}
