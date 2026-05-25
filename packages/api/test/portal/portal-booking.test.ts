/**
 * Customer self-service booking — availability + book routes and the
 * shared booking-availability service.
 */
import { describe, it, expect } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { InMemoryPortalSessionRepository } from '../../src/portal/portal-session';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryAgreementRepository } from '../../src/agreements/agreement';
import { InMemoryAppointmentRepository, createAppointment } from '../../src/appointments/appointment';
import { InMemoryAssignmentRepository } from '../../src/appointments/assignment';
import { InMemoryLocationRepository, createLocation } from '../../src/locations/location';
import { InMemoryLeadRepository } from '../../src/leads/lead';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemorySettingsRepository, createSettings } from '../../src/settings/settings';
import { createPortalRouter } from '../../src/routes/portal';
import { createPublicPortalRouter } from '../../src/routes/public-portal';
import { findBookableSlots, isSlotFree } from '../../src/scheduling/booking-availability';

const TENANT = uuidv4();
const ACTOR = 'user-test';

async function build() {
  const app = express();
  app.use(express.json());

  const portalRepo = new InMemoryPortalSessionRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const jobRepo = new InMemoryJobRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const assignmentRepo = new InMemoryAssignmentRepository();
  const locationRepo = new InMemoryLocationRepository();
  const leadRepo = new InMemoryLeadRepository();
  const auditRepo = new InMemoryAuditRepository();
  const proposalRepo = new InMemoryProposalRepository();
  const settingsRepo = new InMemorySettingsRepository();

  await createSettings({ tenantId: TENANT, businessName: 'Acme', timezone: 'America/New_York' }, settingsRepo);

  const customer = await customerRepo.create({
    id: uuidv4(),
    tenantId: TENANT,
    firstName: 'Pat',
    lastName: 'Customer',
    displayName: 'Pat Customer',
    email: 'pat@example.com',
    primaryPhone: '+15555550100',
    preferredChannel: 'email',
    smsConsent: false,
    isArchived: false,
    createdBy: ACTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const location = await createLocation(
    {
      tenantId: TENANT,
      customerId: customer.id,
      street1: '1 Main St',
      city: 'Town',
      state: 'NY',
      postalCode: '10001',
      isPrimary: true,
    },
    locationRepo,
  );

  app.use(
    '/api/public/portal',
    createPublicPortalRouter({
      portalRepo,
      customerRepo,
      estimateRepo: new InMemoryEstimateRepository(),
      invoiceRepo: new InMemoryInvoiceRepository(),
      jobRepo,
      agreementRepo: new InMemoryAgreementRepository(),
      appointmentRepo,
      leadRepo,
      auditRepo,
      assignmentRepo,
      locationRepo,
      proposalRepo,
      settingsRepo,
    }),
  );

  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: ACTOR,
      sessionId: 'session-1',
      tenantId: TENANT,
      role: 'owner',
    };
    next();
  });
  app.use('/api/portal-sessions', createPortalRouter({ portalRepo, customerRepo }));

  return { app, customer, location, jobRepo, appointmentRepo, proposalRepo, auditRepo };
}

