/**
 * #1479 item 3 (a #1408 recurrence) — a job opened by executing an approved
 * proposal must record the approver's role as the job.created audit
 * actor_role, not 'unknown'. QA saw 'unknown' on a placeholder job the
 * assistant opened for the matrix owner (create_appointment's jobTitle
 * fallback).
 *
 * Seam: the exported execution handlers, with the ExecutionContext the
 * approval path builds (executedBy + executedByRole).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CreateAppointmentExecutionHandler,
  CreateJobExecutionHandler,
} from '../../../src/proposals/execution/handlers';
import type { Proposal, ProposalType } from '../../../src/proposals/proposal';
import { InMemoryAppointmentRepository } from '../../../src/appointments/appointment';
import { InMemoryAssignmentRepository } from '../../../src/appointments/assignment';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryJobRepository } from '../../../src/jobs/job';
import { InMemoryLocationRepository, createLocation } from '../../../src/locations/location';

const tenantId = '550e8400-e29b-41d4-a716-446655440000';
const customerId = '660e8400-e29b-41d4-a716-446655440099';
const context = { tenantId, executedBy: 'user-owner-1', executedByRole: 'owner' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

function makeProposal(proposalType: ProposalType, payload: Record<string, unknown>): Proposal {
  return {
    id: `prop-${proposalType}`,
    tenantId,
    proposalType,
    status: 'approved',
    payload,
    summary: 'Proposal',
    createdBy: 'user-owner-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function locationRepoWithPrimary(): Promise<InMemoryLocationRepository> {
  const locationRepo = new InMemoryLocationRepository();
  await createLocation(
    {
      tenantId,
      customerId,
      street1: '123 Main St',
      city: 'Anytown',
      state: 'CA',
      postalCode: '90210',
      isPrimary: true,
    },
    locationRepo,
  );
  return locationRepo;
}

function jobCreatedRoles(auditRepo: InMemoryAuditRepository): string[] {
  return auditRepo
    .getAll()
    .filter((e) => e.eventType === 'job.created')
    .map((e) => e.actorRole);
}

describe('job.created audit actor_role on proposal execution (#1479)', () => {
  it("create_appointment's placeholder job records the approver's role", async () => {
    const auditRepo = new InMemoryAuditRepository();
    const handler = new CreateAppointmentExecutionHandler(
      new InMemoryAppointmentRepository(),
      new InMemoryAssignmentRepository(),
      { enqueue: async () => {} },
      auditRepo,
      new InMemoryJobRepository(),
      undefined,
      undefined,
      await locationRepoWithPrimary(),
    );

    const result = await handler.execute(
      makeProposal('create_appointment', {
        jobTitle: 'Furnace tune-up',
        customerId,
        scheduledStart: '2026-08-01T14:00:00Z',
        scheduledEnd: '2026-08-01T15:00:00Z',
      }),
      context,
    );

    expect(result.success).toBe(true);
    expect(jobCreatedRoles(auditRepo)).toEqual(['owner']);
  });

  it("create_job records the approver's role", async () => {
    const auditRepo = new InMemoryAuditRepository();
    const handler = new CreateJobExecutionHandler(
      new InMemoryJobRepository(),
      await locationRepoWithPrimary(),
      auditRepo,
    );

    const result = await handler.execute(
      makeProposal('create_job', { customerId, title: 'Replace water heater' }),
      context,
    );

    expect(result.success).toBe(true);
    expect(jobCreatedRoles(auditRepo)).toEqual(['owner']);
  });
});
