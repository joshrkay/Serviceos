/**
 * P12-002 — Typed client for the /api/time-entries endpoints.
 */
import type { ApiFetch } from '../lib/apiClient';

export type EntryType = 'job' | 'drive' | 'break' | 'admin';

export interface TimeEntry {
  id: string;
  tenantId: string;
  userId: string;
  jobId?: string;
  entryType: EntryType;
  clockedInAt: string;
  clockedOutAt?: string;
  durationMinutes?: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClockInBody {
  userId?: string;
  jobId?: string;
  entryType: EntryType;
  notes?: string;
  clockedInAt?: string;
}

export interface ClockOutBody {
  userId?: string;
  notes?: string;
  clockedOutAt?: string;
}

export interface DailyBucket {
  date: string;
  hours: number;
}

export interface WeeklyHoursRollup {
  userId: string;
  weekStart: string;
  byDay: DailyBucket[];
  totalHours: number;
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const timeEntriesApi = {
  async getActive(
    fetcher: ApiFetch,
    userId?: string
  ): Promise<{ active: TimeEntry | null }> {
    const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
    return asJson(await fetcher(`/api/time-entries/active${qs}`));
  },

  async clockIn(fetcher: ApiFetch, body: ClockInBody): Promise<TimeEntry> {
    return asJson(
      await fetcher('/api/time-entries/clock-in', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    );
  },

  async clockOut(fetcher: ApiFetch, body: ClockOutBody = {}): Promise<TimeEntry> {
    return asJson(
      await fetcher('/api/time-entries/clock-out', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    );
  },

  async list(
    fetcher: ApiFetch,
    options: { userId?: string; weekOf?: string; tz?: string; limit?: number } = {}
  ): Promise<TimeEntry[] | WeeklyHoursRollup[]> {
    const params = new URLSearchParams();
    if (options.userId) params.set('userId', options.userId);
    if (options.weekOf) params.set('weekOf', options.weekOf);
    if (options.tz) params.set('tz', options.tz);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const qs = params.toString();
    return asJson(await fetcher(`/api/time-entries${qs ? `?${qs}` : ''}`));
  },

  async weeklyHours(
    fetcher: ApiFetch,
    options: { userId: string; weekOf: string; tz?: string }
  ): Promise<WeeklyHoursRollup[]> {
    const params = new URLSearchParams();
    params.set('userId', options.userId);
    params.set('weekOf', options.weekOf);
    if (options.tz) params.set('tz', options.tz);
    return asJson(
      await fetcher(`/api/time-entries?${params.toString()}`)
    );
  },
};
