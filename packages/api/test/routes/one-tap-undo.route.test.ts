/**
 * UB-D / D-015 (D3) — public one-tap UNDO route.
 *
 * Redemption paths:
 *  - proposal still 'approved' (inside the 5s undo window) → existing
 *    undoProposal path (status 'undone') + held slot released;
 *  - proposal 'executed' → compensating cancel + FIXED-TEMPLATE apology SMS
 *    (consent/DNC-gated) + `autonomous_booking_undone` audit;
 *  - double-tap is idempotent (200 without double-cancelling or re-texting);
 *  - expired/tampered tokens → 410/401; forged token bound to a non-booking
 *    proposal type → 403 (defense in depth).
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createOneTapUndoRouter,
  AUTONOMOUS_UNDO_APOLOGY_SMS,
} from '../../src/routes/one-tap-undo';
import { createOneTapUndoToken } from '../../src/proposals/one-tap-undo';
import { createInMemoryNonceStore } from '../../src/proposals/auto-approve';
import {
  InMemoryProposalRepository,
  createProposal,
  type Proposal,
} from '../../src/proposals/proposal';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import type { MessageDeliveryProvider } from '../../src/notifications/delivery-provider';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { createAppointment } from '../../src/appointments/appointment';
import type { JobRepository } from '../../src/jobs/job';
import type { Customer, CustomerRepository } from '../../src/customers/customer';
import type { CustomerMessageDeliveryDeps } from '../../src/notifications/customer-message-delivery';
import { createLogger } from '../../src/logging/logger';

const TENANT = 't-1';
const JOB_ID = '00000000-0000-4000-8000-000000000abc';
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
const SECRET = 'test-undo-secret';

const customer = {
  id: CUSTOMER_ID,
  tenantId: TENANT,
  firstName: 'Dana',
  lastName: 'Lee',
  displayName: 'Dana Lee',
  primaryPhone: '+15125550111',
  preferredChannel: 'sms',
  smsConsent: true,
} as unknown as Customer;

async function makeApp(opts: {
  proposalStatus: 'approved' | 'executed' | 'ready_for_review';
  proposalType?: 'create_booking' | 'add_note';
  onDnc?: boolean;
}) {
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();

  const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
  const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const appointment = await createAppointment(
    {
      tenantId: TENANT,
      jobId: JOB_ID,
      scheduledStart: inOneHour,
      scheduledEnd: inTwoHours,
      timezone: 'America/New_York',
      createdBy: 'voice',
      // Executed bookings have been confirmed (hold cleared); approved ones
      // still hold.
      holdPendingApproval: opts.proposalStatus === 'approved',
      holdExpiryAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
    appointmentRepo,
  );

  const base = createProposal({
    tenantId: TENANT,
    proposalType: opts.proposalType ?? 'create_booking',
    payload: { appointmentId: appointment.id },
    summary: 'AC repair — tomorrow 2pm',
    confidenceScore: 0.97,
    createdBy: 'voice',
  });
  const proposal: Proposal = await proposalRepo.create({
    ...base,
    status: opts.proposalStatus,
    ...(opts.proposalStatus === 'approved' ? { approvedAt: new Date() } : {}),
    ...(opts.proposalStatus === 'executed'
      ? { executedAt: new Date(), resultEntityId: appointment.id }
      : {}),
  });

  const sendSms = vi.fn(async (_args: unknown) => ({
    provider: 'mock',
    providerMessageId: 'SM-1',
    channel: 'sms' as const,
  }));
  // WS1 — the consent/DNC gate now lives in the delivery wrapper. In production
  // the router receives the gated messageDelivery; mirror that here so the
  // DNC/consent behavior is exercised (raw `sendSms` is the gate's base).
  const gatedDelivery = new GatedMessageDelivery({
    base: {
      sendSms,
      sendEmail: vi.fn(async () => ({ provider: 'mock', providerMessageId: 'EM-1', channel: 'email' as const })),
    } as unknown as MessageDeliveryProvider,
    dnc: { isOnDnc: vi.fn(async () => opts.onDnc ?? false) },
    auditRepo,
    enforcement: 'block',
  });
  const customerMessageDeps: CustomerMessageDeliveryDeps = {
    delivery: gatedDelivery,
    dispatchRepo: { create: vi.fn(async (r: unknown) => r) } as unknown as CustomerMessageDeliveryDeps['dispatchRepo'],
    pool: null,
    logger: createLogger({ service: 'test', environment: 'test', level: 'error' }),
  };

  const app = express();
  app.use(
    '/public/proposals',
    createOneTapUndoRouter({
      proposalRepo,
      appointmentRepo,
      auditRepo,
      secret: SECRET,
      consumeNonce: createInMemoryNonceStore(),
      jobRepo: {
        findById: async (_t: string, id: string) =>
          id === JOB_ID ? ({ id: JOB_ID, customerId: CUSTOMER_ID } as never) : null,
      } as unknown as Pick<JobRepository, 'findById'>,
      customerRepo: {
        findById: async (_t: string, id: string) => (id === CUSTOMER_ID ? customer : null),
      } as unknown as Pick<CustomerRepository, 'findById'>,
      customerMessageDeps,
    }),
  );

  return { app, proposalRepo, auditRepo, appointmentRepo, appointment, proposal, sendSms };
}

function mint(proposalId: string, ttlMs?: number, nowMs?: number) {
  return createOneTapUndoToken({
    proposalId,
    tenantId: TENANT,
    secret: SECRET,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(nowMs !== undefined ? { nowMs } : {}),
  });
}

describe('GET /public/proposals/one-tap-undo', () => {
  it('undo BEFORE execution: undoProposal path + hold released, no apology SMS', async () => {
    const { app, proposalRepo, auditRepo, appointmentRepo, appointment, proposal, sendSms } =
      await makeApp({ proposalStatus: 'approved' });
    const { token } = mint(proposal.id);

    const res = await request(app).get('/public/proposals/one-tap-undo').query({ token });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Booking undone');

    expect((await proposalRepo.findById(TENANT, proposal.id))?.status).toBe('undone');
    expect((await appointmentRepo.findById(TENANT, appointment.id))?.status).toBe('canceled');

    const types = (await auditRepo.findByEntity(TENANT, 'proposal', proposal.id)).map(
      (e) => e.eventType,
    );
    expect(types).toContain('proposal.undone');
    expect(types).toContain('autonomous_booking_undone');
    // The customer never got a confirmation — no apology either.
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('undo AFTER execution: compensating cancel + fixed-template apology SMS + audit', async () => {
    const { app, auditRepo, appointmentRepo, appointment, proposal, sendSms } = await makeApp({
      proposalStatus: 'executed',
    });
    const { token } = mint(proposal.id);

    const res = await request(app).get('/public/proposals/one-tap-undo').query({ token });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Booking undone');

    expect((await appointmentRepo.findById(TENANT, appointment.id))?.status).toBe('canceled');

    expect(sendSms).toHaveBeenCalledTimes(1);
    const smsArgs = sendSms.mock.calls[0][0] as { to: string; body: string };
    expect(smsArgs.to).toBe('+15125550111');
    expect(smsArgs.body).toBe(AUTONOMOUS_UNDO_APOLOGY_SMS);

    const events = await auditRepo.findByEntity(TENANT, 'proposal', proposal.id);
    const undone = events.find((e) => e.eventType === 'autonomous_booking_undone');
    expect(undone?.metadata).toMatchObject({
      phase: 'post_execution_compensated',
      appointmentId: appointment.id,
    });
  });

  it('double-tap is idempotent: second tap returns success without double-cancelling or re-texting', async () => {
    const { app, appointmentRepo, appointment, proposal, sendSms } = await makeApp({
      proposalStatus: 'executed',
    });
    const { token } = mint(proposal.id);

    const first = await request(app).get('/public/proposals/one-tap-undo').query({ token });
    expect(first.status).toBe(200);

    const second = await request(app).get('/public/proposals/one-tap-undo').query({ token });
    expect(second.status).toBe(200);
    expect(second.text).toContain('Already undone');

    expect((await appointmentRepo.findById(TENANT, appointment.id))?.status).toBe('canceled');
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it('DNC-listed customer: cancel still happens, no apology SMS goes out', async () => {
    const { app, appointmentRepo, appointment, proposal, sendSms } = await makeApp({
      proposalStatus: 'executed',
      onDnc: true,
    });
    const { token } = mint(proposal.id);

    const res = await request(app).get('/public/proposals/one-tap-undo').query({ token });
    expect(res.status).toBe(200);
    expect((await appointmentRepo.findById(TENANT, appointment.id))?.status).toBe('canceled');
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('rejects an expired token with 410 and changes nothing', async () => {
    const { app, appointmentRepo, appointment, proposal } = await makeApp({
      proposalStatus: 'executed',
    });
    const { token } = mint(proposal.id, 1000, Date.now() - 5000);

    const res = await request(app).get('/public/proposals/one-tap-undo').query({ token });
    expect(res.status).toBe(410);
    expect((await appointmentRepo.findById(TENANT, appointment.id))?.status).not.toBe('canceled');
  });

  it('rejects a tampered token with 401', async () => {
    const { app, proposal } = await makeApp({ proposalStatus: 'executed' });
    const { token } = mint(proposal.id);
    const res = await request(app)
      .get('/public/proposals/one-tap-undo')
      .query({ token: `${token}x` });
    expect(res.status).toBe(401);
  });

  it('refuses a forged token bound to a NON-booking proposal type (403 + audit)', async () => {
    const { app, auditRepo, proposal } = await makeApp({
      proposalStatus: 'executed',
      proposalType: 'add_note',
    });
    const { token } = mint(proposal.id);

    const res = await request(app).get('/public/proposals/one-tap-undo').query({ token });
    expect(res.status).toBe(403);
    const types = (await auditRepo.findByEntity(TENANT, 'proposal', proposal.id)).map(
      (e) => e.eventType,
    );
    expect(types).toContain('proposal.one_tap_undo_blocked_type');
  });

  it('returns 409 for a proposal that never went live (ready_for_review)', async () => {
    const { app, proposal } = await makeApp({ proposalStatus: 'ready_for_review' });
    const { token } = mint(proposal.id);
    const res = await request(app).get('/public/proposals/one-tap-undo').query({ token });
    expect(res.status).toBe(409);
    expect(res.text).toContain('Nothing to undo');
  });

  it('answers 503 when no secret is configured', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const app = express();
    app.use(
      '/public/proposals',
      createOneTapUndoRouter({
        proposalRepo,
        appointmentRepo: new InMemoryAppointmentRepository(),
        auditRepo: new InMemoryAuditRepository(),
        consumeNonce: createInMemoryNonceStore(),
      }),
    );
    const res = await request(app).get('/public/proposals/one-tap-undo').query({ token: 'x.y' });
    expect(res.status).toBe(503);
  });
});
