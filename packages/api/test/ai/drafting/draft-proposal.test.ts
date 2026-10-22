/**
 * D-045 point 8 — one drafting entry point, three outcomes, and the same
 * checks whatever surface drafts.
 */
import { describe, it, expect } from 'vitest';
import { draftProposal, NOT_DRAFTED_REASON } from '../../../src/ai/drafting/draft-proposal';
import { createProposal, type Proposal } from '../../../src/proposals/proposal';
import type { TaskContext, TaskHandler, TaskResult } from '../../../src/ai/tasks/task-handlers';

const JOB = '0b6f3c1e-2d4a-4c8b-9e7f-1a2b3c4d5e6f';
const MADE_UP = '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const CONTEXT: TaskContext = { tenantId: 't-1', userId: 'u-1', message: 'mark the job urgent' };

function handlerReturning(payload: Record<string, unknown> | undefined, proposalType = 'update_job'): TaskHandler {
  return {
    taskType: proposalType,
    handle: async (): Promise<TaskResult> =>
      ({
        proposal: payload
          ? createProposal({
              tenantId: 't-1',
              proposalType: proposalType as Proposal['proposalType'],
              payload,
              summary: 'Update the job',
              createdBy: 'u-1',
            })
          : undefined,
        taskType: proposalType,
      }) as unknown as TaskResult,
  } as TaskHandler;
}

