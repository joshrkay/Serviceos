/**
 * B7.4 — dictated job notes ("Note on the Patel job — wants morning visits").
 *
 * The defect this pins: AddNoteTaskHandler used to set only the free-text
 * `targetReference` and leave `missingFields` EMPTY, so the proposal was
 * approvable straight from drafting — and then AddNoteExecutionHandler
 * (proposals/execution/voice-extended-handlers.ts:92-97) refused it because
 * `targetId` was never a UUID. The owner tapped approve and the note vanished
 * with no error. These tests hold both halves of the contract: resolve when
 * the router gave us a verified id, gate honestly when it did not.
 */
import { describe, it, expect } from 'vitest';
import { AddNoteTaskHandler } from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import {
  InMemoryProposalRepository,
  missingFieldsFor,
} from '../../../src/proposals/proposal';
import { approveProposal } from '../../../src/proposals/actions';

const JOB_ID = '3f7d6c1e-9a2b-4c5d-8e1f-0a1b2c3d4e5f';
const CUSTOMER_ID = '8c2e5a10-4b6d-4f3a-9e7c-1d2b3a4c5d6e';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return {
    tenantId: 't-1',
    userId: 'u-1',
    message: 'Note on the Patel job — wants morning visits',
    ...overrides,
  };
}

describe('AddNoteTaskHandler', () => {
  it('lands the resolver-verified jobId on the payload with nothing gated', async () => {
    const res = await new AddNoteTaskHandler().handle(
      ctx({
        existingEntities: {
          jobId: JOB_ID,
          jobReference: 'the Patel job',
          noteTargetKind: 'job',
          noteBody: 'wants morning visits',
        },
      }),
    );

    expect(res.proposal.proposalType).toBe('add_note');
    expect(res.proposal.payload.targetKind).toBe('job');
    expect(res.proposal.payload.targetId).toBe(JOB_ID);
    // The dictated text verbatim — not the whole utterance.
    expect(res.proposal.payload.body).toBe('wants morning visits');
    expect(missingFieldsFor(res.proposal)).toEqual([]);
  });

  it('resolves a customer note from the verified caller identity', async () => {
    const res = await new AddNoteTaskHandler().handle(
      ctx({
        customerId: CUSTOMER_ID,
        existingEntities: { noteTargetKind: 'customer', noteBody: 'prefers text' },
      }),
    );

    expect(res.proposal.payload.targetKind).toBe('customer');
    expect(res.proposal.payload.targetId).toBe(CUSTOMER_ID);
    expect(missingFieldsFor(res.proposal)).toEqual([]);
  });

  it('falls back to the whole utterance when no distinct body was extracted', async () => {
    const res = await new AddNoteTaskHandler().handle(
      ctx({ existingEntities: { jobId: JOB_ID, noteTargetKind: 'job' } }),
    );

    expect(res.proposal.payload.body).toBe('Note on the Patel job — wants morning visits');
  });

  describe('the honest gate', () => {
    it('gates targetId and refuses approval when only a free-text reference resolved', async () => {
      const res = await new AddNoteTaskHandler().handle(
        ctx({
          existingEntities: {
            jobReference: 'the Patel job',
            noteTargetKind: 'job',
            noteBody: 'wants morning visits',
          },
        }),
      );

      expect(missingFieldsFor(res.proposal)).toEqual(['targetId']);
      // The reference still rides along so the review card can resolve it.
      expect(res.proposal.payload.targetReference).toBe('the Patel job');
      expect(res.proposal.payload.targetId).toBeUndefined();

      // …and the approval gate actually holds (proposals/actions.ts:214-219).
      const repo = new InMemoryProposalRepository();
      await repo.create(res.proposal);
      await expect(
        approveProposal(repo, 't-1', res.proposal.id, 'u-1', 'owner'),
      ).rejects.toThrow(/unfilled required fields: targetId/);
    });

    it('gates targetId when nothing at all resolved', async () => {
      const res = await new AddNoteTaskHandler().handle(
        ctx({ existingEntities: { noteTargetKind: 'job' } }),
      );

      expect(missingFieldsFor(res.proposal)).toEqual(['targetId']);
    });

    it('gates an appointment-scoped note the note store cannot hold', async () => {
      // NOTE_ENTITY_TYPES has no 'appointment', so approving could only ever
      // fail at execution — the refusal belongs at review time.
      const res = await new AddNoteTaskHandler().handle(
        ctx({
          existingEntities: {
            appointmentId: '11111111-2222-3333-4444-555555555555',
            noteTargetKind: 'appointment',
            noteBody: 'bring the ladder',
          },
        }),
      );

      expect(missingFieldsFor(res.proposal)).toContain('targetKind');
      expect(res.proposal.status).toBe('draft');
    });

    it('ignores a non-UUID id rather than handing the executor garbage', async () => {
      const res = await new AddNoteTaskHandler().handle(
        ctx({
          existingEntities: {
            jobId: 'the Patel job',
            noteTargetKind: 'job',
            noteBody: 'wants morning visits',
          },
        }),
      );

      expect(res.proposal.payload.targetId).toBeUndefined();
      expect(missingFieldsFor(res.proposal)).toEqual(['targetId']);
    });
  });

  it('REGRESSION PIN (B7.4): the pre-fix payload shape is no longer producible', async () => {
    // The exact shape that shipped the silent data loss: a free-text
    // targetReference, no targetId, and an EMPTY missingFields. If a future
    // change reintroduces it, this fails.
    const res = await new AddNoteTaskHandler().handle(
      ctx({
        existingEntities: {
          jobReference: 'the Patel job',
          customerName: 'Patel',
          noteTargetKind: 'job',
          noteBody: 'wants morning visits',
        },
      }),
    );

    const preFixShape =
      res.proposal.payload.targetReference !== undefined &&
      res.proposal.payload.targetId === undefined &&
      missingFieldsFor(res.proposal).length === 0;

    expect(preFixShape).toBe(false);
  });
});
