import { describe, it, expect, beforeEach } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { createPublicBookingRouter } from '../../src/routes/public-booking';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAssignmentRepository } from '../../src/appointments/assignment';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemorySettingsRepository } from '../../src/settings/settings';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { DevInMemoryTenantRepository } from '../../src/auth/dev-auth-bypass';

/** A YYYY-MM-DD date `days` from today, in UTC (tests use a UTC tenant tz). */
function isoDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe('public-booking route', () => {
  let app: Express;
  let customerRepo: InMemoryCustomerRepository;
  let locationRepo: InMemoryLocationRepository;
  let jobRepo: InMemoryJobRepository;
  let appointmentRepo: InMemoryAppointmentRepository;
  let assignmentRepo: InMemoryAssignmentRepository;
  let proposalRepo: InMemoryProposalRepository;
  let settingsRepo: InMemorySettingsRepository;
  let auditRepo: InMemoryAuditRepository;
  let tenantRepo: DevInMemoryTenantRepository;
  let tenantId: string;

  beforeEach(async () => {
    customerRepo = new InMemoryCustomerRepository();
    locationRepo = new InMemoryLocationRepository();
    jobRepo = new InMemoryJobRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
    assignmentRepo = new InMemoryAssignmentRepository();
    proposalRepo = new InMemoryProposalRepository();
    settingsRepo = new InMemorySettingsRepository();
    auditRepo = new InMemoryAuditRepository();
    tenantRepo = new DevInMemoryTenantRepository();
    const tenant = await tenantRepo.create({
      ownerId: 'owner-1',
      ownerEmail: 'owner@example.com',
      name: 'Rivera HVAC',
    });
    tenantId = tenant.id;

    // Pin the tenant to UTC so the test can reason about slot windows without
    // local-timezone drift.
    await settingsRepo.create({
      id: 'settings-1',
      tenantId,
      businessName: 'Rivera HVAC',
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      activeVerticalPacks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    app = express();
    app.use(express.json());
    app.use(
      '/api/public/booking',
      createPublicBookingRouter({
        tenantRepo,
        customerRepo,
        locationRepo,
        jobRepo,
        appointmentRepo,
        assignmentRepo,
        proposalRepo,
        settingsRepo,
        auditRepo,
      }),
    );
  });

  const validBooking = (slotStart: string, slotEnd: string) => ({
    firstName: 'Sandra',
    lastName: 'Wu',
    primaryPhone: '5125550100',
    email: 'sandra@example.com',
    street1: '123 Maple St',
    city: 'Phoenix',
    state: 'AZ',
    postalCode: '85001',
    summary: 'AC not cooling',
    serviceType: 'HVAC repair',
    slotStart,
    slotEnd,
  });

  /** Fetch the first available 60-min slot a few days out. */
  async function firstSlot(): Promise<{ start: string; end: string }> {
    const res = await request(app)
      .get(`/api/public/booking/${tenantId}/availability`)
      .query({ from: isoDate(1), to: isoDate(3), durationMin: 60 });
    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBeGreaterThan(0);
    return res.body.slots[0];
  }

  describe('GET /:tenantId/availability', () => {
    it('returns open slots in the tenant timezone', async () => {
      const res = await request(app)
        .get(`/api/public/booking/${tenantId}/availability`)
        .query({ from: isoDate(1), to: isoDate(2), durationMin: 60 });
      expect(res.status).toBe(200);
      expect(res.body.timezone).toBe('UTC');
      expect(res.body.durationMin).toBe(60);
      expect(Array.isArray(res.body.slots)).toBe(true);
      expect(res.body.slots.length).toBeGreaterThan(0);
      for (const s of res.body.slots) {
        expect(new Date(s.end).getTime()).toBeGreaterThan(new Date(s.start).getTime());
      }
    });

    it('returns 404 for an unknown tenant', async () => {
      const res = await request(app)
        .get('/api/public/booking/00000000-0000-4000-8000-000000000099/availability')
        .query({ from: isoDate(1), to: isoDate(2) });
      expect(res.status).toBe(404);
    });

    it('returns 400 for a malformed tenant id', async () => {
      const res = await request(app)
        .get('/api/public/booking/not-a-uuid/availability')
        .query({ from: isoDate(1), to: isoDate(2) });
      expect(res.status).toBe(400);
    });

    it('returns 400 for a malformed date range', async () => {
      const res = await request(app)
        .get(`/api/public/booking/${tenantId}/availability`)
        .query({ from: 'nope', to: isoDate(2) });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /:tenantId', () => {
    it('creates a customer, location, job, held appointment, and a create_booking proposal', async () => {
      const slot = await firstSlot();
      const res = await request(app)
        .post(`/api/public/booking/${tenantId}`)
        .send(validBooking(slot.start, slot.end));

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending_confirmation');
      expect(res.body.appointmentId).toBeTruthy();
      expect(res.body.proposalId).toBeTruthy();

      // The appointment is a tentative hold, not a confirmed booking.
      const appt = await appointmentRepo.findById(tenantId, res.body.appointmentId);
      expect(appt?.holdPendingApproval).toBe(true);
      expect(appt?.holdExpiryAt).toBeTruthy();

      // A draft create_booking proposal awaits the owner.
      const proposal = await proposalRepo.findById(tenantId, res.body.proposalId);
      expect(proposal?.proposalType).toBe('create_booking');
      expect(proposal?.status).toBe('draft');
      expect((proposal?.payload as { appointmentId: string }).appointmentId).toBe(
        res.body.appointmentId,
      );

      // The prospect became a customer with a service location.
      const customers = await customerRepo.findByTenant(tenantId);
      expect(customers).toHaveLength(1);
      expect(customers[0].firstName).toBe('Sandra');
    });

    it('rejects a second booking of the same slot with 409 + alternatives (no double-book)', async () => {
      const slot = await firstSlot();
      const first = await request(app)
        .post(`/api/public/booking/${tenantId}`)
        .send(validBooking(slot.start, slot.end));
      expect(first.status).toBe(201);

      const second = await request(app)
        .post(`/api/public/booking/${tenantId}`)
        .send(validBooking(slot.start, slot.end));
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('SLOT_TAKEN');
      expect(Array.isArray(second.body.alternatives)).toBe(true);
    });

    it('rejects a slot in the past', async () => {
      const start = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const end = new Date(Date.now() - 3_600_000).toISOString();
      const res = await request(app)
        .post(`/api/public/booking/${tenantId}`)
        .send(validBooking(start, end));
      expect(res.status).toBe(400);
    });

    it('rejects an out-of-bounds booking duration (multi-day hold)', async () => {
      const slot = await firstSlot();
      // Same valid start, but an end 3 days later — would hold the calendar.
      const longEnd = new Date(new Date(slot.start).getTime() + 3 * 24 * 3_600_000).toISOString();
      const res = await request(app)
        .post(`/api/public/booking/${tenantId}`)
        .send(validBooking(slot.start, longEnd));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/duration/i);
    });

    it('rejects a slot outside business hours (e.g. 02:00) the UI would never offer', async () => {
      // Valid duration + future, but 02:00–03:00 UTC is before the 08:00 open.
      const day = isoDate(2);
      const res = await request(app)
        .post(`/api/public/booking/${tenantId}`)
        .send(validBooking(`${day}T02:00:00.000Z`, `${day}T03:00:00.000Z`));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/booking hours/i);
    });

    it('rejects a payload missing both phone and email', async () => {
      const slot = await firstSlot();
      const body = validBooking(slot.start, slot.end) as Record<string, unknown>;
      delete body.primaryPhone;
      delete body.email;
      const res = await request(app).post(`/api/public/booking/${tenantId}`).send(body);
      expect(res.status).toBe(400);
    });

    it('rejects a payload missing the service address', async () => {
      const slot = await firstSlot();
      const body = validBooking(slot.start, slot.end) as Record<string, unknown>;
      delete body.street1;
      const res = await request(app).post(`/api/public/booking/${tenantId}`).send(body);
      expect(res.status).toBe(400);
    });

    it('honeypot returns 200 and writes nothing', async () => {
      const slot = await firstSlot();
      const res = await request(app)
        .post(`/api/public/booking/${tenantId}`)
        .send({ ...validBooking(slot.start, slot.end), _company_url: 'http://spam.example' });
      expect(res.status).toBe(200);
      expect(await customerRepo.findByTenant(tenantId)).toHaveLength(0);
      expect(await proposalRepo.findByTenant(tenantId)).toHaveLength(0);
    });

    it('does not leak across tenants — a booking for tenant A is invisible to tenant B', async () => {
      const other = await tenantRepo.create({
        ownerId: 'owner-2',
        ownerEmail: 'other@example.com',
        name: 'Other Co',
      });
      const slot = await firstSlot();
      const res = await request(app)
        .post(`/api/public/booking/${tenantId}`)
        .send(validBooking(slot.start, slot.end));
      expect(res.status).toBe(201);
      expect(await proposalRepo.findByTenant(other.id)).toHaveLength(0);
      expect(await customerRepo.findByTenant(other.id)).toHaveLength(0);
    });

    it('returns 404 for an unknown tenant', async () => {
      const res = await request(app)
        .post('/api/public/booking/00000000-0000-4000-8000-000000000099')
        .send(validBooking(new Date(Date.now() + 86_400_000).toISOString(), new Date(Date.now() + 90_000_000).toISOString()));
      expect(res.status).toBe(404);
    });
  });
});
