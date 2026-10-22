/**
 * A4-4 — whether a proposal row moved since a writer read it, and the
 * repository write that is refused when it did.
 *
 * `proposalChangedSince` is the one comparison both sides of the race use:
 * the entity pick's re-draft refuses a stale draft with it (A3-1), and
 * `updateIfUnchanged` refuses an edit built from a stale read (A4-4). The Pg
 * implementation runs the same comparison under the row lock; its real
 * columns are pinned in test/integration/proposal-row-lock-races.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryProposalRepository,
  createProposal,
  proposalChangedSince,
  type Proposal,
} from '../../src/proposals/proposal';

const TENANT = 'tenant-a44';

function row(overrides: Partial<Proposal> = {}): Proposal {
  return {
    ...createProposal({
      tenantId: TENANT,
      proposalType: 'voice_clarification',
      summary: 'Which customer?',
      createdBy: 'owner-1',
      payload: { transcript: 'invoice Bob', entityCandidates: [{ id: 'a', label: 'Bob A', score: 0.8 }] },
      sourceContext: { source: 'voice', entityKind: 'customer' },
    }),
    updatedAt: new Date('2026-10-22T10:00:00.000Z'),
    ...overrides,
  };
}

describe('A4-4 — proposalChangedSince', () => {
  it('an identical row, or a deep copy of it, has not changed', () => {
    const read = row();
    expect(proposalChangedSince(read, read)).toBe(false);
    expect(proposalChangedSince(read, structuredClone(read))).toBe(false);
  });

  it('a later updatedAt is a change even when nothing else differs', () => {
    const read = row();
    expect(proposalChangedSince(read, { ...read, updatedAt: new Date('2026-10-22T10:00:00.001Z') })).toBe(true);
  });

  // updatedAt keeps milliseconds only: two writes in the same millisecond
  // must still be seen through the fields a writer builds from.
  it.each([
    ['status', { status: 'approved' as const }],
    ['proposal type', { proposalType: 'draft_invoice' as const }],
    ['payload', { payload: { transcript: 'invoice Bob', customerId: 'a' } }],
    ['sourceContext', { sourceContext: { source: 'voice', resolvedEntities: [{ id: 'a', field: 'customerId' }] } }],
    ['sourceContext appearing', { sourceContext: undefined }],
  ])('a different %s at the same updatedAt is a change', (_label, change) => {
    const read = row();
    expect(proposalChangedSince(read, { ...read, ...change })).toBe(true);
  });
});

describe('A4-4 — InMemoryProposalRepository.updateIfUnchanged', () => {
  it('writes when the row is still the one that was read', async () => {
    const repo = new InMemoryProposalRepository();
    const read = await repo.create(row());

    const written = await repo.updateIfUnchanged(TENANT, read.id, read, { payload: { transcript: 'edited' } });

    expect(written?.payload).toEqual({ transcript: 'edited' });
    expect((await repo.findById(TENANT, read.id))!.payload).toEqual({ transcript: 'edited' });
  });

  it('refuses (null) and writes nothing when the row moved since the read', async () => {
    const repo = new InMemoryProposalRepository();
    const read = await repo.create(row());
    await repo.update(TENANT, read.id, { payload: { transcript: 'invoice Bob', customerId: 'a' } });

    const written = await repo.updateIfUnchanged(TENANT, read.id, read, { payload: { transcript: 'edited' } });

    expect(written).toBeNull();
    expect((await repo.findById(TENANT, read.id))!.payload).toEqual({ transcript: 'invoice Bob', customerId: 'a' });
  });

  it('refuses (null) for a row that is gone or belongs to another tenant', async () => {
    const repo = new InMemoryProposalRepository();
    const read = await repo.create(row());
    expect(await repo.updateIfUnchanged('other-tenant', read.id, read, { summary: 'x' })).toBeNull();
    expect(await repo.updateIfUnchanged(TENANT, 'missing-id', read, { summary: 'x' })).toBeNull();
  });
});
