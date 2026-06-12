/**
 * Unit tests for ComplaintTaskHandler (src/ai/tasks/complaint-task.ts).
 *
 * Exercises the handler in isolation (no router, no queue) using an
 * InMemoryProposalRepository. Router-level dispatch coverage lives in
 * test/workers/voice-action-router.test.ts (RV-080 suite).
 */
import { describe, it, expect } from 'vitest';
import {
  ComplaintTaskHandler,
  complaintSeverity,
  COMPLAINT_HIGH_SEVERITY_REASON,
} from '../../../src/ai/tasks/complaint-task';
import { InMemoryProposalRepository, missingFieldsFor } from '../../../src/proposals/proposal';
import type { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { assertValidProposalPayload } from '../../../src/proposals/contracts';

function makeContext(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    tenantId: 't-1',
    userId: 'op-1',
    message: 'caller reported dissatisfaction',
    ...overrides,
  };
}

describe('ComplaintTaskHandler', () => {
  it('creates a [COMPLAINT]-prefixed add_note AND a companion callback', async () => {
    const repo = new InMemoryProposalRepository();
    const handler = new ComplaintTaskHandler(repo);

    const context = makeContext({
      existingEntities: {
        customerName: 'Mrs. Patel',
        noteBody: 'the leak came back two days after the repair',
      },
      conversationId: 'conv-1',
    });

    const { proposal } = await handler.handle(context);
    // The returned proposal is the add_note.
    expect(proposal.proposalType).toBe('add_note');
    expect(proposal.payload.body).toBe('[COMPLAINT] the leak came back two days after the repair');
    expect(proposal.payload.targetKind).toBe('customer');
    expect(proposal.payload.targetReference).toBe('Mrs. Patel');
    expect(proposal.summary).toBe('Complaint from Mrs. Patel');
    expect(proposal.status).toBe('draft');
    expect(() => assertValidProposalPayload('add_note', proposal.payload)).not.toThrow();

    // The companion callback was persisted to the repo.
    const all = await repo.findByTenant('t-1');
    expect(all).toHaveLength(1);
    const callback = all[0];
    expect(callback.proposalType).toBe('callback');
    expect(callback.payload.reason).toBe('customer_complaint_followup');
    expect(callback.payload.transcript).toContain('caller reported dissatisfaction');
    expect(callback.summary).toBe('Complaint follow-up — call Mrs. Patel back');
    expect(callback.status).toBe('draft');
    expect(() => assertValidProposalPayload('callback', callback.payload)).not.toThrow();
    // No severity markers on a normal complaint.
    expect(proposal.payload._meta).toBeUndefined();
    expect(callback.payload._meta).toBeUndefined();
  });

  it('high-severity wording flags _meta.markers on BOTH proposals', async () => {
    const repo = new InMemoryProposalRepository();
    const handler = new ComplaintTaskHandler(repo);

    const { proposal: note } = await handler.handle(
      makeContext({
        message: 'I want a refund or I am calling my lawyer',
        existingEntities: { customerName: 'Mr. Jones' },
      }),
    );

    const all = await repo.findByTenant('t-1');
    const callback = all[0];

    for (const p of [note, callback]) {
      const meta = p.payload._meta as { markers?: Array<{ reason: string }> };
      expect(meta?.markers?.[0]?.reason).toBe(COMPLAINT_HIGH_SEVERITY_REASON);
      expect(() => assertValidProposalPayload(p.proposalType, p.payload)).not.toThrow();
      expect(p.status).toBe('draft');
    }
    expect(note.summary).toBe('HIGH-SEVERITY complaint from Mr. Jones');
    expect(callback.summary).toBe('HIGH-SEVERITY complaint — call Mr. Jones back');
  });

  it('verified caller-ID customerId pins the note to targetId', async () => {
    const repo = new InMemoryProposalRepository();
    const handler = new ComplaintTaskHandler(repo);

    const { proposal: note } = await handler.handle(
      makeContext({
        customerId: 'cust-verified-1',
        existingEntities: {},
      }),
    );

    expect(note.payload.targetKind).toBe('customer');
    expect(note.payload.targetId).toBe('cust-verified-1');
    expect(note.payload.targetReference).toBeUndefined();
    expect(note.payload.body).toBe('[COMPLAINT] caller reported dissatisfaction');
  });

  it('no resolvable target → note is draft with targetId in missingFields', async () => {
    const repo = new InMemoryProposalRepository();
    const handler = new ComplaintTaskHandler(repo);

    const { proposal: note } = await handler.handle(makeContext({ existingEntities: {} }));

    expect(note.status).toBe('draft');
    expect(missingFieldsFor(note)).toContain('targetId');
  });

  it('callback idempotency key is derived from recordingId when present', async () => {
    const repo = new InMemoryProposalRepository();
    const handler = new ComplaintTaskHandler(repo);

    await handler.handle(makeContext({ recordingId: 'rec-xyz' }));

    const all = await repo.findByTenant('t-1');
    const callback = all.find((p) => p.proposalType === 'callback')!;
    expect(callback.idempotencyKey).toBe('voice-complaint-callback:rec-xyz');
  });

  it('callback has no idempotency key when recordingId is absent', async () => {
    const repo = new InMemoryProposalRepository();
    const handler = new ComplaintTaskHandler(repo);

    await handler.handle(makeContext({ existingEntities: {} }));

    const all = await repo.findByTenant('t-1');
    const callback = all.find((p) => p.proposalType === 'callback')!;
    expect(callback.idempotencyKey).toBeUndefined();
  });

  it('jobReference is preferred over customerName for the note target', async () => {
    const repo = new InMemoryProposalRepository();
    const handler = new ComplaintTaskHandler(repo);

    const { proposal: note } = await handler.handle(
      makeContext({
        existingEntities: { jobReference: 'JOB-0042', customerName: 'Smith' },
      }),
    );

    expect(note.payload.targetKind).toBe('job');
    expect(note.payload.targetReference).toBe('JOB-0042');
  });
});

describe('complaintSeverity', () => {
  it('detects high-severity keywords', () => {
    expect(complaintSeverity('I want my money back, this is going to my attorney')).toBe('high');
    expect(complaintSeverity('I will report you to the Better Business Bureau')).toBe('high');
    expect(complaintSeverity('he threatened legal action')).toBe('high');
    expect(complaintSeverity('filing a report with the BBB tomorrow')).toBe('high');
    expect(complaintSeverity('reporting to better business bureau today')).toBe('high');
  });

  it('returns normal for ordinary complaints', () => {
    expect(complaintSeverity('the tech left mud on the carpet, please send someone')).toBe('normal');
    expect(complaintSeverity('')).toBe('normal');
  });
});
