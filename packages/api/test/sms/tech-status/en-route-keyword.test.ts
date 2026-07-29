/**
 * B5.5 (AC-5) — the SMS-keyword leg of "on my way".
 *
 * Handler-suite coverage: keyword match from a registered tech phone,
 * non-tech sender ignored, and the DNC/consent invariant staying untouched
 * (the handler delegates the actual SMS send to the SAME
 * DelayNotificationCoordinator the app button and the voice leg use — it
 * never implements its own send path that could bypass DNC).
 */
import { describe, it, expect, vi } from 'vitest';
import { InMemoryUserRepository, User } from '../../../src/users/user';
import { InMemoryAppointmentRepository, Appointment } from '../../../src/appointments/appointment';
import { InMemoryAssignmentRepository, AppointmentAssignment } from '../../../src/appointments/assignment';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InboundSmsContext } from '../../../src/sms/inbound-dispatch';
import type { EnRouteEnqueuer } from '../../../src/dispatch/routes';
import {
  handleEnRouteSms,
  EnRouteSmsKeywordHandler,
  EnRouteSmsHandlerDeps,
} from '../../../src/sms/tech-status/en-route-keyword';
import { EN_ROUTE_SMS_KEYWORDS } from '@ai-service-os/shared';

const TENANT = '11111111-1111-1111-1111-111111111111';
const TECH_ID = '22222222-2222-2222-2222-222222222222';
const OWNER_ID = '33333333-3333-3333-3333-333333333333';
const TECH_MOBILE = '+15551230001';
const OWNER_MOBILE = '+15551230002';
const NOW = new Date('2026-07-29T14:00:00.000Z');

