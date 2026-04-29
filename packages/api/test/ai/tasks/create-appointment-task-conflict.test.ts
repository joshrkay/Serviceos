/**
 * CreateAppointmentAITaskHandler conflict-path tests (P0-035).
 *
 * The original tests live in `test/ai/tasks/create-appointment-task.test.ts`
 * and cover the pre-P0-035 happy paths (transcript → ISO datetime →
 * create_appointment proposal). This file adds the slot-conflict
 * tests described in P0-035: when the SlotConflictChecker reports a
 * conflict, the task swaps the `create_appointment` proposal for a
 * `voice_clarification` proposal so the dispatcher is asked to pick
 * another time / technician.
 */
import { describe, it, expect, vi } from 'vitest';
import { CreateAppointmentAITaskHandler } from '../../../src/ai/tasks/create-appointment-task';
import {
  SlotConflictChecker,
  SlotConflictResult,
} from '../../../src/ai/tasks/slot-conflict-checker';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';

function mockGateway(jsonContent: string): LLMGateway {
  return {
    complete: vi.fn(async () => ({
      content: jsonContent,
      model: 'mock-model',
      provider: 'mock',
      tokenUsage: { input: 120, output: 80, total: 200 },
      latencyMs: 55,
    } satisfies LLMResponse)),
  } as unknown as LLMGateway;
}

function stubChecker(result: SlotConflictResult): SlotConflictChecker {
  return { check: vi.fn(async () => result) };
}

const tenantId = 'tenant-1';
const userId = 'user-1';
const customerId = '11111111-1111-1111-1111-111111111111';
const technicianId = '22222222-2222-2222-2222-222222222222';

describe('CreateAppointmentAITaskHandler P0-035 slot-conflict pre-check', () => {
  const baseLlmJson = JSON.stringify({
    customerId,
    technicianId,
    scheduledStart: '2026-04-21T11:00:00Z',
    scheduledEnd: '2026-04-21T12:00:00Z',
    summary: 'Follow-up visit',
    confidence_score: 0.92,
  });

  it('happy path — non-conflicting slot still produces a create_appointment proposal', async () => {
    const checker = stubChecker({ ok: true });
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson), checker);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Schedule a follow-up with Mrs Lee at 11am',
    });

    expect(result.taskType).toBe('create_appointment');
    expect(result.proposal.proposalType).toBe('create_appointment');
    expect(checker.check).toHaveBeenCalledTimes(1);
  });

  it('technician busy — overlapping appointment for same tech produces voice_clarification', async () => {
    const conflictWindow = {
      start: new Date('2026-04-21T10:30:00Z'),
      end: new Date('2026-04-21T11:30:00Z'),
    };
    const checker = stubChecker({
      ok: false,
      conflict: 'technician_busy',
      appointmentId: 'appt-existing',
      conflictWindow,
    });
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson), checker);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Schedule a follow-up at 11am',
    });

    expect(result.taskType).toBe('voice_clarification');
    expect(result.proposal.proposalType).toBe('voice_clarification');
    // The conflicting appointment id must be surfaced for context.
    const ctx = result.proposal.sourceContext as Record<string, unknown>;
    expect(JSON.stringify(ctx)).toContain('appt-existing');
    expect(result.proposal.summary).toContain('appt-existing');
  });

  it('customer busy — overlapping appointment for same customer (different tech) produces voice_clarification', async () => {
    const conflictWindow = {
      start: new Date('2026-04-21T11:30:00Z'),
      end: new Date('2026-04-21T12:30:00Z'),
    };
    const checker = stubChecker({
      ok: false,
      conflict: 'customer_busy',
      appointmentId: 'appt-existing-cust',
      conflictWindow,
    });
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson), checker);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Schedule a follow-up at 11am',
    });

    expect(result.taskType).toBe('voice_clarification');
    const ctx = result.proposal.sourceContext as Record<string, unknown>;
    expect(JSON.stringify(ctx)).toContain('appt-existing-cust');
    expect(JSON.stringify(ctx)).toContain('customer_busy');
  });

  it('repo error — surfaces a voice_clarification with "could not verify" message rather than crashing', async () => {
    const checker = stubChecker({
      ok: false,
      conflict: 'could_not_verify',
      reason: 'database unreachable',
    });
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson), checker);

    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Schedule a follow-up at 11am',
    });

    expect(result.taskType).toBe('voice_clarification');
    expect(result.proposal.proposalType).toBe('voice_clarification');
    expect(result.proposal.summary.toLowerCase()).toContain("could not verify");
  });

  it('unassigned tech — checker is called without technicianId', async () => {
    const llmJson = JSON.stringify({
      customerId,
      // technicianId deliberately omitted
      scheduledStart: '2026-04-21T11:00:00Z',
      scheduledEnd: '2026-04-21T12:00:00Z',
      confidence_score: 0.9,
    });
    const checker = stubChecker({ ok: true });
    const handler = new CreateAppointmentAITaskHandler(mockGateway(llmJson), checker);

    await handler.handle({
      tenantId,
      userId,
      message: 'Schedule something at 11am',
    });

    const call = (checker.check as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.technicianId).toBeUndefined();
    expect(call.customerId).toBe(customerId);
  });

  it('skips the conflict check when no checker is wired (backward compatible)', async () => {
    // No second arg → CreateAppointmentAITaskHandler runs the original
    // path. P0-035 must not break callers that haven't wired the checker.
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson));
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Schedule something',
    });
    expect(result.taskType).toBe('create_appointment');
  });

  it('skips the conflict check when payload is missing customerId / dates', async () => {
    // The LLM didn't surface a customerId — we can't run the customer
    // overlap check, so the original path runs and the dispatcher
    // catches the issue at review time.
    const llmJson = JSON.stringify({
      scheduledStart: '2026-04-21T11:00:00Z',
      scheduledEnd: '2026-04-21T12:00:00Z',
      confidence_score: 0.9,
    });
    const checker = stubChecker({
      ok: false,
      conflict: 'technician_busy',
      appointmentId: 'appt-x',
      conflictWindow: { start: new Date(), end: new Date() },
    });
    const handler = new CreateAppointmentAITaskHandler(mockGateway(llmJson), checker);
    const result = await handler.handle({
      tenantId,
      userId,
      message: 'Schedule something',
    });
    expect(checker.check).not.toHaveBeenCalled();
    expect(result.taskType).toBe('create_appointment');
  });
});
