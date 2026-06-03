/**
 * CreateAppointmentAITaskHandler conflict-path tests (P0-035).
 *
 * When the SlotConflictChecker reports a conflict, the task swaps the
 * `create_appointment` proposal for a `voice_clarification` so the
 * dispatcher is asked to pick another time / technician.
 *
 * Times are resolved deterministically from the verbatim phrase against a
 * fixed `now` + tenant timezone (threaded on the context), so the proposed
 * window — and the alternative-slot search window — are stable.
 */
import { describe, it, expect, vi } from 'vitest';
import { CreateAppointmentAITaskHandler } from '../../../src/ai/tasks/create-appointment-task';
import {
  SlotConflictChecker,
  SlotConflictResult,
} from '../../../src/ai/tasks/slot-conflict-checker';
import { LLMGateway, LLMResponse } from '../../../src/ai/gateway/gateway';
import type { FindOpenSlotsInput } from '../../../src/ai/tasks/availability-finder';

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

// Fixed anchor: Mon 2026-06-01 noon UTC. "tomorrow at 11am" in NY (EDT)
// == 2026-06-02T15:00:00.000Z. June keeps NY on EDT (UTC-4).
const NOW = new Date('2026-06-01T12:00:00.000Z');
const TZ = 'America/New_York';
const RESOLVED_START = '2026-06-02T15:00:00.000Z';

function ctx(message: string, extra: Record<string, unknown> = {}) {
  return { tenantId, userId, message, timezone: TZ, now: NOW, ...extra };
}

