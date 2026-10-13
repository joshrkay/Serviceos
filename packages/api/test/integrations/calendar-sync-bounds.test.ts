/**
 * Reliability #5 — pushing an appointment to a technician's Google Calendar
 * runs on the appointment request path. With no fetch injected (production),
 * a Calendar API call that never answers is bounded at 10 s and lands as the
 * existing 'failed' outcome (recorded on the event row), never a hang.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCalendarIntegrationRepository } from '../../src/integrations/calendar-integration';
import {
  CalendarSyncService,
  InMemoryAppointmentCalendarEventRepository,
} from '../../src/integrations/calendar-sync';
import { hangingFetch, settleWithin, useProviderClock } from '../helpers/hanging-fetch';

const TENANT = 'tenant-sync-bounds';
const USER = 'user-tech-bounds';

describe('CalendarSyncService.pushForTechnician — bounded Google Calendar call', () => {
  let originalKey: string | undefined;
  beforeAll(() => {
    originalKey = process.env.TENANT_ENCRYPTION_KEY;
    process.env.TENANT_ENCRYPTION_KEY = '0'.repeat(64);
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = originalKey;
  });
  beforeEach(() => useProviderClock());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("an events insert that never answers becomes 'failed' at 10 s, recorded on the event row", async () => {
    const integrationRepo = new InMemoryCalendarIntegrationRepository();
    const eventRepo = new InMemoryAppointmentCalendarEventRepository();
    await integrationRepo.upsert({
      tenantId: TENANT,
      userId: USER,
      provider: 'google',
      accessToken: 'access-tok',
      refreshToken: 'refresh-tok',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      externalAccountEmail: 'tech@example.com',
    });
    vi.stubGlobal('fetch', hangingFetch((url) => url.includes('/calendar/v3/calendars/')));
    const svc = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: { clientId: 'c', clientSecret: 'cs', redirectUri: 'http://x' },
    });

    const outcome = await settleWithin(
      svc.pushForTechnician({
        tenantId: TENANT,
        appointmentId: 'appt-bounds',
        technicianUserId: USER,
        scheduledStart: new Date(),
        scheduledEnd: new Date(Date.now() + 60_000),
        timezone: 'UTC',
        summary: 'Tune-up',
      }),
      10_000,
    );

    expect(outcome).toEqual({ status: 'fulfilled', value: 'failed' });
    const [row] = await eventRepo.findByAppointment(TENANT, 'appt-bounds');
    expect(row?.status).toBe('failed');
    expect(row?.lastError).toMatch(/timed out/i);
  });
});