async function mintToken(app: express.Express, customerId: string): Promise<string> {
  const res = await request(app).post('/api/portal-sessions').send({ customerId });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

// Far-future fixed weekday window so "now" never invalidates the slots.
const FROM = '2030-06-03'; // Monday
const TO = '2030-06-03';

describe('booking-availability service', () => {
  it('returns business-hours slots and excludes busy windows', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    // 09:00-10:00 ET == 13:00-14:00Z on 2030-06-03 (EDT, UTC-4).
    await createAppointment(
      {
        tenantId: TENANT,
        jobId: uuidv4(),
        scheduledStart: new Date('2030-06-03T13:00:00Z'),
        scheduledEnd: new Date('2030-06-03T14:00:00Z'),
        timezone: 'America/New_York',
        createdBy: ACTOR,
      },
      appointmentRepo,
    );

    const slots = await findBookableSlots(
      { appointmentRepo },
      { tenantId: TENANT, fromDate: FROM, toDate: TO, timezone: 'America/New_York', durationMin: 60, maxSlots: 10 },
    );

    expect(slots.length).toBeGreaterThan(0);
    // No slot overlaps the busy 13:00-14:00Z window.
    for (const s of slots) {
      const overlaps =
        s.start.getTime() < Date.parse('2030-06-03T14:00:00Z') &&
        s.end.getTime() > Date.parse('2030-06-03T13:00:00Z');
      expect(overlaps).toBe(false);
    }
    // All slots fall within 08:00-17:00 ET (12:00Z-21:00Z on this date).
    for (const s of slots) {
      expect(s.start.getTime()).toBeGreaterThanOrEqual(Date.parse('2030-06-03T12:00:00Z'));
      expect(s.end.getTime()).toBeLessThanOrEqual(Date.parse('2030-06-03T21:00:00Z'));
    }
  });

  it('isSlotFree returns false once the slot is held', async () => {
    const appointmentRepo = new InMemoryAppointmentRepository();
    const start = new Date('2030-06-03T15:00:00Z');
    const end = new Date('2030-06-03T16:00:00Z');
    expect(await isSlotFree({ appointmentRepo }, { tenantId: TENANT, start, end })).toBe(true);
    await createAppointment(
      { tenantId: TENANT, jobId: uuidv4(), scheduledStart: start, scheduledEnd: end, timezone: 'UTC', createdBy: ACTOR },
      appointmentRepo,
    );
    expect(await isSlotFree({ appointmentRepo }, { tenantId: TENANT, start, end })).toBe(false);
  });
});

describe('GET /:token/availability', () => {
  it('returns slots in the tenant timezone', async () => {
    const h = await build();
    const token = await mintToken(h.app, h.customer.id);
    const res = await request(h.app).get(
      `/api/public/portal/${token}/availability?from=${FROM}&to=${TO}&durationMin=60`,
    );
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe('America/New_York');
    expect(Array.isArray(res.body.slots)).toBe(true);
    expect(res.body.slots.length).toBeGreaterThan(0);
  });

  it('rejects a malformed date', async () => {
    const h = await build();
    const token = await mintToken(h.app, h.customer.id);
    const res = await request(h.app).get(`/api/public/portal/${token}/availability?from=nope&to=${TO}`);
    expect(res.status).toBe(400);
  });
});