function makeAppointment(id: string, start: string, end: string): Appointment {
  return {
    id,
    tenantId: TENANT,
    jobId: 'job-1',
    scheduledStart: new Date(start),
    scheduledEnd: new Date(end),
    timezone: 'UTC',
    status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'system',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface Harness {
  deps: EnRouteSmsHandlerDeps;
  auditRepo: InMemoryAuditRepository;
  enqueueEnRouteNotice: ReturnType<typeof vi.fn>;
}

async function buildHarness(enqueueResult: string | null = 'appt-1:en_route'): Promise<Harness> {
  const userRepo = new InMemoryUserRepository();
  const tech: Omit<User, 'createdAt' | 'updatedAt'> = {
    id: TECH_ID,
    tenantId: TENANT,
    email: 'tech@example.com',
    role: 'technician',
    canFieldServe: false,
    mobileNumber: TECH_MOBILE,
    firstName: 'Carlos',
    lastName: 'Ruiz',
  };
  const owner: Omit<User, 'createdAt' | 'updatedAt'> = {
    id: OWNER_ID,
    tenantId: TENANT,
    email: 'owner@example.com',
    role: 'owner',
    canFieldServe: true,
    mobileNumber: OWNER_MOBILE,
  };
  await userRepo.create(tech);
  await userRepo.create(owner);

  const assignmentRepo = new InMemoryAssignmentRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const appt = makeAppointment('appt-1', '2026-07-29T15:00:00.000Z', '2026-07-29T16:00:00.000Z');
  await appointmentRepo.create(appt);
  const assignment: AppointmentAssignment = {
    id: 'assign-1',
    tenantId: TENANT,
    appointmentId: 'appt-1',
    technicianId: TECH_ID,
    isPrimary: true,
    assignedBy: OWNER_ID,
    assignedAt: NOW,
  };
  await assignmentRepo.create(assignment);

  const auditRepo = new InMemoryAuditRepository();
  const enqueueEnRouteNotice = vi.fn(async () => enqueueResult);
  const enRouteCoordinator: EnRouteEnqueuer = { enqueueEnRouteNotice };

  const deps: EnRouteSmsHandlerDeps = {
    userRepo,
    assignmentRepo,
    appointmentRepo,
    enRouteCoordinator,
    auditRepo,
    // A real tenant has a zone. Without one the handler now declines rather
    // than fall back to a UTC service day, which late in a western tenant's
    // evening already contains the NEXT local morning.
    settingsRepo: {
      findByTenant: async () => ({ tenantId: TENANT, timezone: 'America/Chicago' }),
    } as never,
    now: () => NOW,
  };

  return { deps, auditRepo, enqueueEnRouteNotice };
}

function ctx(overrides: Partial<InboundSmsContext> = {}): InboundSmsContext {
  return {
    tenantId: TENANT,
    fromE164: TECH_MOBILE,
    body: 'OMW',
    messageSid: 'SM-en-route-1',
    ...overrides,
  };
}

describe('B5.5 — handleEnRouteSms', () => {
  it('a registered tech texting OMW fires the audited direct status act', async () => {
    const { deps, auditRepo, enqueueEnRouteNotice } = await buildHarness();

    const result = await handleEnRouteSms(ctx({ body: 'OMW' }), deps);

    expect(result.handled).toBe(true);
    expect(result.handler).toBe('en-route-sms');
    expect(enqueueEnRouteNotice).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, appointmentId: 'appt-1' }),
    );

    const events = await auditRepo.findByEntity(TENANT, 'appointment', 'appt-1');
    const triggered = events.find((e) => e.eventType === 'appointment.en_route_triggered');
    expect(triggered).toBeDefined();
    expect(triggered?.actorId).toBe(TECH_ID);
    expect(triggered?.actorRole).toBe('technician');
  });

  it('the literal phrase "on my way" also matches', async () => {
    const { deps } = await buildHarness();
    const result = await handleEnRouteSms(ctx({ body: 'on my way' }), deps);
    expect(result.handled).toBe(true);
  });

  it('a non-technician sender (e.g. the owner\'s own phone) is ignored, never actioned', async () => {
    const { deps, enqueueEnRouteNotice } = await buildHarness();

    const result = await handleEnRouteSms(ctx({ fromE164: OWNER_MOBILE }), deps);

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('not_a_technician');
    expect(enqueueEnRouteNotice).not.toHaveBeenCalled();
  });

  it('an unregistered/unknown mobile is ignored, never actioned', async () => {
    const { deps, enqueueEnRouteNotice } = await buildHarness();

    const result = await handleEnRouteSms(ctx({ fromE164: '+15559999999' }), deps);

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('unknown_mobile');
    expect(enqueueEnRouteNotice).not.toHaveBeenCalled();
  });

  it('DNC/consent invariant untouched: a DNC-suppressed customer (coordinator returns null) still records the act, never sends around the coordinator', async () => {
    // The coordinator (DelayNotificationCoordinator.enqueueEnRouteNotice)
    // owns DNC suppression internally and returns null when the customer
    // is opted out. This handler has no independent send path — it only
    // ever reaches the customer THROUGH the coordinator — so a DNC
    // suppression here proves the invariant is untouched, not bypassed.
    const { deps, enqueueEnRouteNotice } = await buildHarness(null);

    const result = await handleEnRouteSms(ctx({ body: 'OMW' }), deps);

    expect(result.handled).toBe(true);
    expect(result.reason).toBe('triggered_no_recipient');
    expect(enqueueEnRouteNotice).toHaveBeenCalledTimes(1);
  });

  it('no upcoming appointment today declines (never guesses), and the capture-all fallback can still pick it up', async () => {
    const userRepo = new InMemoryUserRepository();
    const tech: Omit<User, 'createdAt' | 'updatedAt'> = {
      id: TECH_ID,
      tenantId: TENANT,
      email: 'tech@example.com',
      role: 'technician',
      canFieldServe: false,
      mobileNumber: TECH_MOBILE,
    };
    await userRepo.create(tech);
    const enqueueEnRouteNotice = vi.fn(async () => 'x');
    const deps: EnRouteSmsHandlerDeps = {
      userRepo,
      assignmentRepo: new InMemoryAssignmentRepository(),
      appointmentRepo: new InMemoryAppointmentRepository(),
      enRouteCoordinator: { enqueueEnRouteNotice },
      // A real tenant has a zone; without one the handler declines rather
      // than fall back to a UTC day that can reach the next local morning.
      settingsRepo: {
        findByTenant: async () => ({ tenantId: TENANT, timezone: 'America/Chicago' }),
      } as never,
      now: () => NOW,
    };

    const result = await handleEnRouteSms(ctx({ body: 'OMW' }), deps);

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('no_upcoming_appointment');
    expect(enqueueEnRouteNotice).not.toHaveBeenCalled();
  });
});

describe('B5.5 — EnRouteSmsKeywordHandler registers the documented keyword set', () => {
  it('registers exactly EN_ROUTE_SMS_KEYWORDS (omw / on my way)', async () => {
    const { deps } = await buildHarness();
    const handler = new EnRouteSmsKeywordHandler(deps);
    expect(handler.keywords).toEqual(EN_ROUTE_SMS_KEYWORDS);
  });
});
