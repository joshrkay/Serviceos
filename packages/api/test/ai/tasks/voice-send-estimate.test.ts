/**
 * Sibling of voice-send-invoice.test.ts — SendEstimateTaskHandler used to
 * leave missingFields EMPTY whenever a free-text reference ("the Khan
 * estimate", jobReference "EST-0042") was extracted, only gating when NO
 * reference existed at all. SendEstimateExecutionHandler requires
 * payload.estimateId to already be a UUID and never reads
 * estimateReference. So a reference-only send_estimate proposal was
 * approvable and would then fail at execution — the same doomed-approval
 * bug previously fixed for send_invoice. This file pins the parity fix.
 */
import { describe, it, expect, vi } from 'vitest';
import { SendEstimateTaskHandler } from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor } from '../../../src/proposals/proposal';
import { sendEstimatePayloadSchema } from '../../../src/proposals/contracts/send-estimate';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return { tenantId: 't-1', userId: 'u-1', message: 'test transcript', ...overrides };
}

describe('SendEstimateTaskHandler', () => {
  it('carries a customer-name reference but flags estimateId missing (approval gate holds)', async () => {
    const res = await new SendEstimateTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Khan' } }),
    );
    expect(res.proposal.proposalType).toBe('send_estimate');
    expect(res.proposal.payload.estimateReference).toBe('Khan');
    expect(res.proposal.payload.estimateId).toBeUndefined();
    expect(missingFieldsFor(res.proposal)).toContain('estimateId');
    expect(res.proposal.status).toBe('draft');
  });

  it('carries an estimate-number reference but flags estimateId missing', async () => {
    const res = await new SendEstimateTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'EST-0042' } }),
    );
    expect(res.proposal.payload.estimateReference).toBe('EST-0042');
    expect(missingFieldsFor(res.proposal)).toContain('estimateId');
  });

  it('flags estimateId missing when no reference was extracted at all', async () => {
    const res = await new SendEstimateTaskHandler().handle(ctx({ existingEntities: {} }));
    expect(missingFieldsFor(res.proposal)).toContain('estimateId');
    expect(res.proposal.payload.estimateReference).toBeUndefined();
  });

  it('uses the reference directly as estimateId (no gate) when it is already a UUID', async () => {
    const uuid = '22222222-2222-2222-2222-222222222222';
    const res = await new SendEstimateTaskHandler().handle(
      ctx({ existingEntities: { jobReference: uuid } }),
    );
    expect(res.proposal.payload.estimateId).toBe(uuid);
    expect(res.proposal.payload.estimateReference).toBeUndefined();
    expect(missingFieldsFor(res.proposal)).not.toContain('estimateId');
  });

  it('once estimateId is resolved, the payload satisfies the execution schema', async () => {
    const res = await new SendEstimateTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Khan', sendChannel: 'sms' } }),
    );
    const resolved = {
      ...res.proposal.payload,
      estimateId: '22222222-2222-2222-2222-222222222222',
    };
    expect(sendEstimatePayloadSchema.safeParse(resolved).success).toBe(true);
    expect(res.proposal.payload.channel).toBe('sms');
  });

  it('defaults channel to email when not extracted', async () => {
    const res = await new SendEstimateTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Khan' } }),
    );
    expect(res.proposal.payload.channel).toBe('email');
  });
});

describe('SendEstimateTaskHandler — B2 candidatesForReference', () => {
  const EST_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const EST_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  it('records candidates on sourceContext (never payload) while the gate stays present', async () => {
    const findByTenant = vi.fn().mockResolvedValue([
      { id: EST_A, estimateNumber: 'EST-0042', status: 'sent', customerMessage: undefined },
      { id: EST_B, estimateNumber: 'EST-0043', status: 'draft', customerMessage: undefined },
    ]);
    const res = await new SendEstimateTaskHandler({ estimateRepo: { findByTenant } as never }).handle(
      ctx({ existingEntities: { customerName: 'Khan' } }),
    );

    expect(findByTenant).toHaveBeenCalledWith('t-1', { search: 'Khan', limit: 5 });
    expect(missingFieldsFor(res.proposal)).toContain('estimateId');
    expect(res.proposal.payload.estimateId).toBeUndefined();
    expect((res.proposal.payload as Record<string, unknown>).entityCandidates).toBeUndefined();

    const sc = res.proposal.sourceContext as Record<string, unknown>;
    expect(sc.entityKind).toBe('estimate');
    expect(sc.entityReference).toBe('Khan');
    expect(sc.entityCandidates).toEqual([
      { id: EST_A, kind: 'estimate', label: 'EST-0042', hint: 'sent', score: 1 },
      { id: EST_B, kind: 'estimate', label: 'EST-0043', hint: 'draft', score: 1 },
    ]);
  });

  it('zero-match search → gate present, no candidates recorded', async () => {
    const findByTenant = vi.fn().mockResolvedValue([]);
    const res = await new SendEstimateTaskHandler({ estimateRepo: { findByTenant } as never }).handle(
      ctx({ existingEntities: { customerName: 'Khan' } }),
    );
    expect(missingFieldsFor(res.proposal)).toContain('estimateId');
    const sc = res.proposal.sourceContext as Record<string, unknown> | undefined;
    expect(sc?.entityCandidates).toBeUndefined();
  });

  it('no estimateRepo dep → gate present, no candidates, never throws', async () => {
    const res = await new SendEstimateTaskHandler().handle(
      ctx({ existingEntities: { customerName: 'Khan' } }),
    );
    expect(missingFieldsFor(res.proposal)).toContain('estimateId');
    const sc = res.proposal.sourceContext as Record<string, unknown> | undefined;
    expect(sc?.entityCandidates).toBeUndefined();
  });

  it('a UUID reference bypasses the gate entirely — no candidate search attempted', async () => {
    const uuid = '22222222-2222-2222-2222-222222222222';
    const findByTenant = vi.fn().mockResolvedValue([]);
    const res = await new SendEstimateTaskHandler({ estimateRepo: { findByTenant } as never }).handle(
      ctx({ existingEntities: { jobReference: uuid } }),
    );
    expect(findByTenant).not.toHaveBeenCalled();
    expect(missingFieldsFor(res.proposal)).not.toContain('estimateId');
  });

  it('a repo error degrades to the gate with no candidates (failure-soft)', async () => {
    const findByTenant = vi.fn().mockRejectedValue(new Error('db down'));
    const res = await new SendEstimateTaskHandler({ estimateRepo: { findByTenant } as never }).handle(
      ctx({ existingEntities: { customerName: 'Khan' } }),
    );
    expect(missingFieldsFor(res.proposal)).toContain('estimateId');
    const sc = res.proposal.sourceContext as Record<string, unknown> | undefined;
    expect(sc?.entityCandidates).toBeUndefined();
  });
});
