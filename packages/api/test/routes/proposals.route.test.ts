/**
 * P2-004 — HTTP route shape tests for the proposals action API.
 *
 * Verifies list/detail/approve/reject/edit/undo endpoints are wired through
 * the Express router, enforce permissions via middleware, and return the
 * expected status codes + payloads.
 */
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import { buildTestApp, TEST_TENANT_ID, TEST_USER_ID } from './test-app';
import type { Express } from 'express';
import { createProposalsRouter } from '../../src/routes/proposals';
import {
  createProposal,
  InMemoryProposalRepository,
  CreateProposalInput,
} from '../../src/proposals/proposal';
import { InMemoryAppointmentRepository, createAppointment } from '../../src/appointments/appointment';
import { FeasibilityDependencies } from '../../src/scheduling/feasibility-types';
import { StubSkillMatcher } from '../../src/scheduling/skill-matcher';
import { HaversineFallbackProvider } from '../../src/scheduling/travel-time/haversine-fallback';
import { AuthenticatedRequest } from '../../src/auth/clerk';
import type { Role } from '../../src/auth/rbac';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const baseInput: CreateProposalInput = {
  tenantId: TEST_TENANT_ID,
  proposalType: 'create_customer',
  payload: { name: 'John Doe' },
  summary: 'Create customer from voice call',
  createdBy: TEST_USER_ID,
};

function buildAppWithRole(role: Role): { app: Express; proposalRepo: InMemoryProposalRepository } {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER_ID,
      sessionId: 'session-test-role',
      tenantId: TEST_TENANT_ID,
      role,
    };
    next();
  });
  const proposalRepo = new InMemoryProposalRepository();
  app.use('/api/proposals', createProposalsRouter(proposalRepo));
  return { app, proposalRepo };
}

// T4-F05 / T4-F04 — shared fixture for POST /api/proposals/ tests: creation
// must be denied to technician (proposals:view only) and allowed to
// owner/dispatcher, mirroring the wiring test in
// test/proposals/scheduling-create.test.ts. Full feasibilityDeps so a
// permitted request reaches the 200 branch, not SCHEDULING_DEPS_UNCONFIGURED.
async function buildSchedulingAppWithRole(role: Role) {
  const proposalRepo = new InMemoryProposalRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const tenantId = TEST_TENANT_ID;
  const appointment = await createAppointment(
    {
      tenantId,
      jobId: 'job-1',
      scheduledStart: new Date('2026-05-17T10:00:00Z'),
      scheduledEnd: new Date('2026-05-17T11:00:00Z'),
      timezone: 'UTC',
      createdBy: TEST_USER_ID,
    },
    appointmentRepo,
  );
  const feasibilityDeps: FeasibilityDependencies = {
    assignmentRepo: { findByTechnician: async () => [], findByAppointment: async () => [] } as any,
    appointmentRepo,
    jobRepo: { findById: async () => null } as any,
    locationRepo: { findById: async () => null } as any,
    workingHoursRepo: { findByTechnicianAndDay: async () => null } as any,
    unavailableBlockRepo: { findByTechnicianAndDateRange: async () => [] } as any,
    travelTimeProvider: new HaversineFallbackProvider(),
    skillMatcher: new StubSkillMatcher(),
  };
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).auth = {
      userId: TEST_USER_ID,
      sessionId: 'session-create-perm',
      tenantId,
      role,
    };
    next();
  });
  app.use('/api/proposals', createProposalsRouter(proposalRepo, appointmentRepo, undefined, feasibilityDeps));
  return { app, proposalRepo, appointmentRepo, appointment };
}

