import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import {
  InMemoryCalendarIntegrationRepository,
} from '../../src/integrations/calendar-integration';
import {
  CalendarSyncService,
  InMemoryAppointmentCalendarEventRepository,
} from '../../src/integrations/calendar-sync';

const TEST_KEY = '0'.repeat(64);
const TENANT = 'tenant-sync';
const USER = 'user-tech-1';

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('CalendarSyncService — Tier 4 Calendar sync (PR 2)', () => {
  let originalKey: string | undefined;
  let integrationRepo: InMemoryCalendarIntegrationRepository;
  let eventRepo: InMemoryAppointmentCalendarEventRepository;

  beforeAll(() => {
    originalKey = process.env.TENANT_ENCRYPTION_KEY;
    process.env.TENANT_ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = originalKey;
  });

  beforeEach(async () => {
    integrationRepo = new InMemoryCalendarIntegrationRepository();
    eventRepo = new InMemoryAppointmentCalendarEventRepository();
  });

  async function seedConnected() {
    await integrationRepo.upsert({
      tenantId: TENANT,
      userId: USER,
      provider: 'google',
      accessToken: 'access-tok',
      refreshToken: 'refresh-tok',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      externalAccountEmail: 'tech@example.com',
    });
  }

  it("returns 'skipped' when the technician has no integration", async () => {
    const svc = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: { clientId: 'c', clientSecret: 'cs', redirectUri: 'http://x' },
    });
    const outcome = await svc.pushForTechnician({
      tenantId: TENANT,
      appointmentId: 'appt-1',
      technicianUserId: 'never-connected',
      scheduledStart: new Date(),
      scheduledEnd: new Date(Date.now() + 60_000),
      timezone: 'UTC',
      summary: 'Test',
    });
    expect(outcome).toBe('skipped');
  });

  it("returns 'skipped' when integration status is not active (e.g. revoked)", async () => {
    await seedConnected();
    await integrationRepo.revoke(TENANT, USER, 'google');
    const svc = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: { clientId: 'c', clientSecret: 'cs', redirectUri: 'http://x' },
    });
    const outcome = await svc.pushForTechnician({
      tenantId: TENANT,
      appointmentId: 'appt-1',
      technicianUserId: USER,
      scheduledStart: new Date(),
      scheduledEnd: new Date(Date.now() + 60_000),
      timezone: 'UTC',
      summary: 'Test',
    });
    expect(outcome).toBe('skipped');
  });

  it("returns 'skipped' when googleConfig is not wired", async () => {
    await seedConnected();
    const svc = new CalendarSyncService({ integrationRepo, eventRepo });
    const outcome = await svc.pushForTechnician({
      tenantId: TENANT,
      appointmentId: 'appt-1',
      technicianUserId: USER,
      scheduledStart: new Date(),
      scheduledEnd: new Date(Date.now() + 60_000),
      timezone: 'UTC',
      summary: 'Test',
    });
    expect(outcome).toBe('skipped');
  });

  it("pushes a Google Calendar event and persists external_event_id on success", async () => {
    await seedConnected();
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/calendars/primary/events') && !url.includes('list')) {
        return jsonRes({ id: 'evt-google-123', htmlLink: 'https://...' }, 200);
      }
      return jsonRes({}, 404);
    });
    const svc = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: { clientId: 'c', clientSecret: 'cs', redirectUri: 'http://x' },
      googleFetch: fetchMock as unknown as typeof fetch,
    });
    const outcome = await svc.pushForTechnician({
      tenantId: TENANT,
      appointmentId: 'appt-1',
      technicianUserId: USER,
      scheduledStart: new Date('2026-06-01T15:00:00Z'),
      scheduledEnd: new Date('2026-06-01T16:00:00Z'),
      timezone: 'America/Los_Angeles',
      summary: 'AC tune-up — Sarah Johnson',
      description: 'Repair the heat exchanger.',
      location: '123 Main St',
    });
    expect(outcome).toBe('synced');

    // Persisted on the local row.
    const events = await eventRepo.findByAppointment(TENANT, 'appt-1');
    expect(events).toHaveLength(1);
    expect(events[0].externalEventId).toBe('evt-google-123');
    expect(events[0].status).toBe('synced');

    // The Google POST body carries the right shape.
    const call = fetchMock.mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.summary).toBe('AC tune-up — Sarah Johnson');
    expect(body.start.dateTime).toBe('2026-06-01T15:00:00.000Z');
    expect(body.start.timeZone).toBe('America/Los_Angeles');
    expect(body.extendedProperties.private.serviceos_appointment_id).toBe('appt-1');
  });

  it("records 'failed' status on Google API error without throwing", async () => {
    await seedConnected();
    const fetchMock = vi.fn(async () => jsonRes({ error: 'forbidden' }, 403));
    const svc = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: { clientId: 'c', clientSecret: 'cs', redirectUri: 'http://x' },
      googleFetch: fetchMock as unknown as typeof fetch,
    });

    const outcome = await svc.pushForTechnician({
      tenantId: TENANT,
      appointmentId: 'appt-2',
      technicianUserId: USER,
      scheduledStart: new Date(),
      scheduledEnd: new Date(Date.now() + 60_000),
      timezone: 'UTC',
      summary: 'Test',
    });
    expect(outcome).toBe('failed');

    const events = await eventRepo.findByAppointment(TENANT, 'appt-2');
    expect(events[0].status).toBe('failed');
    expect(events[0].lastError).toContain('403');
  });

  it("re-pushing for the same (appointment, tech) overwrites the local row", async () => {
    await seedConnected();
    let firstCall = true;
    const fetchMock = vi.fn(async () => {
      const id = firstCall ? 'evt-1' : 'evt-2';
      firstCall = false;
      return jsonRes({ id });
    });
    const svc = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: { clientId: 'c', clientSecret: 'cs', redirectUri: 'http://x' },
      googleFetch: fetchMock as unknown as typeof fetch,
    });

    const input = {
      tenantId: TENANT,
      appointmentId: 'appt-3',
      technicianUserId: USER,
      scheduledStart: new Date(),
      scheduledEnd: new Date(Date.now() + 60_000),
      timezone: 'UTC',
      summary: 'T',
    };
    await svc.pushForTechnician(input);
    await svc.pushForTechnician(input);

    const events = await eventRepo.findByAppointment(TENANT, 'appt-3');
    expect(events).toHaveLength(1);
    expect(events[0].externalEventId).toBe('evt-2');
  });

  it("persist:false skips the eventRepo upsert (PR 320 P1 — test-push path)", async () => {
    // Codex flagged that test-push uses a synthetic non-UUID
    // appointmentId; persisting would fail the FK in Pg and report
    // 'failed' even when Google succeeds. With persist:false, the
    // sync should still report 'synced' AND no event row written.
    await seedConnected();
    const fetchMock = vi.fn(async () => jsonRes({ id: 'evt-test' }));
    const svc = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: { clientId: 'c', clientSecret: 'cs', redirectUri: 'http://x' },
      googleFetch: fetchMock as unknown as typeof fetch,
    });

    const outcome = await svc.pushForTechnician(
      {
        tenantId: TENANT,
        appointmentId: 'test-push-xyz', // not a UUID
        technicianUserId: USER,
        scheduledStart: new Date(),
        scheduledEnd: new Date(Date.now() + 60_000),
        timezone: 'UTC',
        summary: 'T',
      },
      { persist: false },
    );
    expect(outcome).toBe('synced');

    // No row written — the test-push doesn't track lifecycle.
    const events = await eventRepo.findByAppointment(TENANT, 'test-push-xyz');
    expect(events).toEqual([]);
  });

  it("persist:false ALSO skips the failure upsert", async () => {
    await seedConnected();
    const fetchMock = vi.fn(async () => jsonRes({ error: 'boom' }, 500));
    const svc = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: { clientId: 'c', clientSecret: 'cs', redirectUri: 'http://x' },
      googleFetch: fetchMock as unknown as typeof fetch,
    });
    const outcome = await svc.pushForTechnician(
      {
        tenantId: TENANT, appointmentId: 'test-push-zzz',
        technicianUserId: USER,
        scheduledStart: new Date(), scheduledEnd: new Date(Date.now() + 60_000),
        timezone: 'UTC', summary: 'T',
      },
      { persist: false },
    );
    expect(outcome).toBe('failed');
    const events = await eventRepo.findByAppointment(TENANT, 'test-push-zzz');
    expect(events).toEqual([]);
  });

  it('pushForTechnicians aggregates outcomes across multiple techs', async () => {
    await seedConnected();
    // Second tech is connected too.
    await integrationRepo.upsert({
      tenantId: TENANT,
      userId: 'user-tech-2',
      provider: 'google',
      accessToken: 'a2',
      refreshToken: 'r2',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      externalAccountEmail: 't2@example.com',
    });
    const fetchMock = vi.fn(async () => jsonRes({ id: 'evt-x' }));
    const svc = new CalendarSyncService({
      integrationRepo,
      eventRepo,
      googleConfig: { clientId: 'c', clientSecret: 'cs', redirectUri: 'http://x' },
      googleFetch: fetchMock as unknown as typeof fetch,
    });

    const result = await svc.pushForTechnicians([
      {
        tenantId: TENANT, appointmentId: 'appt-4',
        technicianUserId: USER,
        scheduledStart: new Date(), scheduledEnd: new Date(Date.now() + 60_000),
        timezone: 'UTC', summary: 'T',
      },
      {
        tenantId: TENANT, appointmentId: 'appt-4',
        technicianUserId: 'user-tech-2',
        scheduledStart: new Date(), scheduledEnd: new Date(Date.now() + 60_000),
        timezone: 'UTC', summary: 'T',
      },
      {
        tenantId: TENANT, appointmentId: 'appt-4',
        technicianUserId: 'user-tech-3-not-connected',
        scheduledStart: new Date(), scheduledEnd: new Date(Date.now() + 60_000),
        timezone: 'UTC', summary: 'T',
      },
    ]);
    expect(result.pushedFor.sort()).toEqual([USER, 'user-tech-2'].sort());
    expect(result.skipped).toEqual(['user-tech-3-not-connected']);
    expect(result.failed).toEqual([]);
  });
});
