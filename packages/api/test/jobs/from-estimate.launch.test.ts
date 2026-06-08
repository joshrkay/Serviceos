/**
 * Feature 5 — Estimate → Job conversion (launch-readiness pass).
 *
 * Exercises convertEstimateToScheduledJob: it reuses the estimate's existing
 * job, schedules an appointment + assigns a technician by availability, flips
 * the estimate to accepted, syncs job.assignedTechnicianId, and inherits the
 * estimate's line items. Plus a route-level check that POST
 * /api/jobs/from-estimate/:id is auth-gated.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import express from 'express';
import request from 'supertest';
import { convertEstimateToScheduledJob } from '../../src/jobs/from-estimate';
import { Job, InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryEstimateRepository, createEstimate } from '../../src/estimates/estimate';
import { InMemoryAppointmentRepository } from '../../src/appointments/appointment';
import { InMemoryAssignmentRepository, AssignmentRepository } from '../../src/appointments/assignment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { User, UserRepository } from '../../src/users/user';
import { buildLineItem } from '../../src/shared/billing-engine';
import { createJobRouter } from '../../src/routes/jobs';

// Real UUIDs: the conversion path now validates tenant/estimate/technician ids.
const TENANT = uuidv4();
const TECH_1 = uuidv4();
const TECH_2 = uuidv4();
const NOW = new Date('2026-06-10T00:00:00Z');

function tech(id: string): User {
  return {
    id, tenantId: TENANT, email: `${id}@x.com`, role: 'technician',
    canFieldServe: true, createdAt: NOW, updatedAt: NOW,
  };
}

function fakeUserRepo(users: User[]): UserRepository {
  return {
    findByTenant: async (t, opts) =>
      users.filter((u) => u.tenantId === t && (!opts?.role || u.role === opts.role)).map((u) => ({ ...u })),
    findById: async (t, id) => users.find((u) => u.tenantId === t && u.id === id) ?? null,
    findByMobileNumber: async () => null,
    update: async () => null,
  };
}

function makeJob(): Job {
  return {
    id: uuidv4(), tenantId: TENANT, customerId: uuidv4(), locationId: uuidv4(),
    jobNumber: 'JOB-1', summary: 'AC repair', status: 'scheduled', priority: 'normal',
    depositRequiredCents: 0, depositPaidCents: 0, depositStatus: 'not_required',
    moneyState: 'estimate_sent', createdBy: 'u1', createdAt: NOW, updatedAt: NOW,
  };
}

describe('Feature 5 — Estimate → Job conversion', () => {
  let estimateRepo: InMemoryEstimateRepository;
  let jobRepo: InMemoryJobRepository;
  let appointmentRepo: InMemoryAppointmentRepository;
  let assignmentRepo: InMemoryAssignmentRepository;
  let auditRepo: InMemoryAuditRepository;
  let invoiceRepo: InMemoryInvoiceRepository;

  beforeEach(() => {
    estimateRepo = new InMemoryEstimateRepository();
    jobRepo = new InMemoryJobRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
    assignmentRepo = new InMemoryAssignmentRepository();
    auditRepo = new InMemoryAuditRepository();
    invoiceRepo = new InMemoryInvoiceRepository();
  });

  function deps(users: User[]) {
    return { estimateRepo, jobRepo, appointmentRepo, assignmentRepo, userRepo: fakeUserRepo(users), invoiceRepo, auditRepo };
  }

  async function seedSentEstimate(jobId: string) {
    const est = await createEstimate(
      {
        tenantId: TENANT, jobId, estimateNumber: 'EST-1', createdBy: 'u1',
        lineItems: [
          buildLineItem('l1', 'Labor', 2, 12000, 0, false, 'labor'),
          buildLineItem('m1', 'Part', 1, 4500, 1, true, 'material'),
        ],
      },
      estimateRepo,
    );
    return (await estimateRepo.update(TENANT, est.id, { status: 'sent' }))!;
  }

  it('schedules + assigns the existing job and accepts the estimate', async () => {
    const job = await jobRepo.create(makeJob());
    const est = await seedSentEstimate(job.id);

    const result = await convertEstimateToScheduledJob(deps([tech(TECH_1)]), {
      tenantId: TENANT, estimateId: est.id, actorId: 'owner-1', actorRole: 'owner', now: NOW,
    });

    // Reuses the estimate's existing job (no new job minted).
    expect(result.job.id).toBe(job.id);
    // Estimate is accepted and keeps its line items.
    expect(result.estimate.status).toBe('accepted');
    expect(result.estimate.lineItems).toHaveLength(2);
    // An appointment + primary assignment now exist for the chosen tech.
    expect(result.appointment.jobId).toBe(job.id);
    expect(result.assignment.technicianId).toBe(TECH_1);
    expect(result.assignment.isPrimary).toBe(true);
    // Tech is denormalized onto the job.
    expect(result.job.assignedTechnicianId).toBe(TECH_1);
    // Job money-state rolls up to estimate_accepted (so downstream billing sees it).
    expect(result.job.moneyState).toBe('estimate_accepted');
    // Conversion is audited.
    expect(auditRepo.getAll().some((e) => e.eventType === 'job.created_from_estimate')).toBe(true);
  });

  it('honors an operator-specified technician and start time', async () => {
    const job = await jobRepo.create(makeJob());
    const est = await seedSentEstimate(job.id);
    const start = new Date('2026-06-12T15:00:00Z');

    const result = await convertEstimateToScheduledJob(deps([tech(TECH_1), tech(TECH_2)]), {
      tenantId: TENANT, estimateId: est.id, actorId: 'owner-1', actorRole: 'owner',
      technicianId: TECH_2, scheduledStart: start, durationMin: 90, now: NOW,
    });

    expect(result.assignment.technicianId).toBe(TECH_2);
    expect(result.appointment.scheduledStart.toISOString()).toBe(start.toISOString());
    expect(result.appointment.scheduledEnd.getTime() - result.appointment.scheduledStart.getTime()).toBe(90 * 60_000);
  });

  it('rejects a draft estimate (must be sent first)', async () => {
    const job = await jobRepo.create(makeJob());
    const est = await createEstimate(
      { tenantId: TENANT, jobId: job.id, estimateNumber: 'EST-2', createdBy: 'u1', lineItems: [buildLineItem('l1', 'Labor', 1, 10000, 0, false, 'labor')] },
      estimateRepo,
    );

    await expect(
      convertEstimateToScheduledJob(deps([tech(TECH_1)]), {
        tenantId: TENANT, estimateId: est.id, actorId: 'owner-1', now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('throws NotFoundError for a missing estimate', async () => {
    await expect(
      convertEstimateToScheduledJob(deps([tech(TECH_1)]), {
        tenantId: TENANT, estimateId: uuidv4(), actorId: 'owner-1', now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is idempotent for an already-accepted estimate', async () => {
    const job = await jobRepo.create(makeJob());
    const est = await seedSentEstimate(job.id);
    await estimateRepo.update(TENANT, est.id, { status: 'accepted' });

    const result = await convertEstimateToScheduledJob(deps([tech(TECH_1)]), {
      tenantId: TENANT, estimateId: est.id, actorId: 'owner-1', now: NOW,
    });
    expect(result.estimate.status).toBe('accepted');
    expect(result.assignment.technicianId).toBe(TECH_1);
  });

  it('409s with NO orphan appointment/assignment when the job already has an accepted estimate', async () => {
    const job = await jobRepo.create(makeJob());
    // A sibling estimate on the same job is already accepted.
    const accepted = await seedSentEstimate(job.id);
    await estimateRepo.update(TENANT, accepted.id, { status: 'accepted' });
    // A second, still-sent estimate on the same job.
    const sent = await seedSentEstimate(job.id);

    await expect(
      convertEstimateToScheduledJob(deps([tech(TECH_1)]), {
        tenantId: TENANT, estimateId: sent.id, actorId: 'owner-1', now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // The pre-flight check fired before scheduling — no side effects left behind.
    expect(await appointmentRepo.findByJob(TENANT, job.id)).toHaveLength(0);
  });

  it('retries cleanly after a failed assignment — never binds the job to a canceled appointment', async () => {
    const job = await jobRepo.create(makeJob());
    const est = await seedSentEstimate(job.id);

    // Assignment repo that throws on the FIRST create (a transient
    // double-booking/race), then behaves normally on retry.
    let failNext = true;
    const flakyAssign: AssignmentRepository = {
      create: async (a) => {
        if (failNext) { failNext = false; throw new Error('transient assign failure'); }
        return assignmentRepo.create(a);
      },
      update: (a) => assignmentRepo.update(a),
      findByAppointment: (t, id) => assignmentRepo.findByAppointment(t, id),
      findByTechnician: (t, id) => assignmentRepo.findByTechnician(t, id),
      delete: (t, id) => assignmentRepo.delete(t, id),
    };
    const flakyDeps = {
      estimateRepo, jobRepo, appointmentRepo, assignmentRepo: flakyAssign,
      userRepo: fakeUserRepo([tech(TECH_1)]), invoiceRepo, auditRepo,
    };

    // First attempt fails at assignment → compensation cancels the appointment.
    await expect(
      convertEstimateToScheduledJob(flakyDeps, { tenantId: TENANT, estimateId: est.id, actorId: 'owner-1', now: NOW }),
    ).rejects.toBeDefined();

    // Retry dedupes to the canceled appointment by key — it must be revived, not
    // returned as a canceled "scheduled job".
    const retry = await convertEstimateToScheduledJob(flakyDeps, {
      tenantId: TENANT, estimateId: est.id, actorId: 'owner-1', now: NOW,
    });
    expect(retry.appointment.status).not.toBe('canceled');
    expect(retry.assignment.technicianId).toBe(TECH_1);
    // Still exactly one appointment on the job (the revived one).
    const live = (await appointmentRepo.findByJob(TENANT, job.id)).filter((a) => a.status !== 'canceled');
    expect(live).toHaveLength(1);
  });

  it('re-conversion is idempotent — no duplicate appointment or assignment', async () => {
    const job = await jobRepo.create(makeJob());
    const est = await seedSentEstimate(job.id);

    const first = await convertEstimateToScheduledJob(deps([tech(TECH_1)]), {
      tenantId: TENANT, estimateId: est.id, actorId: 'owner-1', now: NOW,
    });
    // Retry / duplicate click — the estimate is already accepted now.
    const second = await convertEstimateToScheduledJob(deps([tech(TECH_1)]), {
      tenantId: TENANT, estimateId: est.id, actorId: 'owner-1', now: NOW,
    });

    expect(second.appointment.id).toBe(first.appointment.id);
    expect(await appointmentRepo.findByJob(TENANT, job.id)).toHaveLength(1);
    const assignments = await assignmentRepo.findByAppointment(TENANT, first.appointment.id);
    expect(assignments.filter((a) => a.isPrimary)).toHaveLength(1);
  });

  it('honors a pinned start by trying all technicians when the first is busy', async () => {
    const job = await jobRepo.create(makeJob());
    const est = await seedSentEstimate(job.id);
    const start = new Date('2026-06-12T15:00:00Z');

    // Tech 1 is already booked at the pinned start; tech 2 is free.
    const busy = await appointmentRepo.create({
      id: uuidv4(), tenantId: TENANT, jobId: uuidv4(),
      scheduledStart: start, scheduledEnd: new Date(start.getTime() + 60 * 60_000),
      timezone: 'UTC', status: 'scheduled', holdPendingApproval: false,
      createdBy: 'u1', createdAt: NOW, updatedAt: NOW,
    });
    await assignmentRepo.create({
      id: uuidv4(), tenantId: TENANT, appointmentId: busy.id, technicianId: TECH_1,
      isPrimary: true, assignedBy: 'u1', assignedAt: NOW,
    });

    const result = await convertEstimateToScheduledJob(deps([tech(TECH_1), tech(TECH_2)]), {
      tenantId: TENANT, estimateId: est.id, actorId: 'owner-1', scheduledStart: start, now: NOW,
    });

    // Tech 1 was busy at that slot, so the free tech 2 is assigned instead of erroring.
    expect(result.assignment.technicianId).toBe(TECH_2);
    expect(result.appointment.scheduledStart.toISOString()).toBe(start.toISOString());
  });

  it('pinned conversion retry is idempotent (no self-conflict on the same slot)', async () => {
    const job = await jobRepo.create(makeJob());
    const est = await seedSentEstimate(job.id);
    const start = new Date('2026-06-14T16:00:00Z');

    const first = await convertEstimateToScheduledJob(deps([tech(TECH_1)]), {
      tenantId: TENANT, estimateId: est.id, actorId: 'owner-1',
      technicianId: TECH_1, scheduledStart: start, now: NOW,
    });
    // Retry the SAME pinned request: the first call's own appointment occupies
    // that slot, so without the idempotent short-circuit this would 409. It must
    // instead dedupe to the same appointment.
    const retry = await convertEstimateToScheduledJob(deps([tech(TECH_1)]), {
      tenantId: TENANT, estimateId: est.id, actorId: 'owner-1',
      technicianId: TECH_1, scheduledStart: start, now: NOW,
    });

    expect(retry.appointment.id).toBe(first.appointment.id);
    expect(retry.assignment.technicianId).toBe(TECH_1);
    expect(await appointmentRepo.findByJob(TENANT, job.id)).toHaveLength(1);
  });

  it('respects an operator override on re-conversion (not deduped to the original)', async () => {
    const job = await jobRepo.create(makeJob());
    const est = await seedSentEstimate(job.id);

    // First, an auto conversion (picks the first available tech, tech 1).
    const auto = await convertEstimateToScheduledJob(deps([tech(TECH_1), tech(TECH_2)]), {
      tenantId: TENANT, estimateId: est.id, actorId: 'owner-1', now: NOW,
    });
    expect(auto.assignment.technicianId).toBe(TECH_1);

    // Then a deliberate re-schedule with an explicit tech + start — must NOT
    // dedupe onto the auto appointment, and must assign the chosen tech.
    const overrideStart = new Date('2026-06-13T14:00:00Z');
    const override = await convertEstimateToScheduledJob(deps([tech(TECH_1), tech(TECH_2)]), {
      tenantId: TENANT, estimateId: est.id, actorId: 'owner-1',
      technicianId: TECH_2, scheduledStart: overrideStart, now: NOW,
    });

    expect(override.appointment.id).not.toBe(auto.appointment.id);
    expect(override.assignment.technicianId).toBe(TECH_2);
    expect(override.appointment.scheduledStart.toISOString()).toBe(overrideStart.toISOString());
  });

  it('returns 503 when scheduling deps are not wired, and 401 unauthenticated', async () => {
    // No fromEstimateDeps -> NOT_CONFIGURED for an authenticated owner.
    const authed = express();
    authed.use(express.json());
    authed.use((req: any, _res, next) => {
      req.auth = { tenantId: TENANT, userId: 'owner-1', role: 'owner' };
      next();
    });
    authed.use('/api/jobs', createJobRouter({} as any, {} as any, {} as any, {} as any, {} as any, {} as any));
    const res503 = await request(authed).post('/api/jobs/from-estimate/abc').send({});
    expect(res503.status).toBe(503);

    // No auth -> 401 (route is behind requireAuth).
    const open = express();
    open.use(express.json());
    open.use('/api/jobs', createJobRouter({} as any, {} as any, {} as any, {} as any, {} as any, {} as any));
    const res401 = await request(open).post('/api/jobs/from-estimate/abc').send({});
    expect(res401.status).toBe(401);
  });
});