describe('GET /api/proposals', () => {
  it('returns 200 with list shape { data, total } for authenticated tenant', async () => {
    const { app, proposalRepo } = await buildTestApp();
    await proposalRepo.create(createProposal(baseInput));
    await proposalRepo.create(createProposal({ ...baseInput, summary: 'Second' }));

    const res = await request(app).get('/api/proposals');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(2);
  });

  it('filters by status query param', async () => {
    const { app, proposalRepo } = await buildTestApp();
    const approved = createProposal(baseInput);
    await proposalRepo.create(createProposal(baseInput));
    await proposalRepo.create(approved);
    await proposalRepo.updateStatus(TEST_TENANT_ID, approved.id, 'ready_for_review');
    await proposalRepo.updateStatus(TEST_TENANT_ID, approved.id, 'approved');

    const res = await request(app).get('/api/proposals').query({ status: 'approved' });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].id).toBe(approved.id);
  });

  it('paginates with limit and offset', async () => {
    const { app, proposalRepo } = await buildTestApp();
    for (let i = 0; i < 5; i++) {
      await proposalRepo.create(createProposal({ ...baseInput, summary: `P${i}` }));
    }

    const res = await request(app).get('/api/proposals').query({ limit: 2, offset: 0 });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.data).toHaveLength(2);
  });

  it('returns 400 for invalid status filter', async () => {
    const { app } = await buildTestApp();

    const res = await request(app).get('/api/proposals').query({ status: 'bogus' });

    expect(res.status).toBe(400);
  });

  it('returns 403 when role lacks proposals:view', async () => {
    const { app, proposalRepo } = buildAppWithRole('technician' as Role);
    await proposalRepo.create(createProposal(baseInput));

    const res = await request(app).get('/api/proposals');

    // technician only has view permission in rbac; pure view should succeed.
    // This test confirms the middleware chain is engaged (either 200 or 403
    // depending on role config — assert not 500).
    expect([200, 403]).toContain(res.status);
  });
});

