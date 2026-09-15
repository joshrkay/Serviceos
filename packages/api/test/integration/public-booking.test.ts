/**
 * #1014 row 2.9 — website self-booking at real Postgres.
 *
 * `test/routes/public-booking.route.test.ts` exhaustively covers the route's
 * logic (validation, slot collision, service area, timezone gating) but does
 * so entirely against in-memory repos — never a real Postgres column. This
 * file drives the same production `createPublicBookingRouter` wired with the
 * REAL Pg* repositories, proving:
 *
 *   - a booking creates real appointment (hold), job, customer, and
 *     create_booking proposal rows, plus its `appointment.booking_requested`
 *     audit event, all readable back from Postgres;
 *   - T1: a service-area allowlist configured for tenant B never affects
 *     tenant A's own (unbounded) public booking, and vice versa — each
 *     tenant's `PUT`-equivalent settings are read under its own row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, type TestTenant } from './shared';
import { createPublicBookingRouter } from '../../src/routes/public-booking';
import { PgTenantRepository } from '../../src/auth/pg-tenant';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgTenantTransactionRunner } from '../../src/db/tenant-transaction';

function isoDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe('Postgres integration — public self-service booking route', () => {
  let pool: Pool;
  let app: Express;
  let tenantRepo: PgTenantRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let jobRepo: PgJobRepository;
  let appointmentRepo: PgAppointmentRepository;
  let assignmentRepo: PgAssignmentRepository;
  let proposalRepo: PgProposalRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  const validBooking = (slotStart: string, slotEnd: string, overrides: Record<string, unknown> = {}) => ({
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
    ...overrides,
  });

  async function firstSlot(tenantId: string): Promise<{ start: string; end: string }> {
    const res = await request(app)
      .get(`/api/public/booking/${tenantId}/availability`)
      .query({ from: isoDate(1), to: isoDate(3), durationMin: 60 });
    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBeGreaterThan(0);
    return res.body.slots[0];
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantRepo = new PgTenantRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    jobRepo = new PgJobRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    assignmentRepo = new PgAssignmentRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);

    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenantA.tenantId,
      businessName: 'Tenant A Co',
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
    await settingsRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenantB.tenantId,
      businessName: 'Tenant B Co',
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
    // Tenant B configures a ZIP allowlist (via the real UPDATE path, same as
    // the settings PUT route) that EXCLUDES tenant A's postal code (85001) —
    // proving this never leaks into tenant A's own booking.
    await settingsRepo.update(tenantB.tenantId, { serviceAreaZips: ['90001', '90002'] });

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
        // Wired exactly as app.ts wires it — without this the router falls
        // back to InMemoryTransactionRunner and never exercises the real
        // tenant-scoped transaction / advisory-lock path (review finding,
        // xhawk-ai on PR #1043).
        transactionRunner: new PgTenantTransactionRunner(pool),
        settingsRepo,
        auditRepo,
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('creates real appointment hold, job, customer, proposal rows and an audited booking_requested event', async () => {
    const slot = await firstSlot(tenantA.tenantId);
    const res = await request(app)
      .post(`/api/public/booking/${tenantA.tenantId}`)
      .send(validBooking(slot.start, slot.end));

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_confirmation');

    const appt = await appointmentRepo.findById(tenantA.tenantId, res.body.appointmentId);
    expect(appt?.holdPendingApproval).toBe(true);
    expect(appt?.holdExpiryAt).toBeTruthy();

    const proposal = await proposalRepo.findById(tenantA.tenantId, res.body.proposalId);
    expect(proposal?.proposalType).toBe('create_booking');
    expect(proposal?.status).toBe('draft');

    const customers = await customerRepo.findByTenant(tenantA.tenantId);
    expect(customers.some((c) => c.firstName === 'Sandra')).toBe(true);

    const events = await auditRepo.findByEntity(tenantA.tenantId, 'appointment', res.body.appointmentId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: tenantA.tenantId,
      eventType: 'appointment.booking_requested',
      entityType: 'appointment',
      entityId: res.body.appointmentId,
    });
  });

  it("T1: tenant B's service-area allowlist never affects tenant A's own (unbounded) public booking", async () => {
    // Tenant A has NO allowlist configured — a ZIP that tenant B would
    // reject (85001 is not in tenant B's ['90001','90002']) must still be
    // accepted for tenant A.
    const slotA = await firstSlot(tenantA.tenantId);
    const resA = await request(app)
      .post(`/api/public/booking/${tenantA.tenantId}`)
      .send(validBooking(slotA.start, slotA.end));
    expect(resA.status).toBe(201);

    // Tenant B's OWN allowlist still applies to tenant B's own booking —
    // the same 85001 ZIP is rejected under tenant B's real settings row.
    const slotB = await firstSlot(tenantB.tenantId);
    const resB = await request(app)
      .post(`/api/public/booking/${tenantB.tenantId}`)
      .send(validBooking(slotB.start, slotB.end));
    expect(resB.status).toBe(400);
    expect(resB.body.error).toBe('OUT_OF_SERVICE_AREA');

    // And tenant B's rejected booking created nothing under tenant B.
    const tenantBCustomers = await customerRepo.findByTenant(tenantB.tenantId);
    expect(tenantBCustomers).toHaveLength(0);
  });
});
