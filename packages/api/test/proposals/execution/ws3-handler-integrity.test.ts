/**
 * QUALITY-2026-07-12 WS3 — structural audit + consent integrity for the four
 * voice-reachable mutation handlers that historically persisted WITHOUT an
 * audit event and (for update_customer) without the consent ledger.
 *
 * These are handler-level unit tests with mocked repos (per CLAUDE.md: voice/AI
 * behavior changes need handler-level tests with mocked gateway/repos). The
 * real-Postgres atomicity/rollback proof lives in
 * test/integration/ws3-consent-audit-atomicity.test.ts.
 *
 * Each handler must now:
 *   - emit its entity-level audit event (mocked audit repo captures it),
 *   - return { success: false, error: 'handler_not_wired:<dep>' } — never a
 *     synthetic success — when its persistence dep is missing,
 *   - (update_customer) append to the consent ledger on a consent-bearing
 *     change, and FAIL (propagate) when the ledger append throws.
 */
import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { UpdateCustomerExecutionHandler } from '../../../src/proposals/execution/handlers';
import { AddNoteExecutionHandler } from '../../../src/proposals/execution/voice-extended-handlers';
import {
  ConfirmAppointmentExecutionHandler,
  RequestFeedbackExecutionHandler,
} from '../../../src/proposals/execution/full-app-voice-handlers';
import { Proposal } from '../../../src/proposals/proposal';
import {
  InMemoryCustomerRepository,
  createCustomer,
} from '../../../src/customers/customer';
import { InMemoryNoteRepository } from '../../../src/notes/note';
import { InMemoryFeedbackRequestRepository } from '../../../src/feedback/feedback-request';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import { createAppointment } from '../../../src/appointments/appointment';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import {
  InMemoryConsentEventRepository,
  ConsentEventInput,
  ConsentEventRepository,
  ConsentEventRow,
} from '../../../src/compliance/consent-events';

const TENANT = '550e8400-e29b-41d4-a716-446655440000';
const EXECUTOR = 'user-ws3';
const CTX = { tenantId: TENANT, executedBy: EXECUTOR };

function makeProposal(
  proposalType: Proposal['proposalType'],
  payload: Record<string, unknown>,
): Proposal {
  return {
    id: uuidv4(),
    tenantId: TENANT,
    proposalType,
    status: 'approved',
    payload,
    summary: 'ws3 test',
    createdBy: EXECUTOR,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('WS3 — UpdateCustomerExecutionHandler', () => {
  it('emits a customer.updated audit event on a persisted change', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const auditRepo = new InMemoryAuditRepository();
    const created = await createCustomer(
      { tenantId: TENANT, firstName: 'Jane', lastName: 'Doe', createdBy: EXECUTOR },
      customerRepo,
    );
    const handler = new UpdateCustomerExecutionHandler(customerRepo, auditRepo);

    const result = await handler.execute(
      makeProposal('update_customer', { customerId: created.id, email: 'jane@x.com' }),
      CTX,
    );

    expect(result.success).toBe(true);
    const events = auditRepo.getAll().filter((e) => e.eventType === 'customer.updated');
    expect(events).toHaveLength(1);
    expect(events[0].entityType).toBe('customer');
    expect(events[0].entityId).toBe(created.id);
  });

  it('appends to the consent ledger on an smsConsent change', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const auditRepo = new InMemoryAuditRepository();
    const consentLedger = new InMemoryConsentEventRepository();
    const created = await createCustomer(
      {
        tenantId: TENANT,
        firstName: 'Sam',
        lastName: 'Ree',
        primaryPhone: '+15551234567',
        smsConsent: false,
        createdBy: EXECUTOR,
      },
      customerRepo,
    );
    const handler = new UpdateCustomerExecutionHandler(customerRepo, auditRepo, consentLedger);

    const result = await handler.execute(
      makeProposal('update_customer', { customerId: created.id, smsConsent: true }),
      CTX,
    );

    expect(result.success).toBe(true);
    expect(consentLedger.rows).toHaveLength(1);
    expect(consentLedger.rows[0]).toMatchObject({
      customerId: created.id,
      kind: 'sms',
      state: 'granted',
      source: 'manual',
    });
  });

  it('does NOT touch the consent ledger for a non-consent update', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const consentLedger = new InMemoryConsentEventRepository();
    const created = await createCustomer(
      { tenantId: TENANT, firstName: 'No', lastName: 'Consent', primaryPhone: '+15550001111', createdBy: EXECUTOR },
      customerRepo,
    );
    const handler = new UpdateCustomerExecutionHandler(
      customerRepo,
      new InMemoryAuditRepository(),
      consentLedger,
    );

    await handler.execute(
      makeProposal('update_customer', { customerId: created.id, email: 'new@x.com' }),
      CTX,
    );

    expect(consentLedger.rows).toHaveLength(0);
  });

  it('FAILS (propagates) when the consent-ledger append throws on a consent-bearing update', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const created = await createCustomer(
      { tenantId: TENANT, firstName: 'Boom', lastName: 'X', primaryPhone: '+15559998888', smsConsent: false, createdBy: EXECUTOR },
      customerRepo,
    );
    // A ledger whose append fails — no longer swallowed (WS3).
    const failingLedger: ConsentEventRepository = {
      append: async (_input: ConsentEventInput): Promise<ConsentEventRow> => {
        throw new Error('ledger write failed');
      },
      listByPhone: async () => [],
    };
    const handler = new UpdateCustomerExecutionHandler(
      customerRepo,
      new InMemoryAuditRepository(),
      failingLedger,
    );

    const result = await handler.execute(
      makeProposal('update_customer', { customerId: created.id, smsConsent: true }),
      CTX,
    );

    // The handler surfaces the failure rather than reporting a bogus success.
    // (In production this runs inside the executor transaction, so the whole
    // customer update rolls back — proven in the integration suite.)
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ledger write failed/);
  });

  it('returns handler_not_wired (not synthetic success) when the customer repo is missing', async () => {
    const handler = new UpdateCustomerExecutionHandler(undefined, new InMemoryAuditRepository());
    const result = await handler.execute(
      makeProposal('update_customer', { customerId: uuidv4(), email: 'x@y.com' }),
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('handler_not_wired:customerRepo');
  });

  it('isFullyWired reflects the customer repo', () => {
    expect(new UpdateCustomerExecutionHandler(undefined, new InMemoryAuditRepository()).isFullyWired()).toBe(false);
    expect(
      new UpdateCustomerExecutionHandler(new InMemoryCustomerRepository(), new InMemoryAuditRepository()).isFullyWired(),
    ).toBe(true);
  });
});

