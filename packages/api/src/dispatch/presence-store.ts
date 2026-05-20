export type PresenceMode = 'viewing' | 'dragging';

export interface PresenceEntry {
  tenantId: string;
  date: string;
  userId: string;
  displayName: string;
  appointmentId: string | null;
  mode: PresenceMode;
  expiresAt: number;
}

const store = new Map<string, PresenceEntry>();

function entryKey(tenantId: string, date: string, userId: string): string {
  return `${tenantId}:${date}:${userId}`;
}

export function upsertDispatchPresence(entry: Omit<PresenceEntry, 'expiresAt'> & { ttlMs?: number }): void {
  const ttlMs = entry.ttlMs ?? 15_000;
  store.set(entryKey(entry.tenantId, entry.date, entry.userId), {
    ...entry,
    expiresAt: Date.now() + ttlMs,
  });
}

export function clearDispatchPresence(tenantId: string, date: string, userId: string): void {
  store.delete(entryKey(tenantId, date, userId));
}

export function listDispatchPresence(tenantId: string, date: string): PresenceEntry[] {
  const now = Date.now();
  const prefix = `${tenantId}:${date}:`;
  const active: PresenceEntry[] = [];
  for (const [key, entry] of store) {
    if (!key.startsWith(prefix)) continue;
    if (entry.expiresAt <= now) {
      store.delete(key);
      continue;
    }
    active.push(entry);
  }
  return active;
}

export function getEditingOnAppointment(
  tenantId: string,
  date: string,
  appointmentId: string,
  excludeUserId?: string,
): { userId: string; displayName: string; mode: PresenceMode } | null {
  for (const entry of listDispatchPresence(tenantId, date)) {
    if (entry.appointmentId !== appointmentId) continue;
    if (entry.mode !== 'dragging') continue;
    if (excludeUserId && entry.userId === excludeUserId) continue;
    return { userId: entry.userId, displayName: entry.displayName, mode: entry.mode };
  }
  return null;
}
