/**
 * QUALITY-2026-07-12 WS2 (D-019) — the D-018 close-chain compensation was
 * REVOKED with the sanctioned autonomous close. The one-tap UNDO route is now
 * the generic D-015 booking undo only: undoing a create_booking cancels the
 * appointment (and, post-execution, sends the fixed apology) — it must NOT
 * withdraw a chained estimate or reject chained siblings, even when the booking
 * happens to carry a legacy close stamp. Owner-approved close bookings are
 * undone/canceled like any other booking (from the app or the generic link);
 * no close-specific compensation runs here anymore.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { createOneTapUndoRouter } from '../../src/routes/one-tap-undo';
import { createOneTapUndoToken } from '../../src/proposals/one-tap-undo';
import {
  InMemoryProposalRepository,
  createProposal,
  type Proposal,
} from '../../src/proposals/proposal';
import { autonomousCloseStamp } from '../../src/proposals/autonomous-close-lane';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { createAppointment } from '../../src/appointments/appointment';
import { InMemoryEstimateRepository, type Estimate } from '../../src/estimates/estimate';

const TENANT = 't-close-undo';
const JOB_ID = '00000000-0000-4000-8000-000000000abc';
const SECRET = 'test-undo-secret';

const ELIGIBLE_STAMP = autonomousCloseStamp({ eligible: true, bookingThreshold: 0.95 });

async function makeCloseChainApp() {
  const proposalRepo = new InMemoryProposalRepository();
  const auditRepo = new InMemoryAuditRepository();
  const appointmentRepo = new InMemoryAppointmentRepository();
  const estimateRepo = new InMemoryEstimateRepository();

  const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
  const appointment = await createAppointment(
    {
      tenantId: TENANT,
      jobId: JOB_ID,
      scheduledStart: inOneHour,
      scheduledEnd: new Date(inOneHour.getTime() + 60 * 60 * 1000),
      timezone: 'America/New_York',
      createdBy: 'system:autonomous-close',
      holdPendingApproval: false, // confirmed by the executed create_booking
      holdExpiryAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
    appointmentRepo,
  );

  // A SENT estimate — the removed D-018 compensation used to void it. It must
  // now stay 'sent': the generic undo never touches a chained estimate.
  const estimateId = uuidv4();
  const estimate: Estimate = {
    id: estimateId,
    tenantId: TENANT,
    jobId: JOB_ID,
    estimateNumber: 'EST-1',
    status: 'sent',
    lineItems: [
      { id: uuidv4(), description: 'Water Heater Replacement', quantity: 1, unitPriceCents: 185000, totalCents: 185000, sortOrder: 0, taxable: true },
    ],
    subtotalCents: 185000,
    taxCents: 0,
    totalCents: 185000,
    createdBy: 'system:autonomous-close',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Estimate;
  await estimateRepo.create(estimate);

  const chainId = uuidv4();
  const member = (input: {
    proposalType: Proposal['proposalType'];
    payload: Record<string, unknown>;
    chainIndex: number;
    status: Proposal['status'];
    resultEntityId?: string;
  }): Proposal => {
    const base = createProposal({
      tenantId: TENANT,
      proposalType: input.proposalType,
      payload: input.payload,
      summary: `${input.proposalType} (close)`,
      createdBy: 'system:autonomous-close',
      sourceContext: {
        chainId,
        chainIndex: input.chainIndex,
        chainLength: 3,
        dependsOnChainIndices: input.chainIndex === 0 ? [] : [input.chainIndex - 1],
        chainRefs: [],
        ...ELIGIBLE_STAMP,
      },
    });
    base.chainId = chainId;
    base.status = input.status;
    if (input.status === 'approved') base.approvedAt = new Date(Date.now() - 60_000);
    if (input.resultEntityId) base.resultEntityId = input.resultEntityId;
    return base;
  };

  await proposalRepo.create(
    member({
      proposalType: 'draft_estimate',
      payload: { lineItems: [{ description: 'Water Heater Replacement', quantity: 1, unitPrice: 185000 }] },
      chainIndex: 0,
      status: 'executed',
      resultEntityId: estimateId,
    }),
  );
  // A still-approved send sibling (the generic undo must NOT reject it — the
  // D-018-specific "reject because backdated" path is gone).
  const sendMember = await proposalRepo.create(
    member({
      proposalType: 'send_estimate',
      payload: { estimateId, channel: 'sms' },
      chainIndex: 1,
      status: 'approved',
    }),
  );
  const bookingMember = await proposalRepo.create(
    member({
      proposalType: 'create_booking',
      payload: { appointmentId: appointment.id },
      chainIndex: 2,
      status: 'executed',
      resultEntityId: appointment.id,
    }),
  );

  const app = express();
  app.use(
    '/public/proposals',
    createOneTapUndoRouter({
      proposalRepo,
      appointmentRepo,
      auditRepo,
      secret: SECRET,
      consumeNonce: () => true,
    }),
  );
  return { app, proposalRepo, appointmentRepo, estimateRepo, auditRepo, appointment, estimateId, sendMember, bookingMember };
}

describe('WS2 (D-019) — one-tap UNDO no longer runs close-chain compensation', () => {
  it('cancels the booking but leaves the sent estimate + approved sibling untouched', async () => {
    const h = await makeCloseChainApp();
    const { token } = createOneTapUndoToken({
      proposalId: h.bookingMember.id,
      tenantId: TENANT,
      secret: SECRET,
    });
    const res = await request(h.app).get(`/public/proposals/one-tap-undo?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Booking undone');
    // The generic copy — never the D-018 "quote can't be recalled" line.
    expect(res.text).not.toContain('can’t be recalled');

    // Booking canceled (generic D-015 behavior).
    const appt = await h.appointmentRepo.findById(TENANT, h.appointment.id);
    expect(appt!.status).toBe('canceled');

    // The chained estimate is NOT withdrawn — the D-018 compensation is gone.
    const estimate = await h.estimateRepo.findById(TENANT, h.estimateId);
    expect(estimate!.status).toBe('sent');

    // The approved send sibling is NOT rejected — no close-chain sibling stop.
    const send = await h.proposalRepo.findById(TENANT, h.sendMember.id);
    expect(send!.status).toBe('approved');
  });

  it('a plain D-015 booking (no close stamp) still cancels with the generic copy', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const auditRepo = new InMemoryAuditRepository();
    const appointmentRepo = new InMemoryAppointmentRepository();
    const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
    const appointment = await createAppointment(
      {
        tenantId: TENANT,
        jobId: JOB_ID,
        scheduledStart: inOneHour,
        scheduledEnd: new Date(inOneHour.getTime() + 60 * 60 * 1000),
        timezone: 'America/New_York',
        createdBy: 'voice',
        holdPendingApproval: false,
      },
      appointmentRepo,
    );
    const base = createProposal({
      tenantId: TENANT,
      proposalType: 'create_booking',
      payload: { appointmentId: appointment.id },
      summary: 'plain lane booking',
      createdBy: 'voice',
    });
    base.status = 'executed';
    base.resultEntityId = appointment.id;
    const proposal = await proposalRepo.create(base);

    const app = express();
    app.use(
      '/public/proposals',
      createOneTapUndoRouter({ proposalRepo, appointmentRepo, auditRepo, secret: SECRET, consumeNonce: () => true }),
    );
    const { token } = createOneTapUndoToken({ proposalId: proposal.id, tenantId: TENANT, secret: SECRET });
    const res = await request(app).get(`/public/proposals/one-tap-undo?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('can’t be recalled');
    expect((await appointmentRepo.findById(TENANT, appointment.id))!.status).toBe('canceled');
  });
});