describe('CreateAppointmentAITaskHandler P0-035 slot-conflict pre-check', () => {
  const baseLlmJson = JSON.stringify({
    customerId,
    technicianId,
    dateTimePhrase: 'tomorrow at 11am',
    summary: 'Follow-up visit',
    confidence_score: 0.92,
  });

  it('happy path — non-conflicting slot still produces a create_appointment proposal', async () => {
    const checker = stubChecker({ ok: true });
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson), checker);

    const result = await handler.handle(ctx('Schedule a follow-up with Mrs Lee tomorrow at 11am'));

    expect(result.taskType).toBe('create_appointment');
    expect(result.proposal.proposalType).toBe('create_appointment');
    expect(checker.check).toHaveBeenCalledTimes(1);
  });

  it('technician busy — overlapping appointment for same tech produces voice_clarification', async () => {
    const conflictWindow = {
      start: new Date('2026-06-02T14:30:00Z'),
      end: new Date('2026-06-02T15:30:00Z'),
    };
    const checker = stubChecker({
      ok: false,
      conflict: 'technician_busy',
      appointmentId: 'appt-existing',
      conflictWindow,
    });
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson), checker);

    const result = await handler.handle(ctx('Schedule a follow-up tomorrow at 11am'));

    expect(result.taskType).toBe('voice_clarification');
    expect(result.proposal.proposalType).toBe('voice_clarification');
    // The conflicting appointment id must be surfaced for context.
    const c = result.proposal.sourceContext as Record<string, unknown>;
    expect(JSON.stringify(c)).toContain('appt-existing');
    expect(result.proposal.summary).toContain('appt-existing');
  });

  it('customer busy — overlapping appointment for same customer (different tech) produces voice_clarification', async () => {
    const conflictWindow = {
      start: new Date('2026-06-02T15:30:00Z'),
      end: new Date('2026-06-02T16:30:00Z'),
    };
    const checker = stubChecker({
      ok: false,
      conflict: 'customer_busy',
      appointmentId: 'appt-existing-cust',
      conflictWindow,
    });
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson), checker);

    const result = await handler.handle(ctx('Schedule a follow-up tomorrow at 11am'));

    expect(result.taskType).toBe('voice_clarification');
    const c = result.proposal.sourceContext as Record<string, unknown>;
    expect(JSON.stringify(c)).toContain('appt-existing-cust');
    expect(JSON.stringify(c)).toContain('customer_busy');
  });

  it('repo error — surfaces a voice_clarification with "could not verify" message rather than crashing', async () => {
    const checker = stubChecker({
      ok: false,
      conflict: 'could_not_verify',
      reason: 'database unreachable',
    });
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson), checker);

    const result = await handler.handle(ctx('Schedule a follow-up tomorrow at 11am'));

    expect(result.taskType).toBe('voice_clarification');
    expect(result.proposal.proposalType).toBe('voice_clarification');
    expect(result.proposal.summary.toLowerCase()).toContain('could not verify');
  });

  it('unassigned tech — checker is called without technicianId', async () => {
    const llmJson = JSON.stringify({
      customerId,
      // technicianId deliberately omitted
      dateTimePhrase: 'tomorrow at 11am',
      confidence_score: 0.9,
    });
    const checker = stubChecker({ ok: true });
    const handler = new CreateAppointmentAITaskHandler(mockGateway(llmJson), checker);

    await handler.handle(ctx('Schedule something tomorrow at 11am'));

    const call = (checker.check as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.technicianId).toBeUndefined();
    expect(call.customerId).toBe(customerId);
  });

  it('skips the conflict check when no checker is wired (backward compatible)', async () => {
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson));
    const result = await handler.handle(ctx('Schedule something tomorrow at 11am'));
    expect(result.taskType).toBe('create_appointment');
  });

  it('attaches alternative slots to voice_clarification when AvailabilityFinder is wired', async () => {
    const conflictWindow = {
      start: new Date('2026-06-02T15:00:00Z'),
      end: new Date('2026-06-02T16:00:00Z'),
    };
    const checker = stubChecker({
      ok: false,
      conflict: 'technician_busy',
      appointmentId: 'appt-existing',
      conflictWindow,
    });
    const altSlot = {
      start: new Date('2026-06-02T17:00:00Z'),
      end: new Date('2026-06-02T18:00:00Z'),
    };
    const finder = {
      find: vi.fn(async (_input: FindOpenSlotsInput) => ({ ok: true as const, slots: [altSlot] })),
    };
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson), checker, finder);

    const result = await handler.handle(ctx('Schedule a follow-up tomorrow at 11am'));

    expect(result.taskType).toBe('voice_clarification');
    const c = result.proposal.sourceContext as Record<string, unknown>;
    expect(c.alternatives).toEqual([
      { start: altSlot.start.toISOString(), end: altSlot.end.toISOString() },
    ]);
    expect(result.proposal.explanation ?? '').toContain('Suggested alternative slot');
    // Finder was called with the conflicted slot's duration + resolved start.
    const findCall = finder.find.mock.calls[0][0];
    expect(findCall.durationMs).toBe(60 * 60 * 1000);
    expect(findCall.searchFrom.toISOString()).toBe(RESOLVED_START);
    expect(findCall.technicianId).toBe(technicianId);
  });

  it('falls back to no-alternatives wording when AvailabilityFinder reports unavailable', async () => {
    const checker = stubChecker({
      ok: false,
      conflict: 'technician_busy',
      appointmentId: 'appt-existing',
      conflictWindow: {
        start: new Date('2026-06-02T15:00:00Z'),
        end: new Date('2026-06-02T16:00:00Z'),
      },
    });
    const finder = {
      find: vi.fn(async (_input: FindOpenSlotsInput) => ({ ok: false as const, reason: 'connection reset' })),
    };
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson), checker, finder);

    const result = await handler.handle(ctx('Schedule a follow-up tomorrow at 11am'));

    expect(result.taskType).toBe('voice_clarification');
    const c = result.proposal.sourceContext as Record<string, unknown>;
    expect(c.alternatives).toBeUndefined();
    expect(result.proposal.explanation ?? '').not.toContain('Suggested alternative slot');
  });

  it('drops technicianId from finder call when conflict is customer_busy', async () => {
    const checker = stubChecker({
      ok: false,
      conflict: 'customer_busy',
      appointmentId: 'appt-customer-busy',
      conflictWindow: {
        start: new Date('2026-06-02T15:00:00Z'),
        end: new Date('2026-06-02T16:00:00Z'),
      },
    });
    const finder = {
      find: vi.fn(async (_input: FindOpenSlotsInput) => ({
        ok: true as const,
        slots: [{ start: new Date('2026-06-02T17:00:00Z'), end: new Date('2026-06-02T18:00:00Z') }],
      })),
    };
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson), checker, finder);

    await handler.handle(ctx('Schedule a follow-up tomorrow at 11am'));

    const call = finder.find.mock.calls[0][0];
    expect(call.technicianId).toBeUndefined();
  });

  it('drops technicianId from finder call when conflict is could_not_verify', async () => {
    const checker = stubChecker({
      ok: false,
      conflict: 'could_not_verify',
      reason: 'database unreachable',
    });
    const finder = {
      find: vi.fn(async (_input: FindOpenSlotsInput) => ({ ok: true as const, slots: [] })),
    };
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson), checker, finder);

    await handler.handle(ctx('Schedule a follow-up tomorrow at 11am'));

    const call = finder.find.mock.calls[0][0];
    expect(call.technicianId).toBeUndefined();
  });

  it('keeps technicianId when conflict is technician_busy (regression guard)', async () => {
    const checker = stubChecker({
      ok: false,
      conflict: 'technician_busy',
      appointmentId: 'appt-tech-busy',
      conflictWindow: {
        start: new Date('2026-06-02T15:00:00Z'),
        end: new Date('2026-06-02T16:00:00Z'),
      },
    });
    const finder = {
      find: vi.fn(async (_input: FindOpenSlotsInput) => ({ ok: true as const, slots: [] })),
    };
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson), checker, finder);

    await handler.handle(ctx('Schedule a follow-up tomorrow at 11am'));

    const call = finder.find.mock.calls[0][0];
    expect(call.technicianId).toBe(technicianId);
  });

  it('omits alternatives when finder returns an empty slot list', async () => {
    const checker = stubChecker({
      ok: false,
      conflict: 'technician_busy',
      appointmentId: 'appt-existing',
      conflictWindow: {
        start: new Date('2026-06-02T15:00:00Z'),
        end: new Date('2026-06-02T16:00:00Z'),
      },
    });
    const finder = {
      find: vi.fn(async (_input: FindOpenSlotsInput) => ({ ok: true as const, slots: [] })),
    };
    const handler = new CreateAppointmentAITaskHandler(mockGateway(baseLlmJson), checker, finder);

    const result = await handler.handle(ctx('Schedule a follow-up tomorrow at 11am'));

    const c = result.proposal.sourceContext as Record<string, unknown>;
    expect(c.alternatives).toBeUndefined();
  });

  it('skips the conflict check when payload is missing customerId', async () => {
    // The LLM didn't surface a customerId — we can't run the customer
    // overlap check, so the original path runs and the dispatcher
    // catches the issue at review time.
    const llmJson = JSON.stringify({
      dateTimePhrase: 'tomorrow at 11am',
      confidence_score: 0.9,
    });
    const checker = stubChecker({
      ok: false,
      conflict: 'technician_busy',
      appointmentId: 'appt-x',
      conflictWindow: { start: new Date(), end: new Date() },
    });
    const handler = new CreateAppointmentAITaskHandler(mockGateway(llmJson), checker);
    const result = await handler.handle(ctx('Schedule something tomorrow at 11am'));
    expect(checker.check).not.toHaveBeenCalled();
    expect(result.taskType).toBe('create_appointment');
  });
});