describe('draftProposal', () => {
  it('returns a proposal when the draft is complete and its ids were said or verified', async () => {
    const outcome = await draftProposal({
      handler: handlerReturning({ jobId: JOB, priority: 'urgent' }),
      context: CONTEXT,
      operatorText: 'mark the job urgent',
      entities: {},
      verifiedIds: { jobId: JOB },
      classifierAiRunId: 'run-classify',
    });

    expect(outcome.kind).toBe('proposal');
    if (outcome.kind !== 'proposal') return;
    expect(outcome.proposal.payload.jobId).toBe(JOB);
    expect(outcome.proposal.sourceContext).toMatchObject({
      verifiedIds: { jobId: JOB },
      classifierAiRunId: 'run-classify',
    });
  });

  it('scrubs an id the drafting model made up and asks for it instead', async () => {
    const outcome = await draftProposal({
      handler: handlerReturning({ jobId: MADE_UP, priority: 'urgent' }),
      context: CONTEXT,
      operatorText: 'mark the job urgent',
      entities: {},
    });

    expect(outcome.kind).toBe('clarification');
    if (outcome.kind !== 'clarification') return;
    expect(outcome.proposal.payload.jobId).toBeUndefined();
    expect(outcome.missingFields).toContain('jobId');
  });

  it('keeps an id the operator said, and one in the classifier entities', async () => {
    const said = await draftProposal({
      handler: handlerReturning({ jobId: JOB, priority: 'urgent' }),
      context: CONTEXT,
      operatorText: `mark job ${JOB} urgent`,
      entities: {},
    });
    const extracted = await draftProposal({
      handler: handlerReturning({ jobId: JOB, priority: 'urgent' }),
      context: CONTEXT,
      operatorText: 'mark it urgent',
      entities: { jobId: JOB },
    });

    expect(said.kind).toBe('proposal');
    expect(extracted.kind).toBe('proposal');
  });

  it('fills a verified id the drafting model left out, and lifts its gate', async () => {
    const outcome = await draftProposal({
      handler: handlerReturning({ priority: 'urgent' }),
      context: CONTEXT,
      operatorText: 'mark the job urgent',
      entities: {},
      verifiedIds: { jobId: JOB },
    });

    expect(outcome.kind).toBe('proposal');
    if (outcome.kind !== 'proposal') return;
    expect(outcome.proposal.payload.jobId).toBe(JOB);
  });

  it('a verified id takes the place of one the drafting model made up', async () => {
    const outcome = await draftProposal({
      handler: handlerReturning({ jobId: MADE_UP, priority: 'urgent' }),
      context: CONTEXT,
      operatorText: 'mark the job urgent',
      entities: {},
      verifiedIds: { jobId: JOB },
    });

    expect(outcome.kind).toBe('proposal');
    if (outcome.kind !== 'proposal') return;
    expect(outcome.proposal.payload.jobId).toBe(JOB);
  });

  it('a verified id never overwrites one the handler resolved for itself', async () => {
    const outcome = await draftProposal({
      handler: handlerReturning({ jobId: JOB, priority: 'urgent' }),
      context: CONTEXT,
      operatorText: `job ${JOB}`,
      entities: {},
      verifiedIds: { jobId: MADE_UP },
    });

    if (outcome.kind === 'refusal') throw new Error('expected a draft');
    expect(outcome.proposal.payload.jobId).toBe(JOB);
  });

  it('gates a payload that fails its own contract, and never leaves it approved', async () => {
    const outcome = await draftProposal({
      handler: handlerReturning({ jobId: JOB }),
      context: CONTEXT,
      operatorText: `job ${JOB}`,
      entities: {},
    });

    expect(outcome.kind).toBe('clarification');
    if (outcome.kind !== 'clarification') return;
    expect(outcome.missingFields).toEqual(['status']);
    expect(outcome.proposal.status).not.toBe('approved');
  });

  it('a draft the handler auto-approved and the gate pulls back loses its approval time too', async () => {
    const handler = handlerReturning({ jobId: JOB });
    const approving: TaskHandler = {
      ...handler,
      handle: async (ctx) => {
        const result = await handler.handle(ctx);
        Object.assign(result.proposal, { status: 'approved', approvedAt: new Date() });
        return result;
      },
    };

    const outcome = await draftProposal({ handler: approving, context: CONTEXT, operatorText: `job ${JOB}`, entities: {} });

    if (outcome.kind === 'refusal') throw new Error('expected a draft');
    expect(outcome.proposal.status).toBe('draft');
    expect(outcome.proposal.approvedAt).toBeUndefined();
  });

  it('a verified id replaces a value that is not an id at all, such as a job title', async () => {
    for (const notAnId of ['Water heater install', ` ${JOB} `]) {
      const outcome = await draftProposal({
        handler: handlerReturning({ jobId: notAnId, priority: 'urgent' }),
        context: CONTEXT,
        operatorText: `the Water heater install job ${JOB}`,
        entities: {},
        verifiedIds: { jobId: JOB },
      });

      expect(outcome.kind).toBe('proposal');
      if (outcome.kind !== 'proposal') return;
      expect(outcome.proposal.payload.jobId).toBe(JOB);
    }
  });

  it('scrubs a made-up linked job so a booking still has to name who it is for', async () => {
    const outcome = await draftProposal({
      handler: handlerReturning(
        { linkedJobId: MADE_UP, scheduledStart: '2026-11-03T14:00:00.000Z', scheduledEnd: '2026-11-03T15:00:00.000Z' },
        'create_appointment',
      ),
      context: CONTEXT,
      operatorText: 'book it for Tuesday at 2',
      entities: {},
    });

    expect(outcome.kind).toBe('clarification');
    if (outcome.kind !== 'clarification') return;
    expect(outcome.proposal.payload.linkedJobId).toBeUndefined();
    expect(outcome.missingFields).toContain('customerId');
  });

  it('a clarification is never left approved, even when the gate added nothing new', async () => {
    const handler = handlerReturning({ priority: 'urgent' });
    const approving: TaskHandler = {
      ...handler,
      handle: async (ctx) => {
        const result = await handler.handle(ctx);
        Object.assign(result.proposal, {
          status: 'approved',
          approvedAt: new Date(),
          sourceContext: { missingFields: ['jobId'] },
        });
        return result;
      },
    };

    const outcome = await draftProposal({ handler: approving, context: CONTEXT, operatorText: 'urgent', entities: {} });

    expect(outcome.kind).toBe('clarification');
    if (outcome.kind === 'refusal') return;
    expect(outcome.proposal.status).toBe('draft');
    expect(outcome.proposal.approvedAt).toBeUndefined();
  });

  it('refuses with a reason when the handler drafts nothing', async () => {
    const outcome = await draftProposal({
      handler: handlerReturning(undefined),
      context: CONTEXT,
      operatorText: 'mark the job urgent',
      entities: {},
    });

    expect(outcome).toEqual({ kind: 'refusal', code: 'not_drafted', reason: NOT_DRAFTED_REASON });
  });

  it("refuses with the surface's reason when its rule leaves nothing to do, before the gate runs", async () => {
    const outcome = await draftProposal({
      handler: handlerReturning({ jobId: JOB, status: 'completed' }),
      context: CONTEXT,
      operatorText: `job ${JOB}`,
      entities: {},
      beforeGate: (p) => {
        delete p.payload.status;
        return 'The status buttons set it.';
      },
    });

    expect(outcome).toEqual({ kind: 'refusal', code: 'nothing_left', reason: 'The status buttons set it.' });
  });

  it("a surface rule that returns nothing keeps the draft, and the gate sees the rule's change", async () => {
    const outcome = await draftProposal({
      handler: handlerReturning({ jobId: JOB, status: 'completed', priority: 'urgent' }),
      context: CONTEXT,
      operatorText: `job ${JOB}`,
      entities: {},
      beforeGate: (p) => {
        delete p.payload.status;
        return undefined;
      },
    });

    expect(outcome.kind).toBe('proposal');
    if (outcome.kind !== 'proposal') return;
    expect(outcome.proposal.payload).toEqual({ jobId: JOB, priority: 'urgent' });
  });

  it("reports the estimate agent's own clarification as a clarification", async () => {
    const outcome = await draftProposal({
      handler: handlerReturning(
        { lineItems: [], clarification: { needed: true, question: 'Which unit?' } },
        'draft_estimate',
      ),
      context: CONTEXT,
      operatorText: 'quote a water heater',
      entities: {},
    });

    expect(outcome.kind).toBe('clarification');
  });
});