describe('WS3 — AddNoteExecutionHandler', () => {
  const validUuid = '660e8400-e29b-41d4-a716-446655440001';

  it('emits a note.created audit event on a persisted note', async () => {
    const noteRepo = new InMemoryNoteRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new AddNoteExecutionHandler(noteRepo, auditRepo);

    const result = await handler.execute(
      makeProposal('add_note', { body: 'gate code 1234', targetKind: 'job', targetId: validUuid }),
      CTX,
    );

    expect(result.success).toBe(true);
    const events = auditRepo.getAll().filter((e) => e.eventType === 'note.created');
    expect(events).toHaveLength(1);
    expect(events[0].entityId).toBe(result.resultEntityId);
  });

  it('returns handler_not_wired when the note repo is missing', async () => {
    const handler = new AddNoteExecutionHandler(undefined, new InMemoryAuditRepository());
    const result = await handler.execute(
      makeProposal('add_note', { body: 'x', targetKind: 'job', targetId: validUuid }),
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('handler_not_wired:noteRepo');
  });
});

describe('WS3 — ConfirmAppointmentExecutionHandler', () => {
  async function seedAppointment(repo: InMemoryAppointmentRepository): Promise<string> {
    const appt = await createAppointment(
      {
        tenantId: TENANT,
        jobId: uuidv4(),
        scheduledStart: new Date('2099-01-01T10:00:00Z'),
        scheduledEnd: new Date('2099-01-01T12:00:00Z'),
        timezone: 'UTC',
        createdBy: EXECUTOR,
      },
      repo,
    );
    return appt.id;
  }

  it('emits an appointment.confirmed audit event and confirms the appointment', async () => {
    const apptRepo = new InMemoryAppointmentRepository();
    const auditRepo = new InMemoryAuditRepository();
    const apptId = await seedAppointment(apptRepo);
    const handler = new ConfirmAppointmentExecutionHandler(apptRepo, auditRepo);

    const result = await handler.execute(
      makeProposal('confirm_appointment', { appointmentId: apptId }),
      CTX,
    );

    expect(result.success).toBe(true);
    const confirmed = await apptRepo.findById(TENANT, apptId);
    expect(confirmed?.status).toBe('confirmed');
    const events = auditRepo.getAll().filter((e) => e.eventType === 'appointment.confirmed');
    expect(events).toHaveLength(1);
    expect(events[0].entityId).toBe(apptId);
  });

  it('returns handler_not_wired when the appointment repo is missing', async () => {
    const handler = new ConfirmAppointmentExecutionHandler(undefined, new InMemoryAuditRepository());
    const result = await handler.execute(
      makeProposal('confirm_appointment', { appointmentId: uuidv4() }),
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('handler_not_wired:appointmentRepo');
  });
});

describe('WS3 — RequestFeedbackExecutionHandler', () => {
  it('emits a feedback_request.created audit event on a persisted request', async () => {
    const feedbackRepo = new InMemoryFeedbackRequestRepository();
    const auditRepo = new InMemoryAuditRepository();
    const handler = new RequestFeedbackExecutionHandler(feedbackRepo, auditRepo);

    const result = await handler.execute(
      makeProposal('request_feedback', { jobId: uuidv4() }),
      CTX,
    );

    expect(result.success).toBe(true);
    const events = auditRepo.getAll().filter((e) => e.eventType === 'feedback_request.created');
    expect(events).toHaveLength(1);
    expect(events[0].entityId).toBe(result.resultEntityId);
  });

  it('returns handler_not_wired when the feedback repo is missing', async () => {
    const handler = new RequestFeedbackExecutionHandler(undefined, new InMemoryAuditRepository());
    const result = await handler.execute(
      makeProposal('request_feedback', { jobId: uuidv4() }),
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('handler_not_wired:feedbackRepo');
  });
});
