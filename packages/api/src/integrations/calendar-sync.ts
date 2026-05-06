import { v4 as uuidv4 } from 'uuid';
import type { Pool } from 'pg';
import {
  CalendarIntegrationRepository,
  CalendarProvider,
} from './calendar-integration';
import { GoogleOAuthConfig, GoogleFetch, getValidAccessToken } from './google-calendar';

/**
 * Tier 4 (Calendar sync — PR 2). Pushes appointments into each
 * assigned technician's connected Google Calendar.
 *
 * Hook points:
 *   - POST /api/appointments  → push for whoever is assigned at create.
 *   - POST /api/appointments/:id/assignments → push for the new assignee.
 *
 * Best-effort: failures are recorded in `appointment_calendar_events`
 * with status='failed' + last_error so dispatch can retry. Failures
 * MUST NOT bubble back to the caller — appointment creation already
 * succeeded by the time we hit the sync hook.
 *
 * Update + delete sync are deferred to PR 3 (this PR only writes
 * fresh events on create + assignment).
 */

export interface CalendarEventInput {
  tenantId: string;
  appointmentId: string;
  /** Clerk subject of the assigned technician. */
  technicianUserId: string;
  /** UTC instant; passed to Google as RFC3339 with timezone hint. */
  scheduledStart: Date;
  scheduledEnd: Date;
  /** IANA tz used for Google's `timeZone` field on each datetime. */
  timezone: string;
  /** Title of the event, e.g. "AC tune-up — Sarah Johnson". */
  summary: string;
  description?: string;
  /** Optional address rendered in the event location field. */
  location?: string;
}

export interface AppointmentCalendarEvent {
  id: string;
  tenantId: string;
  appointmentId: string;
  userId: string;
  provider: CalendarProvider;
  externalEventId: string | null;
  externalCalendarId: string;
  status: 'synced' | 'failed' | 'deleted';
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppointmentCalendarEventRepository {
  /** Upsert keyed on (appointment_id, user_id, provider). Re-syncs
   *  overwrite the prior event id. */
  upsert(input: {
    tenantId: string;
    appointmentId: string;
    userId: string;
    provider: CalendarProvider;
    externalEventId: string | null;
    externalCalendarId: string;
    status: AppointmentCalendarEvent['status'];
    lastError?: string | null;
  }): Promise<AppointmentCalendarEvent>;
  findByAppointment(
    tenantId: string,
    appointmentId: string,
  ): Promise<AppointmentCalendarEvent[]>;
}

export interface CalendarSyncResult {
  pushedFor: string[]; // tech userIds we successfully synced
  skipped: string[];   // tech userIds with no active integration
  failed: string[];    // tech userIds where push failed
}

export class CalendarSyncService {
  constructor(
    private readonly deps: {
      integrationRepo: CalendarIntegrationRepository;
      eventRepo: AppointmentCalendarEventRepository;
      googleConfig?: GoogleOAuthConfig;
      googleFetch?: GoogleFetch;
    },
  ) {}

  /**
   * Push the event for one technician. Idempotent at the (appointment,
   * tech) granularity — a re-push overwrites the local row. Returns
   * 'skipped' when the tech has no active Google connection.
   *
   * Failure mode: any error is captured to the local event row with
   * status='failed' and re-classified as 'failed' in the result, but
   * never thrown — the caller must not be blocked by sync hiccups.
   */
  async pushForTechnician(
    input: CalendarEventInput,
  ): Promise<'synced' | 'skipped' | 'failed'> {
    const integration = await this.deps.integrationRepo.findByUser(
      input.tenantId,
      input.technicianUserId,
      'google',
    );
    if (!integration || integration.status !== 'active') return 'skipped';
    if (!this.deps.googleConfig) return 'skipped';

    try {
      const accessToken = await getValidAccessToken(
        integration,
        this.deps.googleConfig,
        this.deps.integrationRepo,
        this.deps.googleFetch ?? fetch,
      );
      const eventBody: Record<string, unknown> = {
        summary: input.summary,
        description: input.description ?? null,
        location: input.location ?? null,
        start: {
          dateTime: input.scheduledStart.toISOString(),
          timeZone: input.timezone,
        },
        end: {
          dateTime: input.scheduledEnd.toISOString(),
          timeZone: input.timezone,
        },
        // Local opaque ref so a future update can find the same
        // event via the events.list `privateExtendedProperty` filter.
        extendedProperties: {
          private: {
            serviceos_appointment_id: input.appointmentId,
            serviceos_tenant_id: input.tenantId,
          },
        },
      };

      const fetchFn = this.deps.googleFetch ?? fetch;
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(integration.calendarId)}/events`;
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(eventBody),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Google Calendar POST failed (${res.status}): ${body}`);
      }
      const ev = (await res.json()) as { id?: string };
      if (!ev.id) throw new Error('Google Calendar response missing event id');

