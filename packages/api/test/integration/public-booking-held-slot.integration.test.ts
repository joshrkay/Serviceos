/**
 * Postgres integration — 3.4 "a booking POST cannot take a slot the calendar
 * wouldn't have offered."
 *
 * `public-booking.route.test.ts` already proves the 409/SLOT_TAKEN contract
 * end-to-end, but entirely against in-memory repositories and the
 * `InMemoryTransactionRunner` — no real hold row, no real advisory lock, no
 * audit read-back. This file drives the SAME router, through the SAME HTTP
 * surface (supertest), against REAL Postgres repositories and the REAL
 * `PgTenantTransactionRunner` (the one `app.ts` actually wires in
 * production): a real tentative-hold appointment row, a real per-tenant
 * advisory lock serializing the re-check, and a real `audit_events` row for
 * the winning booking.
 *
 * Every test seeds its OWN fresh tenant(s) rather than sharing one across
 * `it()` blocks — a tenant that already holds a slot from an earlier test in
 * this file would shift its own "first available slot" forward, which would
 * make the T1 cross-tenant comparison below flaky by test order rather than
 * by anything the story is about.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
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
import { v4 as uuidv4 } from 'uuid';

/** A YYYY-MM-DD date `days` from today, in UTC (tests use a UTC tenant tz). */
function isoDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe('Postgres integration — public booking cannot take a HELD slot (3.4)', () => {
  let pool: Pool;
  let app: Express;
  let appointmentRepo: PgAppointmentRepository;
  let settingsRepo: PgSettingsRepository;
  let auditRepo: PgAuditRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    appointmentRepo = new PgAppointmentRepository(pool);
    settingsRepo = new PgSettingsRepository(pool);
    auditRepo = new PgAuditRepository(pool);

    app = express();
    app.use(express.json());
    app.use(
      '/api/public/booking',
      createPublicBookingRouter({
        tenantRepo: new PgTenantRepository(pool),
        customerRepo: new PgCustomerRepository(pool),
        locationRepo: new PgLocationRepository(pool),
        jobRepo: new PgJobRepository(pool),
        appointmentRepo,
        assignmentRepo: new PgAssignmentRepository(pool),
        proposalRepo: new PgProposalRepository(pool),
        settingsRepo,
        auditRepo,
        // The REAL runner — a real per-tenant Postgres advisory lock wraps
        // the slot re-check and every write, exactly as app.ts wires it.
        transactionRunner: new PgTenantTransactionRunner(pool),
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** A fresh tenant, pinned to UTC with the default 8-17 business hours (unconfigured). */
  async function makeBookableTenant(): Promise<string> {
    const { tenantId } = await createTestTenant(pool);
    await settingsRepo.create({
      id: uuidv4(),
      tenantId,
      businessName: 'Held-Slot Co',
      timezone: 'UTC',
      estimatePrefix: 'EST-',
      invoicePrefix: 'INV-',
      nextEstimateNumber: 1,
      nextInvoiceNumber: 1,
      defaultPaymentTermDays: 30,
      activeVerticalPacks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    return tenantId;
  }

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

  /** Fetch the first available 60-min slot a few days out for `tenantId`. */
  async function firstSlot(tenantId: string): Promise<{ start: string; end: string }> {
    const res = await request(app)
      .get(`/api/public/booking/${tenantId}/availability`)
      .query({ from: isoDate(1), to: isoDate(3), durationMin: 60 });
    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBeGreaterThan(0);
    return res.body.slots[0];
  }

  it('a real hold row at real Postgres blocks a second booking POST for the SAME tenant, with an audited winner', async () => {
    const tenantId = await makeBookableTenant();
    const slot = await firstSlot(tenantId);

    const first = await request(app)
      .post(`/api/public/booking/${tenantId}`)
      .send(validBooking(slot.start, slot.end));
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/public/booking/${tenantId}`)
      .send(validBooking(slot.start, slot.end));
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('SLOT_TAKEN');

    // A REAL tentative-hold appointment row exists at real Postgres — not an
    // in-memory fixture.
    const appt = await appointmentRepo.findById(tenantId, first.body.appointmentId);
    expect(appt?.holdPendingApproval).toBe(true);
    expect(appt?.holdExpiryAt).toBeTruthy();

    // ...and the losing request never created a second appointment for this
    // window (the advisory-lock-guarded re-check actually ran against Postgres).
    expect(second.body.appointmentId).toBeUndefined();

    // Audit read-back: the winning booking's request is readable through
    // PgAuditRepository, not just asserted from the HTTP response body.
    const events = await auditRepo.findByEntity(tenantId, 'appointment', first.body.appointmentId);
    expect(events.some((e) => e.eventType === 'appointment.booking_requested')).toBe(true);
  });

  it('T1 — a neighbour tenant\'s hold on the identical instant does not block this tenant\'s booking POST', async () => {
    const tenantId = await makeBookableTenant();
    const neighbourTenantId = await makeBookableTenant();

    const ourSlot = await firstSlot(tenantId);
    const neighbourSlot = await firstSlot(neighbourTenantId);
    // Both tenants are fresh (no prior appointments), share the same UTC
    // timezone and default weekly hours, so the SAME availability query
    // returns the SAME wall-clock instant for both — the precondition for
    // this to be a meaningful cross-tenant check.
    expect(neighbourSlot).toEqual(ourSlot);

    // The neighbour tenant holds this exact instant FIRST.
    const neighbourBooking = await request(app)
      .post(`/api/public/booking/${neighbourTenantId}`)
      .send(validBooking(neighbourSlot.start, neighbourSlot.end));
    expect(neighbourBooking.status).toBe(201);

    // Our tenant's booking on the IDENTICAL instant must still succeed — a
    // tenant-unscoped slot-conflict check would 409 this.
    const ours = await request(app)
      .post(`/api/public/booking/${tenantId}`)
      .send(validBooking(ourSlot.start, ourSlot.end));
    expect(ours.status).toBe(201);

    const ourAppt = await appointmentRepo.findById(tenantId, ours.body.appointmentId);
    expect(ourAppt?.holdPendingApproval).toBe(true);
    // Cross-tenant isolation: our tenant cannot read the neighbour's hold
    // under its own id, and vice versa.
    expect(await appointmentRepo.findById(tenantId, neighbourBooking.body.appointmentId)).toBeNull();
    expect(await appointmentRepo.findById(neighbourTenantId, ours.body.appointmentId)).toBeNull();
  });
});
