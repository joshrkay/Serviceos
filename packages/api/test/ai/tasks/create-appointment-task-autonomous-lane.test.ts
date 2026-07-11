/**
 * UB-D / D-015 (D2) — autonomous booking lane in the held-slot
 * create_appointment task.
 *
 * With lane inputs on the TaskContext, the held-slot path evaluates every
 * gate against the REAL hold values, stamps BOTH outcomes on
 * sourceContext.autonomousLaneEvaluation, and threads the evaluation into
 * createProposal ONLY when eligible — so an eligible unsupervised booking
 * mints 'approved' while every ineligible case keeps the pre-lane
 * unsupervised behavior ('ready_for_review').
 */
import { describe, it, expect, vi } from 'vitest';
import { CreateAppointmentAITaskHandler } from '../../../src/ai/tasks/create-appointment-task';
import { InMemoryAppointmentRepository } from '../../../src/appointments/in-memory-appointment';
import type { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { autonomousLaneEvaluationFor } from '../../../src/proposals/autonomous-lane';

const TENANT = '00000000-0000-4000-8000-00000000000a';
const JOB_ID = '00000000-0000-4000-8000-000000000abc';
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';

// Monday 2026-06-01 noon UTC = 08:00 EDT.
const NOW = new Date('2026-06-01T12:00:00.000Z');
const TZ = 'America/New_York';

function mockGateway(json: Record<string, unknown>): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: JSON.stringify(json),
      model: 'mock-model',
      provider: 'mock',
      tokenUsage: { input: 10, output: 10, total: 20 },
      latencyMs: 1,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

function bookingJson(confidence = 0.97): Record<string, unknown> {
  return {
    dateTimePhrase: 'tomorrow at 2pm',
    jobId: JOB_ID,
    summary: 'AC repair',
    confidence_score: confidence,
  };
}

function laneContext(
  overrides: Partial<TaskContext> = {},
  lane: Partial<NonNullable<TaskContext['autonomousBooking']>> = {},
): TaskContext {
  return {
    tenantId: TENANT,
    userId: 'agent-1',
    message: 'Book the Johnson AC repair tomorrow at 2pm',
    timezone: TZ,
    now: NOW,
    customerId: CUSTOMER_ID,
    // Unsupervised — the exact situation the lane exists for.
    supervisorPresent: false,
    autonomousBooking: {
      settings: { enabled: true, threshold: 0.95 },
      inboundReceptionistSource: true,
      pendingReferenceCount: 0,
      ...lane,
    },
    ...overrides,
  } as TaskContext;
}

function handlerWith(gateway: LLMGateway) {
  // No jobRepo: the legacy held path (no ownership pre-check) keeps the
  // fixture focused on the lane gates themselves.
  return new CreateAppointmentAITaskHandler(
    gateway,
    undefined,
    undefined,
    new InMemoryAppointmentRepository(),
  );
}

describe('create-appointment task — autonomous booking lane (UB-D)', () => {
  it('lane-eligible: mints an APPROVED create_booking with the eligible stamp', async () => {
    const result = await handlerWith(mockGateway(bookingJson(0.97))).handle(laneContext());

    expect(result.taskType).toBe('create_booking');
    expect(result.proposal.proposalType).toBe('create_booking');
    // Unsupervised, but every lane gate passed → auto-approved.
    expect(result.proposal.status).toBe('approved');
    expect(autonomousLaneEvaluationFor(result.proposal)).toEqual({
      eligible: true,
      threshold: 0.95,
    });
  });

  it('tenant not opted in: normal unsupervised behavior + ineligible stamp', async () => {
    const result = await handlerWith(mockGateway(bookingJson(0.97))).handle(
      laneContext({}, { settings: { enabled: false, threshold: 0.95 } }),
    );

    expect(result.proposal.status).toBe('ready_for_review');
    expect(autonomousLaneEvaluationFor(result.proposal)).toEqual({
      eligible: false,
      reason: 'tenant_not_opted_in',
    });
  });

  it('no verified customer: ineligible (no_verified_customer)', async () => {
    const result = await handlerWith(mockGateway(bookingJson(0.97))).handle(
      laneContext({ customerId: undefined }),
    );

    expect(result.proposal.status).toBe('ready_for_review');
    expect(autonomousLaneEvaluationFor(result.proposal)).toEqual({
      eligible: false,
      reason: 'no_verified_customer',
    });
  });

  it('pending free-text references: ineligible (pending_references)', async () => {
    const result = await handlerWith(mockGateway(bookingJson(0.97))).handle(
      laneContext({}, { pendingReferenceCount: 2 }),
    );

    expect(result.proposal.status).toBe('ready_for_review');
    expect(autonomousLaneEvaluationFor(result.proposal)).toEqual({
      eligible: false,
      reason: 'pending_references',
    });
  });

  it('below the lane threshold: ineligible (below_threshold)', async () => {
    const result = await handlerWith(mockGateway(bookingJson(0.9))).handle(laneContext());

    expect(result.proposal.status).toBe('ready_for_review');
    expect(autonomousLaneEvaluationFor(result.proposal)).toEqual({
      eligible: false,
      reason: 'below_threshold',
    });
  });

  it('not an inbound receptionist source (owner memo): ineligible', async () => {
    const result = await handlerWith(mockGateway(bookingJson(0.97))).handle(
      laneContext({}, { inboundReceptionistSource: false }),
    );

    expect(result.proposal.status).toBe('ready_for_review');
    expect(autonomousLaneEvaluationFor(result.proposal)).toEqual({
      eligible: false,
      reason: 'not_inbound_receptionist',
    });
  });

  it('no lane inputs on the context: no stamp, behavior unchanged', async () => {
    const result = await handlerWith(mockGateway(bookingJson(0.97))).handle(
      laneContext({ autonomousBooking: undefined }),
    );

    expect(result.proposal.status).toBe('ready_for_review');
    expect(autonomousLaneEvaluationFor(result.proposal)).toBeUndefined();
  });

  it('slot outside configured business hours: ineligible (outside_business_hours)', async () => {
    // Tue 2pm EDT slot vs a Mon–Fri 08:00–12:00 schedule → outside.
    const result = await handlerWith(mockGateway(bookingJson(0.97))).handle(
      laneContext({
        businessHours: {
          mon: { open: '08:00', close: '12:00' },
          tue: { open: '08:00', close: '12:00' },
          wed: { open: '08:00', close: '12:00' },
          thu: { open: '08:00', close: '12:00' },
          fri: { open: '08:00', close: '12:00' },
        },
      }),
    );

    expect(result.proposal.status).toBe('ready_for_review');
    expect(autonomousLaneEvaluationFor(result.proposal)).toEqual({
      eligible: false,
      reason: 'outside_business_hours',
    });
  });

  it('no configured business hours fails OPEN (still eligible, per D-015)', async () => {
    const result = await handlerWith(mockGateway(bookingJson(0.97))).handle(
      laneContext({ businessHours: undefined }),
    );
    expect(result.proposal.status).toBe('approved');
  });

  it('D-015 amendment — platform kill switch: platform_disabled even though the tenant is opted in and every other gate passes', async () => {
    const result = await handlerWith(mockGateway(bookingJson(0.97))).handle(
      laneContext({}, { platformDisabled: true }),
    );

    expect(result.proposal.status).toBe('ready_for_review');
    expect(autonomousLaneEvaluationFor(result.proposal)).toEqual({
      eligible: false,
      reason: 'platform_disabled',
    });
  });

  it('platform kill switch is checked BEFORE tenant opt-in: disabled + not-opted-in → platform_disabled', async () => {
    const result = await handlerWith(mockGateway(bookingJson(0.97))).handle(
      laneContext({}, { platformDisabled: true, settings: { enabled: false, threshold: 0.95 } }),
    );

    expect(autonomousLaneEvaluationFor(result.proposal)).toEqual({
      eligible: false,
      reason: 'platform_disabled',
    });
  });
});
