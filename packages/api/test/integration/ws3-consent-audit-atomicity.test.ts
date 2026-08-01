import { describe, it, expect, beforeAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgBaseRepository } from '../../src/db/pg-base';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { AuditEvent, AuditRepository } from '../../src/audit/audit';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { createCustomer } from '../../src/customers/customer';
import {
  PgConsentEventRepository,
  ConsentEventInput,
  ConsentEventRepository,
  ConsentEventRow,
} from '../../src/compliance/consent-events';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { PgIdempotencyLockProvider } from '../../src/proposals/execution/idempotency-lock';
import {
  ExecutionContext,
  ExecutionHandler,
  UpdateCustomerExecutionHandler,
} from '../../src/proposals/execution/handlers';
import { AddNoteExecutionHandler } from '../../src/proposals/execution/voice-extended-handlers';
import {
  ConfirmAppointmentExecutionHandler,
  RequestFeedbackExecutionHandler,
} from '../../src/proposals/execution/full-app-voice-handlers';
import { PgNoteRepository } from '../../src/notes/pg-note';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgFeedbackRequestRepository } from '../../src/feedback/pg-feedback-request';
import { Proposal, ProposalType, createProposal } from '../../src/proposals/proposal';
import { transitionProposal } from '../../src/proposals/lifecycle';

/**
 * QUALITY-2026-07-12 WS3 — real-Postgres atomicity proof for the four
 * voice-reachable mutation handlers that WS3 hardened. The executor runs each
 * DB-only handler inside ONE tenant-scoped transaction on the advisory lock's
 * connection (DATA-31 / WS11 seam); repository calls made inside the handler
 * join that transaction via the ambient tenant context. This suite pins that
 * the domain mutation, its audit event, and (for update_customer) the consent
 * ledger row all commit together — or all roll back together.
 */

// ── failing-write repos: fail at the DATABASE level on the ambient client so
// the whole executor transaction aborts, exactly like a real bad write ──

/** Audit repo that fails (NULL tenant_id) only for a targeted event type; every
 *  other event (incl. the executor's own proposal.executed) goes to the real
 *  repo so the transaction is only poisoned by the domain-audit insert. */
class AuditFailOnEvent extends PgBaseRepository implements AuditRepository {
  constructor(
    pool: Pool,
    private readonly failEventType: string,
    private readonly real: PgAuditRepository,
  ) {
    super(pool);
  }
  async create(event: AuditEvent): Promise<AuditEvent> {
    if (event.eventType === this.failEventType) {
      return this.withTenant(event.tenantId, async (client) => {
        await client.query(
          `INSERT INTO audit_events (id, tenant_id, actor_id, actor_role, event_type, entity_type, entity_id)
           VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
          [event.id, event.actorId, event.actorRole, event.eventType, event.entityType, event.entityId],
        );
        return event;
      });
    }
    return this.real.create(event);
  }
  async findByEntity(): Promise<AuditEvent[]> {
    return [];
  }
  async findByCorrelation(): Promise<AuditEvent[]> {
    return [];
  }
}

/** Consent ledger whose append fails at the DB level (NULL tenant_id) — proves
 *  a consent-bearing update rolls back when the ledger write fails. */
class ConsentFailRepo extends PgBaseRepository implements ConsentEventRepository {
  async append(input: ConsentEventInput): Promise<ConsentEventRow> {
    return this.withTenant(input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO consent_events (tenant_id, phone_normalized, kind, state, source)
         VALUES (NULL, $1, $2, $3, $4)`,
        [input.phone.replace(/\D/g, ''), input.kind, input.state, input.source],
      );
      // Unreachable — the NULL tenant_id insert throws first.
      throw new Error('consent append unreachable');
    });
  }
  async listByPhone(): Promise<ConsentEventRow[]> {
    return [];
  }
}

// ── read helpers (FORCE RLS → the GUC must be set) ──

async function withTenantRead<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('RESET app.current_tenant_id').catch(() => undefined);
    client.release();
  }
}

async function getCustomerRow(
  pool: Pool,
  tenantId: string,
  id: string,
): Promise<{ email: string | null; sms_consent: boolean } | null> {
  return withTenantRead(pool, tenantId, async (client) => {
    const res = await client.query(
      'SELECT email, sms_consent FROM customers WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return res.rows[0] ?? null;
  });
}

async function countConsentRows(pool: Pool, tenantId: string, customerId: string): Promise<number> {
  return withTenantRead(pool, tenantId, async (client) => {
    const res = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM consent_events WHERE tenant_id = $1 AND customer_id = $2',
      [tenantId, customerId],
    );
    return res.rows[0].n;
  });
}

