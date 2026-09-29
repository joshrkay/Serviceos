/**
 * #1463 — an assignee must be an ACTIVE member of the caller's tenant.
 *
 * `PATCH /api/leads/:id` accepted any `assignedUserId`: a user from another
 * tenant, a suspended/deleted user, or a uuid that names nobody. The web
 * picker only offers tenant users, but the API is the boundary. Pinned here
 * against real Postgres with two tenants, through the production
 * request-transaction middleware, at each fixed route.
 *
 * The refusal is a typed 400 that never distinguishes "exists in another
 * tenant" from "does not exist" — no cross-tenant existence oracle.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import express, { Response, NextFunction } from 'express';
import { getSharedTestDb, createTestTenant, TestTenant } from './shared';
import { PgLeadRepository } from '../../src/leads/pg-lead';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgUserRepository } from '../../src/users/pg-user';
import { createLeadsRouter } from '../../src/routes/leads';
import { createAppointmentRouter } from '../../src/routes/appointments';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgAssignmentRepository } from '../../src/appointments/pg-assignment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgJobTimelineRepository } from '../../src/jobs/pg-job-lifecycle';
import { permissiveTenantOwnership } from '../../src/shared/tenant-ownership';
import { createJobRouter } from '../../src/routes/jobs';
import { InMemoryQueue } from '../../src/queues/queue';
import { NoopFeedbackDispatcher } from '../../src/feedback/dispatcher';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { createProposal } from '../../src/proposals/proposal';
import type { ProposalType } from '../../src/proposals/proposal';
import { approveProposal } from '../../src/proposals/actions';
import { technicianReferenceCheck } from '../../src/proposals/approval-reference-checks';
import { createSettingsRouter } from '../../src/routes/settings';
import { PgSettingsRepository } from '../../src/settings/pg-settings';
import { createTimeEntriesRouter } from '../../src/routes/time-entries';
import { PgTimeEntryRepository } from '../../src/time-tracking/pg-time-entry';
import { withTenantTransaction } from '../../src/middleware/tenant-context';
import type { AuthenticatedRequest } from '../../src/auth/clerk';

type Role = 'owner' | 'dispatcher' | 'technician';

describe('Postgres integration — assignee must be an active tenant member (#1463)', () => {
  let pool: Pool;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let app: express.Express;
  let jobRepo: PgJobRepository;
  let appointmentRepo: PgAppointmentRepository;
  let customerId: string;
  let locationId: string;
  let slot = 0;

  async function makeUser(
    tenantId: string,
    role: Role,
    opts: { status?: 'active' | 'suspended'; deleted?: boolean } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, tenant_id, clerk_user_id, email, role, first_name, last_name, status, deleted_at)
       VALUES ($1, $2, $3, $4, $5, 'Lane', 'Member', $6, $7)`,
      [
        id,
        tenantId,
        `clerk_${id}`,
        `member_${id}@example.com`,
        role,
        opts.status ?? 'active',
        opts.deleted ? new Date() : null,
      ],
    );
    return id;
  }

  async function makeLead(): Promise<string> {
    const res = await request(app).post('/api/leads').send({ firstName: 'Pat', source: 'web_form' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function makeJob(): Promise<string> {
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenantA.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-1463-${jobId.slice(0, 8)}`,
      summary: 'Assignee membership fixture',
      status: 'new',
      priority: 'normal',
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return jobId;
  }

  /** A fresh, non-overlapping one-hour window per call. */
  function nextWindow(): { scheduledStart: string; scheduledEnd: string } {
    const start = new Date(Date.UTC(2026, 10, 2, 0, 0) + slot++ * 2 * 3600_000);
    return {
      scheduledStart: start.toISOString(),
      scheduledEnd: new Date(start.getTime() + 3600_000).toISOString(),
    };
  }

  async function makeAppointment(): Promise<string> {
    const res = await request(app)
      .post('/api/appointments')
      .send({ jobId: await makeJob(), ...nextWindow(), timezone: 'UTC' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    tenantA = await createTestTenant(pool);
    tenantB = await createTestTenant(pool);
    jobRepo = new PgJobRepository(pool);
    appointmentRepo = new PgAppointmentRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const userRepo = new PgUserRepository(pool);
    const auditRepo = new PgAuditRepository(pool);

    customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenantA.tenantId,
      firstName: 'Lane',
      lastName: 'Owner',
      displayName: 'Lane Owner',
      preferredChannel: 'sms',
      smsConsent: true,
      isArchived: false,
      createdBy: tenantA.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenantA.tenantId,
      customerId,
      street1: '1 Lane St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      addressType: 'service',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    app = express();
    app.use(express.json());
    app.use((req, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: tenantA.userId,
        canonicalUserId: tenantA.userId,
        sessionId: 'sess-1463',
        tenantId: tenantA.tenantId,
        role: 'owner',
      };
      next();
    });
    app.use('/api', withTenantTransaction(pool));
    app.use(
      '/api/leads',
      createLeadsRouter(
        new PgLeadRepository(pool),
        customerRepo,
        auditRepo,
        locationRepo,
        userRepo,
      ),
    );
    app.use(
      '/api/appointments',
      createAppointmentRouter(
        appointmentRepo,
        permissiveTenantOwnership(),
        jobRepo,
        new PgJobTimelineRepository(pool),
        { assignment: { assignmentRepo: new PgAssignmentRepository(pool), userRepo } },
        auditRepo,
      ),
    );
    app.use(
      '/api/settings',
      createSettingsRouter(new PgSettingsRepository(pool), undefined, auditRepo, undefined, undefined, {
        userRepo,
      }),
    );
    app.use(
      '/api/time-entries',
      createTimeEntriesRouter(new PgTimeEntryRepository(pool), auditRepo, userRepo),
    );
    app.use(
      '/api/jobs',
      createJobRouter(
        jobRepo,
        new PgJobTimelineRepository(pool),
        auditRepo,
        permissiveTenantOwnership(),
        new InMemoryQueue(),
        new NoopFeedbackDispatcher(),
        customerRepo,
        locationRepo,
        undefined,
        undefined,
        { appointmentRepo, assignmentRepo: new PgAssignmentRepository(pool), userRepo },
      ),
    );
  });

  describe('PATCH /api/leads/:id assignedUserId', () => {
    it("refuses tenant B's user with a 400 and leaves the lead unassigned", async () => {
      const leadId = await makeLead();
      const outsider = await makeUser(tenantB.tenantId, 'dispatcher');

      const res = await request(app).patch(`/api/leads/${leadId}`).send({ assignedUserId: outsider });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      const after = await request(app).get(`/api/leads/${leadId}`);
      expect(after.body.assignedUserId).toBeUndefined();
    });

    it.each([
      ['a uuid naming nobody', async () => crypto.randomUUID()],
      ['a suspended member of tenant A', async () => makeUser(tenantA.tenantId, 'dispatcher', { status: 'suspended' })],
      ['a deleted member of tenant A', async () => makeUser(tenantA.tenantId, 'dispatcher', { deleted: true })],
    ])('refuses %s with the same 400 message as an outsider', async (_label, makeId) => {
      const leadId = await makeLead();
      const outsider = await makeUser(tenantB.tenantId, 'dispatcher');
      const outsiderRes = await request(app).patch(`/api/leads/${leadId}`).send({ assignedUserId: outsider });

      const res = await request(app).patch(`/api/leads/${leadId}`).send({ assignedUserId: await makeId() });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      // No existence oracle: every cause reads identically.
      expect(res.body.message).toBe(outsiderRes.body.message);
    });

    it('assigns an active member of tenant A, and null clears it', async () => {
      const leadId = await makeLead();
      const member = await makeUser(tenantA.tenantId, 'technician');

      const assigned = await request(app).patch(`/api/leads/${leadId}`).send({ assignedUserId: member });
      expect(assigned.status).toBe(200);
      expect(assigned.body.assignedUserId).toBe(member);

      const cleared = await request(app).patch(`/api/leads/${leadId}`).send({ assignedUserId: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.assignedUserId).toBeUndefined();
    });
  });

  describe('POST /api/leads assignedUserId', () => {
    it("refuses tenant B's user with a 400 and creates no lead", async () => {
      const outsider = await makeUser(tenantB.tenantId, 'dispatcher');

      const res = await request(app)
        .post('/api/leads')
        .send({ firstName: 'Quinn', source: 'web_form', assignedUserId: outsider });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      const list = await request(app).get('/api/leads');
      const rows = list.body.data as Array<{ firstName: string }>;
      expect(rows.some((l) => l.firstName === 'Quinn')).toBe(false);
    });
  });

  describe('POST /api/appointments technicianId', () => {
    it.each([
      ["tenant B's technician", async () => makeUser(tenantB.tenantId, 'technician')],
      ['a suspended technician of tenant A', async () => makeUser(tenantA.tenantId, 'technician', { status: 'suspended' })],
      ['a uuid naming nobody', async () => crypto.randomUUID()],
    ])('refuses %s with a 400 and writes no appointment', async (_label, makeId) => {
      const jobId = await makeJob();
      const res = await request(app)
        .post('/api/appointments')
        .send({ jobId, ...nextWindow(), timezone: 'UTC', technicianId: await makeId() });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(await appointmentRepo.findByJob(tenantA.tenantId, jobId)).toEqual([]);
    });
  });

  describe('POST /api/appointments/:id/assignments technicianId', () => {
    it.each([
      ["tenant B's technician", async () => makeUser(tenantB.tenantId, 'technician')],
      ['a suspended technician of tenant A', async () => makeUser(tenantA.tenantId, 'technician', { status: 'suspended' })],
    ])('refuses %s with a 400', async (_label, makeId) => {
      const appointmentId = await makeAppointment();
      const res = await request(app)
        .post(`/api/appointments/${appointmentId}/assignments`)
        .send({ technicianId: await makeId() });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('assigns an active technician of tenant A', async () => {
      const appointmentId = await makeAppointment();
      const tech = await makeUser(tenantA.tenantId, 'technician');
      const res = await request(app)
        .post(`/api/appointments/${appointmentId}/assignments`)
        .send({ technicianId: tech });
      expect(res.status).toBe(200);
      expect(res.body.technicianId).toBe(tech);
    });
  });

  describe('jobs technicianId (schedule / reassign)', () => {
    async function scheduledJob(): Promise<string> {
      const jobId = await makeJob();
      const res = await request(app)
        .post(`/api/jobs/${jobId}/schedule`)
        .send({ scheduledStart: nextWindow().scheduledStart, timezone: 'UTC' });
      expect(res.status).toBe(200);
      return jobId;
    }

    it.each([
      ["tenant B's technician", async () => makeUser(tenantB.tenantId, 'technician')],
      ['a suspended technician of tenant A', async () => makeUser(tenantA.tenantId, 'technician', { status: 'suspended' })],
    ])('POST /api/jobs/:id/reassign refuses %s with a 400', async (_label, makeId) => {
      const jobId = await scheduledJob();
      const res = await request(app).post(`/api/jobs/${jobId}/reassign`).send({ technicianId: await makeId() });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('POST /api/jobs/:id/schedule refuses a suspended technician with a 400', async () => {
      const jobId = await makeJob();
      const suspended = await makeUser(tenantA.tenantId, 'technician', { status: 'suspended' });
      const res = await request(app)
        .post(`/api/jobs/${jobId}/schedule`)
        .send({ scheduledStart: nextWindow().scheduledStart, timezone: 'UTC', technicianId: suspended });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('POST /api/jobs/:id/reassign assigns an active technician of tenant A', async () => {
      const jobId = await scheduledJob();
      const tech = await makeUser(tenantA.tenantId, 'technician');
      const res = await request(app).post(`/api/jobs/${jobId}/reassign`).send({ technicianId: tech });
      expect(res.status).toBe(200);
      expect(res.body.assignedTechnicianId).toBe(tech);
    });
  });

  describe('proposal approval — technician payload fields', () => {
    async function draft(proposalType: ProposalType, payload: Record<string, unknown>) {
      const repo = new PgProposalRepository(pool);
      const proposal = createProposal({
        tenantId: tenantA.tenantId,
        proposalType,
        payload,
        summary: 'Assignee membership fixture',
        createdBy: tenantA.userId,
      });
      await repo.create(proposal);
      return { repo, proposal };
    }

    function approve(repo: PgProposalRepository, proposalId: string) {
      return approveProposal(repo, tenantA.tenantId, proposalId, tenantA.userId, 'owner', undefined, 'ui', {
        referenceChecks: [technicianReferenceCheck(new PgUserRepository(pool))],
      });
    }

    const cases: Array<[ProposalType, string, (appointmentId: string, tech: string) => Record<string, unknown>]> = [
      ['add_crew_member', 'technicianId', (appointmentId, tech) => ({ appointmentId, technicianId: tech })],
      ['reassign_appointment', 'toTechnicianId', (appointmentId, tech) => ({ appointmentId, toTechnicianId: tech })],
    ];

    it.each(cases)("%s: refuses tenant B's technician, naming %s, and stays a draft", async (type, field, build) => {
      const appointmentId = await makeAppointment();
      const outsider = await makeUser(tenantB.tenantId, 'technician');
      const { repo, proposal } = await draft(type, build(appointmentId, outsider));

      await expect(approve(repo, proposal.id)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: { missingFields: [field] },
      });
      expect((await repo.findById(tenantA.tenantId, proposal.id))!.status).toBe('draft');
    });

    it.each(cases)('%s: refuses a suspended technician of tenant A', async (type, field, build) => {
      const appointmentId = await makeAppointment();
      const suspended = await makeUser(tenantA.tenantId, 'technician', { status: 'suspended' });
      const { repo, proposal } = await draft(type, build(appointmentId, suspended));

      await expect(approve(repo, proposal.id)).rejects.toMatchObject({
        details: { missingFields: [field] },
      });
    });

    it.each(cases)('%s: approves an active technician of tenant A', async (type, _field, build) => {
      const appointmentId = await makeAppointment();
      const tech = await makeUser(tenantA.tenantId, 'technician');
      const { repo, proposal } = await draft(type, build(appointmentId, tech));

      const approved = await approve(repo, proposal.id);
      expect(approved.status).toBe('approved');
    });

    it("create_appointment: refuses tenant B's technician", async () => {
      const outsider = await makeUser(tenantB.tenantId, 'technician');
      const { repo, proposal } = await draft('create_appointment', {
        customerId,
        ...nextWindow(),
        technicianId: outsider,
      });

      await expect(approve(repo, proposal.id)).rejects.toMatchObject({
        details: { missingFields: ['technicianId'] },
      });
    });
  });

  describe('PUT /api/settings backupSupervisorUserId', () => {
    it.each([
      ["tenant B's dispatcher", async () => makeUser(tenantB.tenantId, 'dispatcher')],
      ['a suspended dispatcher of tenant A', async () => makeUser(tenantA.tenantId, 'dispatcher', { status: 'suspended' })],
      ['a uuid naming nobody', async () => crypto.randomUUID()],
    ])('refuses %s with a 400', async (_label, makeId) => {
      const res = await request(app).put('/api/settings').send({ backupSupervisorUserId: await makeId() });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('accepts an active dispatcher of tenant A, and null clears it', async () => {
      const dispatcher = await makeUser(tenantA.tenantId, 'dispatcher');
      const set = await request(app).put('/api/settings').send({ backupSupervisorUserId: dispatcher });
      expect(set.status).toBe(200);
      expect(set.body.backupSupervisorUserId).toBe(dispatcher);

      const cleared = await request(app).put('/api/settings').send({ backupSupervisorUserId: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.backupSupervisorUserId).toBeNull();
    });
  });

  describe('POST /api/time-entries/clock-in userId (office clocks in on behalf)', () => {
    it.each([
      ["tenant B's technician", async () => makeUser(tenantB.tenantId, 'technician')],
      ['a suspended technician of tenant A', async () => makeUser(tenantA.tenantId, 'technician', { status: 'suspended' })],
      ['a uuid naming nobody', async () => crypto.randomUUID()],
    ])('refuses %s with a 400', async (_label, makeId) => {
      const res = await request(app)
        .post('/api/time-entries/clock-in')
        .send({ userId: await makeId(), entryType: 'admin' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('clocks in an active technician of tenant A by users.id', async () => {
      const tech = await makeUser(tenantA.tenantId, 'technician');
      const res = await request(app)
        .post('/api/time-entries/clock-in')
        .send({ userId: tech, entryType: 'admin' });
      expect(res.status).toBe(201);
      expect(res.body.userId).toBe(tech);
    });
  });
});
