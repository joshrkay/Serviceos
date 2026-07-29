/**
 * U8 / B8.10 — send_estimate_nudge voice on-ramp (task-handler level).
 *
 * The SendEstimateNudgeExecutionHandler already exists (48h-cooldown re-send of
 * an already-sent estimate). Pre-B8.10 this handler always gated
 * (missingFields: ['estimateId'] unconditional, by design comment) so a
 * spoken nudge could never complete. B8.10 (see
 * projects/rivet-voice-19/b8.10-design.md) adds real resolution: a unique,
 * VERIFIED, NUDGEABLE match now lifts the gate outright.
 */
import { describe, it, expect, vi } from 'vitest';
import { SendEstimateNudgeTaskHandler } from '../../../src/ai/tasks/voice-extended-tasks';
import { TaskContext } from '../../../src/ai/tasks/task-handlers';
import { missingFieldsFor } from '../../../src/proposals/proposal';

function ctx(overrides: Partial<TaskContext>): TaskContext {
  return { tenantId: 't-1', userId: 'u-1', message: 'test transcript', ...overrides };
}

/** Minimal Estimate-shaped fixture — only the fields the handler reads. */
function estimateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'est-1',
    estimateNumber: 'EST-0001',
    status: 'sent',
    totals: { totalCents: 45000 },
    sentAt: new Date('2026-06-01T00:00:00Z'),
    createdAt: new Date('2026-05-20T00:00:00Z'),
    ...overrides,
  };
}

