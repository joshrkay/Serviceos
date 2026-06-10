import type { Pool, PoolClient } from 'pg';
import type { GoogleFetch } from '../integrations/google-calendar';

/**
 * Feature 5 — seed a tech-availability template from the next 7 days of the
 * owner's Google Calendar free/busy on connect.
 *
 * The free/busy fetch is injectable so the provisioning/onboarding callers can
 * unit-test the seeding logic without real Google calls (mocks only). The
 * template is stored on tenant_settings.availability_template (migration 150).
 */

export interface BusyBlock {
  start: string;
  end: string;
}

export interface FreeBusyFetcher {
  (input: {
    accessToken: string;
    timeMin: string;
    timeMax: string;
    calendarId: string;
  }): Promise<{ busy: BusyBlock[] }>;
}

/** Real free/busy fetcher backed by the Google Calendar v3 freeBusy API. */
export function makeGoogleFreeBusyFetcher(fetchFn: GoogleFetch = fetch): FreeBusyFetcher {
  return async ({ accessToken, timeMin, timeMax, calendarId }) => {
    const res = await fetchFn('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ timeMin, timeMax, items: [{ id: calendarId }] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google freeBusy failed (${res.status}): ${body}`.trim());
    }
    const json = (await res.json()) as {
      calendars?: Record<string, { busy?: BusyBlock[] }>;
    };
    return { busy: json.calendars?.[calendarId]?.busy ?? [] };
  };
}

export interface AvailabilityTemplate {
  source: 'google';
  generatedAt: string;
  windowDays: number;
  busy: BusyBlock[];
}

export interface SeedAvailabilityDeps {
  pool: Pool | PoolClient;
  freeBusy: FreeBusyFetcher;
  accessToken: string;
  calendarId?: string;
}

const WINDOW_DAYS = 7;

/**
 * Pull the next 7 days of free/busy and persist an availability template.
 * Returns the template + a count of busy blocks seeded.
 */
export async function seedAvailabilityFromGoogle(
  deps: SeedAvailabilityDeps,
  input: { tenantId: string; now?: Date },
): Promise<{ template: AvailabilityTemplate; busyCount: number }> {
  const now = input.now ?? new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const calendarId = deps.calendarId ?? 'primary';

  const { busy } = await deps.freeBusy({ accessToken: deps.accessToken, timeMin, timeMax, calendarId });

  const template: AvailabilityTemplate = {
    source: 'google',
    generatedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    busy,
  };

  await deps.pool.query(
    `UPDATE tenant_settings SET availability_template = $2::jsonb, updated_at = now() WHERE tenant_id = $1`,
    [input.tenantId, JSON.stringify(template)],
  );

  return { template, busyCount: busy.length };
}