describe('POST /:token/book', () => {
  it('creates a held appointment + create_booking proposal (pending confirmation)', async () => {
    const h = await build();
    const token = await mintToken(h.app, h.customer.id);

    const res = await request(h.app)
      .post(`/api/public/portal/${token}/book`)
      .send({
        slotStart: '2030-06-03T15:00:00Z',
        slotEnd: '2030-06-03T16:00:00Z',
        summary: 'Leaky faucet',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_confirmation');
    expect(res.body.proposalId).toBeTruthy();

    const appt = await h.appointmentRepo.findById(TENANT, res.body.appointmentId);
    expect(appt?.holdPendingApproval).toBe(true);

    const proposal = await h.proposalRepo.findById(TENANT, res.body.proposalId);
    expect(proposal?.proposalType).toBe('create_booking');
    // Customer bookings are never auto-approved.
    expect(proposal?.status).toBe('draft');
    expect(proposal?.payload.appointmentId).toBe(res.body.appointmentId);
  });

  it('returns 409 with alternatives when the slot was already taken', async () => {
    const h = await build();
    const token = await mintToken(h.app, h.customer.id);

    // Pre-occupy the slot.
    await createAppointment(
      {
        tenantId: TENANT,
        jobId: uuidv4(),
        scheduledStart: new Date('2030-06-03T15:00:00Z'),
        scheduledEnd: new Date('2030-06-03T16:00:00Z'),
        timezone: 'UTC',
        createdBy: ACTOR,
      },
      h.appointmentRepo,
    );

    const res = await request(h.app)
      .post(`/api/public/portal/${token}/book`)
      .send({ slotStart: '2030-06-03T15:00:00Z', slotEnd: '2030-06-03T16:00:00Z', summary: 'Leaky faucet' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('SLOT_TAKEN');
    expect(Array.isArray(res.body.alternatives)).toBe(true);
  });

  it('rejects a past slot', async () => {
    const h = await build();
    const token = await mintToken(h.app, h.customer.id);
    const res = await request(h.app)
      .post(`/api/public/portal/${token}/book`)
      .send({ slotStart: '2020-01-01T15:00:00Z', slotEnd: '2020-01-01T16:00:00Z', summary: 'x' });
    expect(res.status).toBe(400);
  });
});

async function seedOwnedAppointment(h: Awaited<ReturnType<typeof build>>, start: string, end: string) {
  const job = await h.jobRepo.create({
    id: uuidv4(),
    tenantId: TENANT,
    customerId: h.customer.id,
    locationId: h.location.id,
    jobNumber: 'JOB-0001',
    summary: 'Existing',
    status: 'scheduled',
    priority: 'normal',
    createdBy: ACTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return createAppointment(
    { tenantId: TENANT, jobId: job.id, scheduledStart: new Date(start), scheduledEnd: new Date(end), timezone: 'UTC', createdBy: ACTOR },
    h.appointmentRepo,
  );
}

describe('POST /:token/appointments/:id/cancel', () => {
  it('emits a cancel_appointment proposal (pending confirmation)', async () => {
    const h = await build();
    const token = await mintToken(h.app, h.customer.id);
    const appt = await seedOwnedAppointment(h, '2030-06-03T15:00:00Z', '2030-06-03T16:00:00Z');

    const res = await request(h.app)
      .post(`/api/public/portal/${token}/appointments/${appt.id}/cancel`)
      .send({ reason: 'Out of town' });

    expect(res.status).toBe(201);
    const proposal = await h.proposalRepo.findById(TENANT, res.body.proposalId);
    expect(proposal?.proposalType).toBe('cancel_appointment');
    expect(proposal?.payload.appointmentId).toBe(appt.id);
  });

  it('refuses to cancel another customer\'s appointment with 404', async () => {
    const h = await build();
    const token = await mintToken(h.app, h.customer.id);
    // Appointment whose job belongs to no customer in this portal.
    const orphan = await createAppointment(
      { tenantId: TENANT, jobId: uuidv4(), scheduledStart: new Date('2030-06-03T15:00:00Z'), scheduledEnd: new Date('2030-06-03T16:00:00Z'), timezone: 'UTC', createdBy: ACTOR },
      h.appointmentRepo,
    );
    const res = await request(h.app)
      .post(`/api/public/portal/${token}/appointments/${orphan.id}/cancel`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('refuses to cancel inside the cutoff window with 409', async () => {
    const h = await build();
    const token = await mintToken(h.app, h.customer.id);
    const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const soonEnd = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    const appt = await seedOwnedAppointment(h, soon, soonEnd);
    const res = await request(h.app)
      .post(`/api/public/portal/${token}/appointments/${appt.id}/cancel`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('TOO_LATE');
  });
});

describe('POST /:token/appointments/:id/reschedule', () => {
  it('emits a reschedule_appointment proposal for an open slot', async () => {
    const h = await build();
    const token = await mintToken(h.app, h.customer.id);
    const appt = await seedOwnedAppointment(h, '2030-06-03T15:00:00Z', '2030-06-03T16:00:00Z');

    const res = await request(h.app)
      .post(`/api/public/portal/${token}/appointments/${appt.id}/reschedule`)
      .send({ slotStart: '2030-06-04T18:00:00Z', slotEnd: '2030-06-04T19:00:00Z' });

    expect(res.status).toBe(201);
    const proposal = await h.proposalRepo.findById(TENANT, res.body.proposalId);
    expect(proposal?.proposalType).toBe('reschedule_appointment');
    expect(proposal?.payload.newScheduledStart).toBe('2030-06-04T18:00:00.000Z');
  });
});
