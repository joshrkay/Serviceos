/**
 * #1406 D7 — dispatch board cards showed only time and status.
 * `getDispatchBoardData` supports `getAppointmentDisplayContext`, but the
 * board route never supplied it, so every card lacked customer, address and
 * job summary.
 *
 * Seam: GET /api/dispatch/board (createDispatchRoutes) over in-memory repos.
 */
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import { createDispatchRoutes } from '../../src/dispatch/routes';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAssignmentRepository } from '../../src/appointments/assignment';
import { createAppointment } from '../../src/appointments/appointment';
import { InMemoryCustomerRepository, createCustomer } from '../../src/customers/customer';
import { InMemoryLocationRepository, createLocation } from '../../src/locations/location';
import { InMemoryJobRepository, createJob } from '../../src/jobs/job';

const TENANT = '550e8400-e29b-41d4-a716-446655440000';
const OWNER = '550e8400-e29b-41d4-a716-446655440010';

describe('GET /api/dispatch/board — card context (#1406 D7)', () => {
  it('each card carries the customer name, service address and job summary', async () => {
    const assignmentRepo = new InMemoryAssignmentRepository();
    const appointmentRepo = new InMemoryAppointmentRepository(assignmentRepo);
    const customerRepo = new InMemoryCustomerRepository();
    const locationRepo = new InMemoryLocationRepository();
    const jobRepo = new InMemoryJobRepository();

    const customer = await createCustomer(
      { tenantId: TENANT, firstName: 'Dana', lastName: 'Ortiz', createdBy: OWNER },
      customerRepo,
    );
    const location = await createLocation(
      {
        tenantId: TENANT,
        customerId: customer.id,
        street1: '42 Saguaro Ln',
        city: 'Tempe',
        state: 'AZ',
        postalCode: '85281',
      },
      locationRepo,
    );
    const job = await createJob(
      {
        tenantId: TENANT,
        customerId: customer.id,
        locationId: location.id,
        summary: 'Replace capacitor',
        createdBy: OWNER,
      },
      jobRepo,
    );
    await createAppointment(
      {
        tenantId: TENANT,
        jobId: job.id,
        scheduledStart: new Date('2026-09-28T16:00:00Z'),
        scheduledEnd: new Date('2026-09-28T17:00:00Z'),
        timezone: 'UTC',
        createdBy: OWNER,
      },
      appointmentRepo,
    );

    const app = express();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: OWNER,
        sessionId: 's1',
        tenantId: TENANT,
        role: 'owner',
      } as AuthenticatedRequest['auth'];
      next();
    });
    app.use(
      '/api/dispatch',
      createDispatchRoutes({ appointmentRepo, assignmentRepo, jobRepo, customerRepo, locationRepo }),
    );

    const res = await request(app).get('/api/dispatch/board?date=2026-09-28&timezone=UTC');

    expect(res.status).toBe(200);
    expect(res.body.unassignedAppointments).toHaveLength(1);
    expect(res.body.unassignedAppointments[0]).toMatchObject({
      customerName: 'Dana Ortiz',
      locationAddress: '42 Saguaro Ln, Tempe, AZ',
      jobSummary: 'Replace capacitor',
    });
  });
});