async function auditRowsByType(
  pool: Pool,
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<string[]> {
  return withTenantRead(pool, tenantId, async (client) => {
    const res = await client.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events
        WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3
        ORDER BY created_at`,
      [tenantId, entityType, entityId],
    );
    return res.rows.map((r) => r.event_type);
  });
}

async function seedCustomer(
  pool: Pool,
  tenantId: string,
  userId: string,
  opts: { smsConsent?: boolean } = {},
): Promise<string> {
  const repo = new PgCustomerRepository(pool);
  const c = await createCustomer(
    {
      tenantId,
      firstName: 'Ws3',
      lastName: 'Customer',
      primaryPhone: '+15551234567',
      smsConsent: opts.smsConsent ?? false,
      createdBy: userId,
    },
    repo,
  );
  return c.id;
}

async function seedJob(pool: Pool, tenantId: string, userId: string): Promise<string> {
  const customerId = await seedCustomer(pool, tenantId, userId);
  const locationId = randomUUID();
  const jobId = randomUUID();
  await withTenantRead(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
       VALUES ($1, $2, $3, '1 Main St', 'Town', 'CA', '90001')`,
      [locationId, tenantId, customerId],
    );
    await client.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by)
       VALUES ($1, $2, $3, $4, 'J-1', 'ws3 job', $5)`,
      [jobId, tenantId, customerId, locationId, userId],
    );
  });
  return jobId;
}

async function seedAppointment(
  pool: Pool,
  tenantId: string,
  userId: string,
  jobId: string,
): Promise<string> {
  const apptId = randomUUID();
  await withTenantRead(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO appointments (id, tenant_id, job_id, scheduled_start, scheduled_end, timezone, status, created_by)
       VALUES ($1, $2, $3, '2099-01-01T10:00:00Z', '2099-01-01T12:00:00Z', 'UTC', 'scheduled', $4)`,
      [apptId, tenantId, jobId, userId],
    );
  });
  return apptId;
}

