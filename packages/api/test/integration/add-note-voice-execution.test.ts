/**
 * B7.4 (rivet-voice-19) — "Note on the Patel job — wants morning visits"
 * against REAL Postgres.
 *
 * This is the proof for the run's most dangerous voice defect: the note
 * proposal used to be approvable with an unresolved target and then fail at
 * execution, losing the dictated note with no error reaching the owner. The
 * test drives the TASK-PRODUCED payload (never a hand-built one) through the
 * real approval gate and the production execution registry, so a regression
 * anywhere in that chain shows up here as a missing row.
 *
 * Runs only under `npm run test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { PgNoteRepository } from '../../src/notes/pg-note';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { missingFieldsFor, Proposal } from '../../src/proposals/proposal';
import { UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { approveProposal } from '../../src/proposals/actions';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionContext,
} from '../../src/proposals/execution/handlers';
import { AddNoteTaskHandler } from '../../src/ai/tasks/voice-extended-tasks';
import type { TaskContext } from '../../src/ai/tasks/task-handlers';

describe('Postgres integration — voice add_note ("Note on the Patel job") → approve → execute → persist + audit', () => {
  let pool: Pool;
  let auditRepo: PgAuditRepository;
  let noteRepo: PgNoteRepository;
  let proposalRepo: PgProposalRepository;
  let executor: ProposalExecutor;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;
  let noteId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    auditRepo = new PgAuditRepository(pool);
    noteRepo = new PgNoteRepository(pool);
    proposalRepo = new PgProposalRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Patel',
      lastName: 'Household',
      displayName: 'Patel Household',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '9 Patel Ave',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-PATEL-NOTE',
      summary: 'Patel — seasonal service',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const registry = createExecutionHandlerRegistry({ noteRepo, auditRepo });
    const guard = new IdempotencyGuard(new PgProposalExecutionRepository(pool), proposalRepo);
    executor = new ProposalExecutor(registry, proposalRepo, guard, auditRepo);

    // 1) Draft via the REAL task handler, consuming the resolver-threaded
    // jobId exactly as voice-action-router.ts:1490-1508 leaves it.
    const taskContext: TaskContext = {
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      message: 'Note on the Patel job — wants morning visits',
      existingEntities: {
        jobId,
        jobReference: 'the Patel job',
        noteTargetKind: 'job',
        noteBody: 'wants morning visits',
      },
    };
    const { proposal: drafted } = await new AddNoteTaskHandler().handle(taskContext);

    expect(drafted.proposalType).toBe('add_note');
    expect(drafted.payload.targetId).toBe(jobId);
    // The whole point of B7.4: a resolved target leaves nothing gated…
    expect(missingFieldsFor(drafted)).toEqual([]);

    await proposalRepo.create(drafted);

    // 2) …so the real approval gate lets it through.
    const approved: Proposal = await approveProposal(
      proposalRepo,
      tenant.tenantId,
      drafted.id,
      tenant.userId,
      'owner',
      auditRepo,
      'ui',
    );
    expect(approved.status).toBe('approved');

    // 3) Execute past the undo window via the production registry.
    const backdated: Proposal = {
      ...approved,
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    };
    const context: ExecutionContext = { tenantId: tenant.tenantId, executedBy: tenant.userId };
    const { result } = await executor.execute(backdated, context);

    expect(result.success).toBe(true);
    noteId = result.resultEntityId as string;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists the dictated note on the job', async () => {
    const { rows } = await pool.query(
      `SELECT tenant_id, entity_type, entity_id, content FROM notes WHERE id = $1`,
      [noteId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].entity_type).toBe('job');
    expect(rows[0].entity_id).toBe(jobId);
    // Verbatim — the dictated body, not the whole utterance.
    expect(rows[0].content).toBe('wants morning visits');
  });

  it('emits exactly one note-created audit event with actor attribution', async () => {
    const { rows } = await pool.query(
      `SELECT event_type, actor_id FROM audit_events
        WHERE entity_type = 'note' AND entity_id = $1`,
      [noteId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(tenant.userId);
  });

  it('does not expose the note to another tenant (scoped read)', async () => {
    const other = await createTestTenant(pool);
    const found = await noteRepo.findById(other.tenantId, noteId);
    expect(found).toBeNull();
  });
});
