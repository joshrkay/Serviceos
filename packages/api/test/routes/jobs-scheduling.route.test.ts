/**
 * Direct job scheduling — route shape tests (U3 create + U4 endpoints + U5
 * cancel propagation). A focused app wires createJobRouter WITH the schedule
 * sync deps (in-memory appointment/assignment/user repos) so the HTTP surface
 * is exercised end to end; board state is asserted by calling
 * getDispatchBoardData over the same repos.
 *
 * Atomicity (a conflict leaving NO job) is a property of the request
 * transaction and is pinned against real Postgres in
 * test/integration/job-appointment-sync.test.ts — these in-memory route tests
 * assert the HTTP contract (status codes + board state) only.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createJobRouter } from '../../src/routes/jobs';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryJobTimelineRepository } from '../../src/jobs/job-lifecycle';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryQueue } from '../../src/queues/queue';
import { NoopFeedbackDispatcher } from '../../src/feedback/dispatcher';
import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemoryAssignmentRepository } from '../../src/appointments/assignment';
import { User, UserRepository } from '../../src/users/user';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import { getDispatchBoardData, DispatchBoardData } from '../../src/dispatch/board-query';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

const TENANT = 'tenant-sched-1';
const USER = 'user-sched-1';
const TECH_1 = uuidv4();
const TECH_2 = uuidv4();
const NOW = new Date('2026-06-10T00:00:00Z');
const START_ISO = '2030-07-01T15:00:00.000Z';
const BOARD_DATE = '2030-07-01';

function tech(id: string): User {
  return { id, tenantId: TENANT, email: `${id}@x.com`, role: 'technician', canFieldServe: true, createdAt: NOW, updatedAt: NOW };
}

function fakeUserRepo(users: User[]): UserRepository {
  return {
    findByTenant: async (t, opts) =>
      users.filter((u) => u.tenantId === t && (!opts?.role || u.role === opts.role)).map((u) => ({ ...u })),
    findById: async (t, id) => users.find((u) => u.tenantId === t && u.id === id) ?? null,
    findByMobileNumber: async () => null,
    setMobileNumber: async () => null,
    update: async () => null,
  };
}

function build(users: User[] = [tech(TECH_1), tech(TECH_2)]) {
  const jobRepo = new InMemoryJobRepository();
  const timelineRepo = new InMemoryJobTimelineRepository();
  const auditRepo = new InMemoryAuditRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const assignmentRepo = new InMemoryAssignmentRepository();
  const userRepo = fakeUserRepo(users);

  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = { userId: USER, sessionId: 's-1', tenantId: TENANT, role: 'owner' };
    next();
  });
  app.use(
    '/api/jobs',
    createJobRouter(
      jobRepo,
      timelineRepo,
      auditRepo,
      permissiveTenantOwnership(),
      new InMemoryQueue(),
      new NoopFeedbackDispatcher(),
      undefined,
      undefined,
      undefined,
      undefined,
      { appointmentRepo, assignmentRepo, userRepo },
    ),
  );

  const board = (date = BOARD_DATE): Promise<DispatchBoardData> =>
    getDispatchBoardData(TENANT, date, { appointmentRepo, assignmentRepo });

  return { app, jobRepo, appointmentRepo, assignmentRepo, auditRepo, board };
}

function boardAppointments(board: DispatchBoardData) {
  return [...board.unassignedAppointments, ...board.technicianLanes.flatMap((l) => l.appointments)];
}

const baseJob = { customerId: 'cust-1', locationId: 'loc-1', summary: 'Fix the AC' };

describe('POST /api/jobs — schedule on create (U3)', () => {
  it('creates an unscheduled job (legacy) when no schedule fields are sent', async () => {
    const { app, board } = build();
    const res = await request(app).post('/api/jobs').send(baseJob);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('new');
    expect(boardAppointments(await board())).toHaveLength(0);
  });

  it('schedules with a technician: 201, job → scheduled, appears in the tech lane', async () => {
    const { app, board } = build();
    const res = await request(app)
      .post('/api/jobs')
      .send({ ...baseJob, scheduledStart: START_ISO, technicianId: TECH_1, durationMin: 90 });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('scheduled');
    expect(res.body.assignedTechnicianId).toBe(TECH_1);

    const b = await board();
    const lane = b.technicianLanes.find((l) => l.technicianId === TECH_1);
    expect(lane).toBeDefined();
    expect(lane!.appointments.some((a) => a.jobId === res.body.id)).toBe(true);
    expect(b.unassignedAppointments).toHaveLength(0);
  });

  it('schedules without a technician: appears in the unassigned queue', async () => {
    const { app, board } = build();
    const res = await request(app)
      .post('/api/jobs')
      .send({ ...baseJob, scheduledStart: START_ISO });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('scheduled');
    const b = await board();
    expect(b.unassignedAppointments.some((a) => a.jobId === res.body.id)).toBe(true);
  });

  it('returns 409 when the technician is double-booked at create time', async () => {
    const { app } = build();
    const first = await request(app)
      .post('/api/jobs')
      .send({ ...baseJob, scheduledStart: START_ISO, technicianId: TECH_1, durationMin: 60 });
    expect(first.status).toBe(201);

    const conflict = await request(app)
      .post('/api/jobs')
      .send({ ...baseJob, summary: 'Second job', scheduledStart: START_ISO, technicianId: TECH_1, durationMin: 60 });
    expect(conflict.status).toBe(409);
  });

  it('rejects a non-ISO scheduledStart with 400', async () => {
    const { app } = build();
    const res = await request(app)
      .post('/api/jobs')
      .send({ ...baseJob, scheduledStart: 'tomorrow afternoon' });
    expect(res.status).toBe(400);
  });
});