describe('SendEstimateNudgeTaskHandler — no estimateRepo wired (AC-4 fallback, unchanged)', () => {
  it('carries the estimate reference and stays in draft (comms never auto-approves)', async () => {
    const res = await new SendEstimateNudgeTaskHandler().handle(
      ctx({ existingEntities: { jobReference: 'the Khan estimate' } }),
    );
    expect(res.proposal.proposalType).toBe('send_estimate_nudge');
    expect(res.proposal.payload.estimateReference).toBe('the Khan estimate');
    // estimateId always flagged missing → approval gate holds until resolved.
    expect(missingFieldsFor(res.proposal)).toContain('estimateId');
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

// ── B8.10 ACs 1-4 ────────────────────────────────────────────────────────
describe('SendEstimateNudgeTaskHandler — B8.10 nudgeable resolution', () => {
  const NOW = new Date('2026-06-05T00:00:00Z');

  it('AC-1: a unique open (sent) estimate match for "Khan" lifts the gate', async () => {
    const khan = estimateRow({ id: 'est-khan', estimateNumber: 'EST-0042', status: 'sent' });
    const findByTenant = vi.fn().mockResolvedValue([khan]);
    const findById = vi.fn();

    const res = await new SendEstimateNudgeTaskHandler({
      estimateRepo: { findById, findByTenant } as never,
    }).handle(ctx({ now: NOW, existingEntities: { customerName: 'Khan' } }));

    expect(findByTenant).toHaveBeenCalledWith('t-1', { search: 'Khan', limit: 5 });
    expect(res.proposal.proposalType).toBe('send_estimate_nudge');
    expect(res.proposal.payload.estimateId).toBe('est-khan');
    expect(missingFieldsFor(res.proposal)).toEqual([]);
    // Repo-confirmed id rides the verified-ids allowlist, same convention as
    // resolveEstimateIdGate.
    expect((res.proposal.sourceContext as Record<string, unknown>)?.verifiedIds).toEqual({
      estimateId: 'est-khan',
    });
  });

  it('AC-2: two nudgeable Khan estimates → voice_clarification with number + amount + age candidates', async () => {
    const first = estimateRow({
      id: 'est-khan-1',
      estimateNumber: 'EST-0042',
      status: 'sent',
      totals: { totalCents: 45000 },
      sentAt: new Date('2026-06-01T00:00:00Z'),
    });
    const second = estimateRow({
      id: 'est-khan-2',
      estimateNumber: 'EST-0055',
      status: 'sent',
      totals: { totalCents: 120000 },
      sentAt: new Date('2026-06-04T00:00:00Z'),
    });
    const findByTenant = vi.fn().mockResolvedValue([first, second]);

    const res = await new SendEstimateNudgeTaskHandler({
      estimateRepo: { findByTenant } as never,
    }).handle(ctx({ now: NOW, existingEntities: { customerName: 'Khan' } }));

    expect(res.proposal.proposalType).toBe('voice_clarification');
    const payload = res.proposal.payload as Record<string, unknown>;
    expect(payload.reason).toBe('ambiguous_entity');
    expect(payload.entityReference).toBe('Khan');
    expect(payload.entityCandidates).toEqual([
      { id: 'est-khan-1', kind: 'estimate', label: 'EST-0042', hint: '$450.00 • sent 4 days ago', score: 1 },
      { id: 'est-khan-2', kind: 'estimate', label: 'EST-0055', hint: '$1200.00 • sent 1 day ago', score: 1 },
    ]);
  });

  it('AC-3: a unique match in a non-nudgeable state gates with a reason (not a clarification)', async () => {
    const accepted = estimateRow({ id: 'est-khan', estimateNumber: 'EST-0042', status: 'accepted' });
    const findByTenant = vi.fn().mockResolvedValue([accepted]);

    const res = await new SendEstimateNudgeTaskHandler({
      estimateRepo: { findByTenant } as never,
    }).handle(ctx({ existingEntities: { customerName: 'Khan' } }));

    // Decision (b8.10-design.md, logged): gate, never voice_clarification.
    expect(res.proposal.proposalType).toBe('send_estimate_nudge');
    expect(missingFieldsFor(res.proposal)).toContain('estimateId');
    // Review-card context: the matched estimate is still stamped for
    // display, but the gate is not lifted.
    expect(res.proposal.payload.estimateId).toBe('est-khan');
    expect(res.proposal.explanation).toMatch(/EST-0042.*'accepted'/);
    expect(res.proposal.explanation).toMatch(/only a sent, still-unanswered estimate/);
  });

  it.each(['draft', 'rejected', 'expired'] as const)(
    'AC-3: also gates for status %s',
    async (status) => {
      const row = estimateRow({ id: 'est-khan', estimateNumber: 'EST-0042', status });
      const findByTenant = vi.fn().mockResolvedValue([row]);
      const res = await new SendEstimateNudgeTaskHandler({
        estimateRepo: { findByTenant } as never,
      }).handle(ctx({ existingEntities: { customerName: 'Khan' } }));
      expect(missingFieldsFor(res.proposal)).toContain('estimateId');
      expect(res.proposal.explanation).toContain(`'${status}'`);
    },
  );

  it('AC-4: estimateRepo wired but no match found → plain fallback gate, no explanation', async () => {
    const findByTenant = vi.fn().mockResolvedValue([]);
    const res = await new SendEstimateNudgeTaskHandler({
      estimateRepo: { findByTenant } as never,
    }).handle(ctx({ existingEntities: { customerName: 'Khan' } }));

    expect(missingFieldsFor(res.proposal)).toContain('estimateId');
    expect(res.proposal.payload.estimateId).toBeUndefined();
    expect(res.proposal.payload.estimateReference).toBe('Khan');
    expect(res.proposal.explanation).toBeUndefined();
  });

  it('AC-4: multiple total matches but zero nudgeable ones falls through to the plain gate', async () => {
    const draftRow = estimateRow({ id: 'est-1', status: 'draft' });
    const acceptedRow = estimateRow({ id: 'est-2', status: 'accepted' });
    const findByTenant = vi.fn().mockResolvedValue([draftRow, acceptedRow]);
    const res = await new SendEstimateNudgeTaskHandler({
      estimateRepo: { findByTenant } as never,
    }).handle(ctx({ existingEntities: { customerName: 'Khan' } }));

    expect(missingFieldsFor(res.proposal)).toContain('estimateId');
    expect(res.proposal.payload.estimateId).toBeUndefined();
  });

  // ── router-verified estimateId seam (verify-or-gate) ──────────────────
  // `resolvedEstimateIdFrom` only accepts UUID-shaped values (isUuid) —
  // these fixtures use real UUIDs, unlike the plain-string ids used above
  // for the search-only rows.
  const VERIFIED_UUID = '77777777-7777-4777-8777-777777777777';
  const STALE_UUID = '88888888-8888-4888-8888-888888888888';

  it('a router-verified estimateId that checks out and is nudgeable lifts the gate without a search', async () => {
    const sent = estimateRow({ id: VERIFIED_UUID, status: 'sent' });
    const findById = vi.fn().mockResolvedValue(sent);
    const findByTenant = vi.fn();

    const res = await new SendEstimateNudgeTaskHandler({
      estimateRepo: { findById, findByTenant } as never,
    }).handle(
      ctx({
        existingEntities: { customerName: 'Khan', estimateId: VERIFIED_UUID },
      }),
    );

    expect(findById).toHaveBeenCalledWith('t-1', VERIFIED_UUID);
    expect(findByTenant).not.toHaveBeenCalled();
    expect(res.proposal.payload.estimateId).toBe(VERIFIED_UUID);
    expect(missingFieldsFor(res.proposal)).toEqual([]);
  });

  it('a router-verified estimateId that checks out but is non-nudgeable gates with a reason', async () => {
    const accepted = estimateRow({ id: VERIFIED_UUID, estimateNumber: 'EST-0099', status: 'accepted' });
    const findById = vi.fn().mockResolvedValue(accepted);

    const res = await new SendEstimateNudgeTaskHandler({
      estimateRepo: { findById, findByTenant: vi.fn() } as never,
    }).handle(
      ctx({ existingEntities: { customerName: 'Khan', estimateId: VERIFIED_UUID } }),
    );

    expect(missingFieldsFor(res.proposal)).toContain('estimateId');
    expect(res.proposal.explanation).toContain('EST-0099');
  });

  it('a router-supplied estimateId that does NOT verify against the repo is dropped and falls back to search', async () => {
    const findById = vi.fn().mockResolvedValue(null); // repo miss — hallucinated/stale id
    const khan = estimateRow({ id: 'est-khan-real', status: 'sent' });
    const findByTenant = vi.fn().mockResolvedValue([khan]);

    const res = await new SendEstimateNudgeTaskHandler({
      estimateRepo: { findById, findByTenant } as never,
    }).handle(
      ctx({
        existingEntities: { customerName: 'Khan', estimateId: STALE_UUID },
      }),
    );

    // Falls through to the reference search and finds the real one.
    expect(findByTenant).toHaveBeenCalled();
    expect(res.proposal.payload.estimateId).toBe('est-khan-real');
    expect(missingFieldsFor(res.proposal)).toEqual([]);
  });

  it('a repo error during search degrades to the plain gate (failure-soft), never throws', async () => {
    const findByTenant = vi.fn().mockRejectedValue(new Error('db down'));
    const res = await new SendEstimateNudgeTaskHandler({
      estimateRepo: { findByTenant } as never,
    }).handle(ctx({ existingEntities: { customerName: 'Khan' } }));

    expect(missingFieldsFor(res.proposal)).toContain('estimateId');
  });
});
