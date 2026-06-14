/**
 * U8 — send_estimate_nudge voice on-ramp (task-handler level).
 *
 * The SendEstimateNudgeExecutionHandler already exists (48h-cooldown re-send of
 * an already-sent estimate). This proves the front half mirrors send_estimate:
 * carry a free-text estimateReference and flag estimateId missing so the review
 * UI resolves it before this comms-class proposal (never auto-approved) sends.
 */
import { describe, it, expect } from 'vitest';
import { SendEstimateNudgeTaskHandler } from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor } from '../../../src/proposals/proposal';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return { tenantId: 't-1', userId: 'u-1', message: 'test transcript', ...overrides };
}

describe('SendEstimateNudgeTaskHandler', () => {
  it('carries the estimate reference and stays in draft (comms never auto-approves)', async () => {
    const res = await new SendEstimateNudgeTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Khan estimate' } }),
    );
    expect(res.proposal.proposalType).toBe('send_estimate_nudge');
    expect(res.proposal.payload.estimateReference).toBe('the Khan estimate');
    expect(missingFieldsFor(res.proposal)).not.toContain('estimateId');
    expect(res.proposal.status).toBe('draft');
  });

  it('flags estimateId missing when no reference was extracted', async () => {
    const res = await new SendEstimateNudgeTaskHandler().handle(ctx({ existingEntities: {} }));
    expect(missingFieldsFor(res.proposal)).toContain('estimateId');
  });

  it('falls back to customerName as the estimate reference', async () => {
    const res = await new SendEstimateNudgeTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Sarah' } }),
    );
    expect(res.proposal.payload.estimateReference).toBe('Sarah');
  });
});