async function makeApproved(
  proposalRepo: PgProposalRepository,
  tenantId: string,
  userId: string,
  proposalType: ProposalType,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Proposal> {
  let p = createProposal({
    tenantId,
    proposalType,
    payload,
    summary: 'ws3 atomicity',
    createdBy: userId,
    idempotencyKey,
  });
  p = transitionProposal(p, 'ready_for_review', 'test');
  p = transitionProposal(p, 'approved', 'test');
  p = { ...p, approvedAt: new Date(Date.now() - 10_000) };
  return proposalRepo.create(p);
}

describe('WS3 — voice mutation handler audit/consent atomicity (real Postgres)', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let executionRepo: PgProposalExecutionRepository;

  function makeGuard(): IdempotencyGuard {
    return new IdempotencyGuard(executionRepo, proposalRepo, new PgIdempotencyLockProvider(pool));
  }

  function makeExecutor(
    handler: ExecutionHandler,
    auditRepo: AuditRepository,
  ): ProposalExecutor {
    return new ProposalExecutor(
      new Map<ProposalType, ExecutionHandler>([[handler.proposalType, handler]]),
      proposalRepo,
      makeGuard(),
      auditRepo,
      { executionRepo },
    );
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    executionRepo = new PgProposalExecutionRepository(pool);
  });

  // ── update_customer ──────────────────────────────────────────

  it('(a) commits customer update + customer.updated audit + consent row together', async () => {
    const t = await createTestTenant(pool);
    const customerId = await seedCustomer(pool, t.tenantId, t.userId, { smsConsent: false });
    const handler = new UpdateCustomerExecutionHandler(
      new PgCustomerRepository(pool),
      new PgAuditRepository(pool),
      new PgConsentEventRepository(pool),
    );
    const executor = makeExecutor(handler, new PgAuditRepository(pool));
    const proposal = await makeApproved(
      proposalRepo,
      t.tenantId,
      t.userId,
      'update_customer',
      { customerId, smsConsent: true, email: 'updated@x.com' },
      `ws3-uc-happy-${randomUUID()}`,
    );
    const ctx: ExecutionContext = { tenantId: t.tenantId, executedBy: t.userId };

    const { proposal: after } = await executor.execute(proposal, ctx);

    expect(after.status).toBe('executed');
    const row = await getCustomerRow(pool, t.tenantId, customerId);
    expect(row?.email).toBe('updated@x.com');
    expect(row?.sms_consent).toBe(true);
    expect(await countConsentRows(pool, t.tenantId, customerId)).toBe(1);
    expect(await auditRowsByType(pool, t.tenantId, 'customer', customerId)).toContain(
      'customer.updated',
    );
  });

  it('(b) audit-write failure rolls back the customer update AND the consent row', async () => {
    const t = await createTestTenant(pool);
    const customerId = await seedCustomer(pool, t.tenantId, t.userId, { smsConsent: false });
    const handler = new UpdateCustomerExecutionHandler(
      new PgCustomerRepository(pool),
      new AuditFailOnEvent(pool, 'customer.updated', new PgAuditRepository(pool)),
      new PgConsentEventRepository(pool),
    );
    // Same failing instance is the executor's audit repo too (it never reaches
    // proposal.executed because customer.updated aborts the tx first).
    const executor = makeExecutor(
      handler,
      new AuditFailOnEvent(pool, 'customer.updated', new PgAuditRepository(pool)),
    );
    const proposal = await makeApproved(
      proposalRepo,
      t.tenantId,
      t.userId,
      'update_customer',
      { customerId, smsConsent: true, email: 'rolledback@x.com' },
      `ws3-uc-auditfail-${randomUUID()}`,
    );
    const ctx: ExecutionContext = { tenantId: t.tenantId, executedBy: t.userId };

    await expect(executor.execute(proposal, ctx)).rejects.toThrow();

    // Nothing survived the rollback.
    const row = await getCustomerRow(pool, t.tenantId, customerId);
    expect(row?.email).toBeNull();
    expect(row?.sms_consent).toBe(false);
    expect(await countConsentRows(pool, t.tenantId, customerId)).toBe(0);
    const stranded = await proposalRepo.findById(t.tenantId, proposal.id);
    expect(stranded?.status).toBe('approved');
    const marker = await executionRepo.findByIdempotencyKey(t.tenantId, proposal.idempotencyKey!);
    expect(marker).toBeNull();
  });

  it('(c) consent-ledger failure rolls back the customer update', async () => {
    const t = await createTestTenant(pool);
    const customerId = await seedCustomer(pool, t.tenantId, t.userId, { smsConsent: false });
    const handler = new UpdateCustomerExecutionHandler(
      new PgCustomerRepository(pool),
      new PgAuditRepository(pool),
      new ConsentFailRepo(pool),
    );
    const executor = makeExecutor(handler, new PgAuditRepository(pool));
    const proposal = await makeApproved(
      proposalRepo,
      t.tenantId,
      t.userId,
      'update_customer',
      { customerId, smsConsent: true, email: 'consentfail@x.com' },
      `ws3-uc-consentfail-${randomUUID()}`,
    );
    const ctx: ExecutionContext = { tenantId: t.tenantId, executedBy: t.userId };

    await expect(executor.execute(proposal, ctx)).rejects.toThrow();

    const row = await getCustomerRow(pool, t.tenantId, customerId);
    expect(row?.email).toBeNull();
    expect(row?.sms_consent).toBe(false);
    expect(await countConsentRows(pool, t.tenantId, customerId)).toBe(0);
    expect(await auditRowsByType(pool, t.tenantId, 'customer', customerId)).not.toContain(
      'customer.updated',
    );
    const stranded = await proposalRepo.findById(t.tenantId, proposal.id);
    expect(stranded?.status).toBe('approved');
  });

  it('(d) re-executing the same proposal is idempotent — no duplicate audit/consent rows', async () => {
    const t = await createTestTenant(pool);
    const customerId = await seedCustomer(pool, t.tenantId, t.userId, { smsConsent: false });
    const handler = new UpdateCustomerExecutionHandler(
      new PgCustomerRepository(pool),
      new PgAuditRepository(pool),
      new PgConsentEventRepository(pool),
    );
    const executor = makeExecutor(handler, new PgAuditRepository(pool));
    const proposal = await makeApproved(
      proposalRepo,
      t.tenantId,
      t.userId,
      'update_customer',
      { customerId, smsConsent: true },
      `ws3-uc-idem-${randomUUID()}`,
    );
    const ctx: ExecutionContext = { tenantId: t.tenantId, executedBy: t.userId };

    const first = await executor.execute(proposal, ctx);
    expect(first.proposal.status).toBe('executed');
    // Replay the same (still-approved) proposal object — the idempotency guard
    // short-circuits on the shared key.
    const second = await executor.execute(proposal, ctx);
    expect(second.alreadyExecuted).toBe(true);

    expect(await countConsentRows(pool, t.tenantId, customerId)).toBe(1);
    const events = await auditRowsByType(pool, t.tenantId, 'customer', customerId);
    expect(events.filter((e) => e === 'customer.updated')).toHaveLength(1);
  });

  // ── add_note / confirm_appointment / request_feedback ─────────

  it('(e1) add_note commits the note + note.created audit', async () => {
    const t = await createTestTenant(pool);
    const customerId = await seedCustomer(pool, t.tenantId, t.userId);
    const handler = new AddNoteExecutionHandler(new PgNoteRepository(pool), new PgAuditRepository(pool));
    const executor = makeExecutor(handler, new PgAuditRepository(pool));
    const proposal = await makeApproved(
      proposalRepo,
      t.tenantId,
      t.userId,
      'add_note',
      { body: 'gate code 4321', targetKind: 'customer', targetId: customerId },
      `ws3-note-${randomUUID()}`,
    );
    const { proposal: after, result } = await executor.execute(proposal, {
      tenantId: t.tenantId,
      executedBy: t.userId,
    });

    expect(after.status).toBe('executed');
    expect(await auditRowsByType(pool, t.tenantId, 'note', result.resultEntityId!)).toContain(
      'note.created',
    );
  });

  it('(e2) confirm_appointment commits the status flip + appointment.confirmed audit', async () => {
    const t = await createTestTenant(pool);
    const jobId = await seedJob(pool, t.tenantId, t.userId);
    const apptId = await seedAppointment(pool, t.tenantId, t.userId, jobId);
    const handler = new ConfirmAppointmentExecutionHandler(
      new PgAppointmentRepository(pool),
      new PgAuditRepository(pool),
    );
    const executor = makeExecutor(handler, new PgAuditRepository(pool));
    const proposal = await makeApproved(
      proposalRepo,
      t.tenantId,
      t.userId,
      'confirm_appointment',
      { appointmentId: apptId },
      `ws3-confirm-${randomUUID()}`,
    );
    const { proposal: after } = await executor.execute(proposal, {
      tenantId: t.tenantId,
      executedBy: t.userId,
    });

    expect(after.status).toBe('executed');
    const status = await withTenantRead(pool, t.tenantId, async (client) => {
      const res = await client.query<{ status: string }>(
        'SELECT status FROM appointments WHERE tenant_id = $1 AND id = $2',
        [t.tenantId, apptId],
      );
      return res.rows[0]?.status;
    });
    expect(status).toBe('confirmed');
    expect(await auditRowsByType(pool, t.tenantId, 'appointment', apptId)).toContain(
      'appointment.confirmed',
    );
  });

  it('(e3) confirm_appointment audit failure rolls back the status flip', async () => {
    const t = await createTestTenant(pool);
    const jobId = await seedJob(pool, t.tenantId, t.userId);
    const apptId = await seedAppointment(pool, t.tenantId, t.userId, jobId);
    const handler = new ConfirmAppointmentExecutionHandler(
      new PgAppointmentRepository(pool),
      new AuditFailOnEvent(pool, 'appointment.confirmed', new PgAuditRepository(pool)),
    );
    const executor = makeExecutor(
      handler,
      new AuditFailOnEvent(pool, 'appointment.confirmed', new PgAuditRepository(pool)),
    );
    const proposal = await makeApproved(
      proposalRepo,
      t.tenantId,
      t.userId,
      'confirm_appointment',
      { appointmentId: apptId },
      `ws3-confirm-fail-${randomUUID()}`,
    );

    await expect(
      executor.execute(proposal, { tenantId: t.tenantId, executedBy: t.userId }),
    ).rejects.toThrow();

    const status = await withTenantRead(pool, t.tenantId, async (client) => {
      const res = await client.query<{ status: string }>(
        'SELECT status FROM appointments WHERE tenant_id = $1 AND id = $2',
        [t.tenantId, apptId],
      );
      return res.rows[0]?.status;
    });
    // Rolled back to the seeded status — the confirm never committed.
    expect(status).toBe('scheduled');
    const stranded = await proposalRepo.findById(t.tenantId, proposal.id);
    expect(stranded?.status).toBe('approved');
  });

  it('(e4) request_feedback commits the feedback request + feedback_request.created audit', async () => {
    const t = await createTestTenant(pool);
    const jobId = await seedJob(pool, t.tenantId, t.userId);
    const handler = new RequestFeedbackExecutionHandler(
      new PgFeedbackRequestRepository(pool),
      new PgAuditRepository(pool),
    );
    const executor = makeExecutor(handler, new PgAuditRepository(pool));
    const proposal = await makeApproved(
      proposalRepo,
      t.tenantId,
      t.userId,
      'request_feedback',
      { jobId },
      `ws3-feedback-${randomUUID()}`,
    );
    const { proposal: after, result } = await executor.execute(proposal, {
      tenantId: t.tenantId,
      executedBy: t.userId,
    });

    expect(after.status).toBe('executed');
    expect(
      await auditRowsByType(pool, t.tenantId, 'feedback_request', result.resultEntityId!),
    ).toContain('feedback_request.created');
  });
});