      await this.deps.eventRepo.upsert({
        tenantId: input.tenantId,
        appointmentId: input.appointmentId,
        userId: input.technicianUserId,
        provider: 'google',
        externalEventId: ev.id,
        externalCalendarId: integration.calendarId,
        status: 'synced',
        lastError: null,
      });
      return 'synced';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.deps.eventRepo.upsert({
          tenantId: input.tenantId,
          appointmentId: input.appointmentId,
          userId: input.technicianUserId,
          provider: 'google',
          externalEventId: null,
          externalCalendarId: integration.calendarId,
          status: 'failed',
          lastError: message,
        });
      } catch {
        // Best-effort; the original error is already lost into the
        // route's audit handler.
      }
      return 'failed';
    }
  }

  async pushForTechnicians(
    inputs: CalendarEventInput[],
  ): Promise<CalendarSyncResult> {
    const result: CalendarSyncResult = { pushedFor: [], skipped: [], failed: [] };
    for (const input of inputs) {
      const outcome = await this.pushForTechnician(input);
      if (outcome === 'synced') result.pushedFor.push(input.technicianUserId);
      else if (outcome === 'skipped') result.skipped.push(input.technicianUserId);
      else result.failed.push(input.technicianUserId);
    }
    return result;
  }
}

/* ───────────────────── In-memory + Pg repos ───────────────────── */

export class InMemoryAppointmentCalendarEventRepository
  implements AppointmentCalendarEventRepository
{
  private rows: Map<string, AppointmentCalendarEvent> = new Map();

  private key(appointmentId: string, userId: string, provider: CalendarProvider): string {
    return `${appointmentId}:${userId}:${provider}`;
  }

  async upsert(input: {
    tenantId: string;
    appointmentId: string;
    userId: string;
    provider: CalendarProvider;
    externalEventId: string | null;
    externalCalendarId: string;
    status: AppointmentCalendarEvent['status'];
    lastError?: string | null;
  }): Promise<AppointmentCalendarEvent> {
    const k = this.key(input.appointmentId, input.userId, input.provider);
    const existing = this.rows.get(k);
    const now = new Date();
    const row: AppointmentCalendarEvent = {
      id: existing?.id ?? uuidv4(),
      tenantId: input.tenantId,
      appointmentId: input.appointmentId,
      userId: input.userId,
      provider: input.provider,
      externalEventId: input.externalEventId,
      externalCalendarId: input.externalCalendarId,
      status: input.status,
      lastError: input.lastError ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(k, row);
    return { ...row };
  }

  async findByAppointment(
    tenantId: string,
    appointmentId: string,
  ): Promise<AppointmentCalendarEvent[]> {
    return Array.from(this.rows.values())
      .filter((r) => r.tenantId === tenantId && r.appointmentId === appointmentId)
      .map((r) => ({ ...r }));
  }
}

export class PgAppointmentCalendarEventRepository
  implements AppointmentCalendarEventRepository
{
  constructor(private pool: Pool) {}

  private map(row: Record<string, unknown>): AppointmentCalendarEvent {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      appointmentId: row.appointment_id as string,
      userId: row.user_id as string,
      provider: row.provider as CalendarProvider,
      externalEventId: (row.external_event_id as string | null) ?? null,
      externalCalendarId: row.external_calendar_id as string,
      status: row.status as AppointmentCalendarEvent['status'],
      lastError: (row.last_error as string | null) ?? null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  async upsert(input: {
    tenantId: string;
    appointmentId: string;
    userId: string;
    provider: CalendarProvider;
    externalEventId: string | null;
    externalCalendarId: string;
    status: AppointmentCalendarEvent['status'];
    lastError?: string | null;
  }): Promise<AppointmentCalendarEvent> {
    const result = await this.pool.query(
      `INSERT INTO appointment_calendar_events
         (tenant_id, appointment_id, user_id, provider,
          external_event_id, external_calendar_id, status, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (appointment_id, user_id, provider) DO UPDATE SET
         external_event_id = EXCLUDED.external_event_id,
         external_calendar_id = EXCLUDED.external_calendar_id,
         status = EXCLUDED.status,
         last_error = EXCLUDED.last_error,
         updated_at = NOW()
       RETURNING *`,
      [
        input.tenantId,
        input.appointmentId,
        input.userId,
        input.provider,
        input.externalEventId,
        input.externalCalendarId,
        input.status,
        input.lastError ?? null,
      ],
    );
    return this.map(result.rows[0] as Record<string, unknown>);
  }

  async findByAppointment(
    tenantId: string,
    appointmentId: string,
  ): Promise<AppointmentCalendarEvent[]> {
    const result = await this.pool.query(
      `SELECT * FROM appointment_calendar_events
       WHERE tenant_id = $1 AND appointment_id = $2`,
      [tenantId, appointmentId],
    );
    return result.rows.map((r) => this.map(r as Record<string, unknown>));
  }
}