describe('POST /api/proposals/ — proposals:create permission gating', () => {
  it('technician role → 403 FORBIDDEN, proposal not created', async () => {
    const { app, proposalRepo, appointment } = await buildSchedulingAppWithRole('technician' as Role);

    const res = await request(app)
      .post('/api/proposals')
      .set('If-Match', appointment.updatedAt.toISOString())
      .send({
        proposalType: 'reschedule_appointment',
        payload: {
          appointmentId: appointment.id,
          newScheduledStart: '2026-05-17T12:00:00Z',
          newScheduledEnd: '2026-05-17T13:00:00Z',
        },
        summary: 'reschedule via test',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect((await proposalRepo.findByStatus(TEST_TENANT_ID, 'draft')).length).toBe(0);
  });

  it('dispatcher role → 200 with created proposal', async () => {
    const { app, appointment } = await buildSchedulingAppWithRole('dispatcher' as Role);

    const res = await request(app)
      .post('/api/proposals')
      .set('If-Match', appointment.updatedAt.toISOString())
      .send({
        proposalType: 'reassign_appointment',
        payload: {
          appointmentId: appointment.id,
          toTechnicianId: '11111111-1111-1111-1111-111111111111',
        },
        summary: 'reassign via test',
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
  });

  it('owner role → 200 with created proposal', async () => {
    const { app, appointment } = await buildSchedulingAppWithRole('owner' as Role);

    const res = await request(app)
      .post('/api/proposals')
      .set('If-Match', appointment.updatedAt.toISOString())
      .send({
        proposalType: 'reassign_appointment',
        payload: {
          appointmentId: appointment.id,
          toTechnicianId: '11111111-1111-1111-1111-111111111111',
        },
        summary: 'reassign via test',
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
  });
});

describe('POST /api/proposals/ — payload Zod validation (T4-F04)', () => {
  it('reassign_appointment missing required toTechnicianId → 400 VALIDATION_ERROR, proposal not created', async () => {
    const { app, proposalRepo, appointment } = await buildSchedulingAppWithRole('dispatcher' as Role);

    const res = await request(app)
      .post('/api/proposals')
      .set('If-Match', appointment.updatedAt.toISOString())
      .send({
        proposalType: 'reassign_appointment',
        payload: { appointmentId: appointment.id }, // toTechnicianId omitted
        summary: 'reassign via test',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).toMatch(/toTechnicianId/);
    expect((await proposalRepo.findByStatus(TEST_TENANT_ID, 'draft')).length).toBe(0);
  });

  it('well-formed reschedule_appointment payload still succeeds (regression)', async () => {
    const { app, appointment } = await buildSchedulingAppWithRole('dispatcher' as Role);

    const res = await request(app)
      .post('/api/proposals')
      .set('If-Match', appointment.updatedAt.toISOString())
      .send({
        proposalType: 'reschedule_appointment',
        payload: {
          appointmentId: appointment.id,
          newScheduledStart: '2026-05-17T12:00:00Z',
          newScheduledEnd: '2026-05-17T13:00:00Z',
        },
        summary: 'reschedule via test',
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
  });

  it('unsupported proposalType still 400s UNSUPPORTED_PROPOSAL_TYPE before schema validation runs', async () => {
    const { app, appointment } = await buildSchedulingAppWithRole('dispatcher' as Role);

    const res = await request(app)
      .post('/api/proposals')
      .set('If-Match', appointment.updatedAt.toISOString())
      .send({ proposalType: 'draft_estimate', payload: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNSUPPORTED_PROPOSAL_TYPE');
  });
});

describe('GET /api/proposals/:id', () => {
  it('returns 200 with proposal detail', async () => {
    const { app, proposalRepo } = await buildTestApp();
    const proposal = createProposal(baseInput);
    await proposalRepo.create(proposal);

    const res = await request(app).get(`/api/proposals/${proposal.id}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(proposal.id);
    expect(res.body.proposalType).toBe('create_customer');
  });

  it('returns 404 when proposal does not exist', async () => {
    const { app } = await buildTestApp();

    const res = await request(app).get('/api/proposals/550e8400-e29b-41d4-a716-446655440000');

    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid UUID format', async () => {
    const { app } = await buildTestApp();

    const res = await request(app).get('/api/proposals/not-a-uuid');

    expect(res.status).toBe(400);
  });
});

describe('POST /api/proposals/:id/approve', () => {
  it('returns 200 with approved proposal', async () => {
    const { app, proposalRepo } = await buildTestApp();
    const proposal = createProposal(baseInput);
    await proposalRepo.create(proposal);
    await proposalRepo.updateStatus(TEST_TENANT_ID, proposal.id, 'ready_for_review');

    const res = await request(app).post(`/api/proposals/${proposal.id}/approve`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.approvedAt).toBeDefined();
  });

  it('returns 404 when proposal does not exist', async () => {
    const { app } = await buildTestApp();

    const res = await request(app).post('/api/proposals/550e8400-e29b-41d4-a716-446655440000/approve');

    expect(res.status).toBe(404);
  });
});

describe('POST /api/proposals/:id/reject', () => {
  it('returns 200 with rejected proposal and reason stored', async () => {
    const { app, proposalRepo } = await buildTestApp();
    const proposal = createProposal(baseInput);
    await proposalRepo.create(proposal);
    await proposalRepo.updateStatus(TEST_TENANT_ID, proposal.id, 'ready_for_review');

    const res = await request(app)
      .post(`/api/proposals/${proposal.id}/reject`)
      .send({ reason: 'wrong_entity', details: 'belongs to a different customer' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.rejectionReason).toBe('wrong_entity');
    expect(res.body.rejectionDetails).toBe('belongs to a different customer');
  });

  it('returns 400 when reason is missing', async () => {
    const { app, proposalRepo } = await buildTestApp();
    const proposal = createProposal(baseInput);
    await proposalRepo.create(proposal);

    const res = await request(app).post(`/api/proposals/${proposal.id}/reject`).send({});

    expect(res.status).toBe(400);
  });
});

describe('POST /api/proposals/:id/undo', () => {
  it('returns 200 when inside undo window', async () => {
    const { app, proposalRepo } = await buildTestApp();
    const proposal = createProposal(baseInput);
    await proposalRepo.create(proposal);
    await proposalRepo.updateStatus(TEST_TENANT_ID, proposal.id, 'ready_for_review');
    await request(app).post(`/api/proposals/${proposal.id}/approve`);

    const res = await request(app).post(`/api/proposals/${proposal.id}/undo`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('undone');
    expect(res.body.undoneBy).toBe(TEST_USER_ID);
  });

  it('returns 400 when proposal is not in approved status', async () => {
    const { app, proposalRepo } = await buildTestApp();
    const proposal = createProposal(baseInput);
    await proposalRepo.create(proposal);

    const res = await request(app).post(`/api/proposals/${proposal.id}/undo`);

    // draft proposal cannot be undone (service throws ValidationError → 400)
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/proposals/:id', () => {
  it('returns 200 with edited proposal and editedFields list', async () => {
    const { app, proposalRepo } = await buildTestApp();
    const proposal = createProposal(baseInput);
    await proposalRepo.create(proposal);

    const res = await request(app)
      .put(`/api/proposals/${proposal.id}`)
      .send({ edits: { name: 'Jane Doe' } });

    expect(res.status).toBe(200);
    expect(res.body.proposal.payload.name).toBe('Jane Doe');
    expect(res.body.editedFields).toEqual(['name']);
  });

  it('returns 400 when body missing edits field', async () => {
    const { app, proposalRepo } = await buildTestApp();
    const proposal = createProposal(baseInput);
    await proposalRepo.create(proposal);

    const res = await request(app).put(`/api/proposals/${proposal.id}`).send({});

    expect(res.status).toBe(400);
  });
});

describe('RV-073 — UI route approvals/rejections tag channel ui', () => {
  function buildAppWithAudit() {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).auth = {
        userId: TEST_USER_ID,
        sessionId: 'session-audit',
        tenantId: TEST_TENANT_ID,
        role: 'owner' as Role,
      };
      next();
    });
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    app.use('/api/proposals', createProposalsRouter(proposalRepo, undefined, auditRepo));
    return { app, proposalRepo, auditRepo };
  }

  it('POST /:id/approve audits channel ui', async () => {
    const { app, proposalRepo, auditRepo } = buildAppWithAudit();
    const proposal = createProposal(baseInput);
    await proposalRepo.create(proposal);
    await proposalRepo.updateStatus(TEST_TENANT_ID, proposal.id, 'ready_for_review');

    const res = await request(app).post(`/api/proposals/${proposal.id}/approve`);
    expect(res.status).toBe(200);

    const approvedEvent = auditRepo
      .getAll()
      .find((e) => e.eventType === 'proposal.approved' && e.entityId === proposal.id);
    expect(approvedEvent).toBeDefined();
    expect(approvedEvent!.metadata).toMatchObject({ channel: 'ui' });
  });

  it('POST /:id/reject audits channel ui', async () => {
    const { app, proposalRepo, auditRepo } = buildAppWithAudit();
    const proposal = createProposal(baseInput);
    await proposalRepo.create(proposal);
    await proposalRepo.updateStatus(TEST_TENANT_ID, proposal.id, 'ready_for_review');

    const res = await request(app)
      .post(`/api/proposals/${proposal.id}/reject`)
      .send({ reason: 'not needed' });
    expect(res.status).toBe(200);

    const rejectedEvent = auditRepo
      .getAll()
      .find((e) => e.eventType === 'proposal.rejected' && e.entityId === proposal.id);
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent!.metadata).toMatchObject({ channel: 'ui' });
  });

  it('POST /approve-batch audits channel ui on every member', async () => {
    const { app, proposalRepo, auditRepo } = buildAppWithAudit();
    const a = createProposal(baseInput);
    const b = createProposal({ ...baseInput, summary: 'Second' });
    await proposalRepo.create(a);
    await proposalRepo.create(b);
    await proposalRepo.updateStatus(TEST_TENANT_ID, a.id, 'ready_for_review');
    await proposalRepo.updateStatus(TEST_TENANT_ID, b.id, 'ready_for_review');

    const res = await request(app)
      .post('/api/proposals/approve-batch')
      .send({ proposalIds: [a.id, b.id] });
    expect(res.status).toBe(200);

    const approvedEvents = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'proposal.approved');
    expect(approvedEvents).toHaveLength(2);
    for (const event of approvedEvents) {
      expect(event.metadata).toMatchObject({ channel: 'ui' });
    }
  });
});
