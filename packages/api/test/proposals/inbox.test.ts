import { describe, it, expect } from 'vitest';
import { buildInboxPayload, listSince } from '../../src/proposals/inbox';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import type { Proposal } from '../../src/proposals/proposal';

function makeProposal(over: Partial<Proposal>): Proposal {
  const now = new Date();
  return {
    id: `prop-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: 't1',
    proposalType: 'draft_invoice',
    status: 'ready_for_review',
    payload: {},
    summary: 'A proposal',
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const SOON = new Date(Date.now() + 30 * 60 * 1000);
const FAR = new Date(Date.now() + 24 * 60 * 60 * 1000);

describe('buildInboxPayload', () => {
  it('returns proposals sorted by urgency tier (critical first)', () => {
    const inbox = buildInboxPayload(
      [
        makeProposal({ id: 'normal-1' }),
        makeProposal({ id: 'critical-1', expiresAt: SOON }),
        makeProposal({ id: 'low-1', confidenceScore: 0.99, proposalType: 'add_note' }),
      ],
      100,
    );
    expect(inbox.data[0].proposal.id).toBe('critical-1');
    expect(inbox.data[0].urgency).toBe('critical');
  });

  it('annotates each row with urgency and reason from prioritizeProposals', () => {
    const inbox = buildInboxPayload(
      [makeProposal({ id: 'p1', expiresAt: SOON })],
      100,
    );
    expect(inbox.data).toHaveLength(1);
    expect(inbox.data[0].urgency).toBe('critical');
    expect(inbox.data[0].reason).toMatch(/expir/i);
  });

  it('reports per-tier counts in the summary', () => {
    const inbox = buildInboxPayload(
      [
        makeProposal({ id: 'a', expiresAt: SOON }),
        makeProposal({ id: 'b', expiresAt: SOON }),
        makeProposal({ id: 'c', expiresAt: FAR }),
      ],
      100,
    );
    expect(inbox.summary.criticalCount).toBe(2);
    expect(inbox.summary.normalCount).toBe(1);
    expect(inbox.summary.totalCount).toBe(3);
  });

  it('caps the response at the given limit and reports truncation', () => {
    const proposals = Array.from({ length: 150 }, (_, i) => makeProposal({ id: `p${i}` }));
    const inbox = buildInboxPayload(proposals, 100);
    expect(inbox.data).toHaveLength(100);
    expect(inbox.summary.totalCount).toBe(150);
    expect(inbox.summary.truncated).toBe(true);
  });

  // #1278 — the inbox was hard-capped at 100 with no way to see the rest.
  // `offset` is a new optional third argument (default 0) so every existing
  // 2-arg call site (routes/proposals.ts pre-fix, lookup-day-overview.ts,
  // and the tests above) keeps its exact prior behavior.
  describe('offset pagination (#1278)', () => {
    const proposals = Array.from({ length: 250 }, (_, i) =>
      // Fixed createdAt spacing so prioritizeProposals' ordering (and thus
      // page boundaries) is deterministic across runs.
      makeProposal({ id: `p${String(i).padStart(3, '0')}`, createdAt: new Date(Date.now() - i * 1000) }),
    );

    it('returns the second page starting where the first left off', () => {
      const page1 = buildInboxPayload(proposals, 100, 0);
      const page2 = buildInboxPayload(proposals, 100, 100);
      expect(page1.data).toHaveLength(100);
      expect(page2.data).toHaveLength(100);
      const page1Ids = new Set(page1.data.map((p) => p.proposal.id));
      const page2Ids = new Set(page2.data.map((p) => p.proposal.id));
      expect([...page1Ids].some((id) => page2Ids.has(id))).toBe(false);
    });

    it('reports pagination metadata: hasMore + nextOffset while more remain', () => {
      const page1 = buildInboxPayload(proposals, 100, 0);
      expect(page1.pagination).toEqual({ offset: 0, limit: 100, hasMore: true, nextOffset: 100 });
      expect(page1.summary.truncated).toBe(true);
    });

    it('the last page reports hasMore=false and nextOffset=null', () => {
      const lastPage = buildInboxPayload(proposals, 100, 200);
      expect(lastPage.data).toHaveLength(50);
      expect(lastPage.pagination).toEqual({ offset: 200, limit: 100, hasMore: false, nextOffset: null });
      expect(lastPage.summary.truncated).toBe(false);
    });

    it('an offset past the end returns an empty page, not an error', () => {
      const page = buildInboxPayload(proposals, 100, 1000);
      expect(page.data).toEqual([]);
      expect(page.pagination).toEqual({ offset: 1000, limit: 100, hasMore: false, nextOffset: null });
    });

    it('summary counts stay totals over the WHOLE set on every page, not just the page', () => {
      const page2 = buildInboxPayload(proposals, 100, 100);
      expect(page2.summary.totalCount).toBe(250);
    });

    it('defaults offset to 0 when omitted (backward compatible)', () => {
      const withDefault = buildInboxPayload(proposals, 100);
      const withExplicitZero = buildInboxPayload(proposals, 100, 0);
      expect(withDefault.data.map((p) => p.proposal.id)).toEqual(
        withExplicitZero.data.map((p) => p.proposal.id),
      );
      expect(withDefault.pagination).toEqual({ offset: 0, limit: 100, hasMore: true, nextOffset: 100 });
    });
  });

  it('returns an empty payload with zero counts for an empty input', () => {
    const inbox = buildInboxPayload([], 100);
    expect(inbox.data).toEqual([]);
    expect(inbox.summary.totalCount).toBe(0);
    expect(inbox.summary.truncated).toBe(false);
  });
});

describe('listSince (RV-011 — overnight events)', () => {
  const SINCE = new Date('2026-06-11T00:00:00.000Z'); // "yesterday 6pm" stand-in
  const BEFORE = new Date('2026-06-10T12:00:00.000Z');
  const AFTER = new Date('2026-06-11T06:30:00.000Z');

  async function seed(rows: Partial<Proposal>[]): Promise<InMemoryProposalRepository> {
    const repo = new InMemoryProposalRepository();
    for (const over of rows) {
      await repo.create(makeProposal({ createdAt: BEFORE, updatedAt: BEFORE, ...over }));
    }
    return repo;
  }

  it('buckets proposals created since the timestamp, oldest first', async () => {
    const repo = await seed([
      { id: 'old', createdAt: BEFORE },
      { id: 'new-2', createdAt: AFTER },
      { id: 'new-1', createdAt: new Date('2026-06-11T01:00:00.000Z') },
    ]);
    const events = await listSince(repo, 't1', SINCE);
    expect(events.created.map((p) => p.id)).toEqual(['new-1', 'new-2']);
    expect(events.executed).toEqual([]);
    expect(events.failed).toEqual([]);
    expect(events.totalCount).toBe(2);
  });

  it('buckets executions and failures by their event time, not creation time', async () => {
    const repo = await seed([
      { id: 'executed-overnight', status: 'executed', createdAt: BEFORE, executedAt: AFTER },
      { id: 'executed-long-ago', status: 'executed', createdAt: BEFORE, executedAt: BEFORE },
      { id: 'failed-overnight', status: 'execution_failed', createdAt: BEFORE, updatedAt: AFTER },
      { id: 'failed-long-ago', status: 'execution_failed', createdAt: BEFORE, updatedAt: BEFORE },
    ]);
    const events = await listSince(repo, 't1', SINCE);
    expect(events.created).toEqual([]);
    expect(events.executed.map((p) => p.id)).toEqual(['executed-overnight']);
    expect(events.failed.map((p) => p.id)).toEqual(['failed-overnight']);
    expect(events.totalCount).toBe(2);
  });

  it('falls back to updatedAt for executed rows that predate the executedAt stamp', async () => {
    const repo = await seed([
      { id: 'historical', status: 'executed', createdAt: BEFORE, updatedAt: AFTER },
    ]);
    const events = await listSince(repo, 't1', SINCE);
    expect(events.executed.map((p) => p.id)).toEqual(['historical']);
  });

  it('counts a proposal created AND executed overnight once in totalCount', async () => {
    const repo = await seed([
      { id: 'both', status: 'executed', createdAt: AFTER, executedAt: AFTER },
    ]);
    const events = await listSince(repo, 't1', SINCE);
    expect(events.created.map((p) => p.id)).toEqual(['both']);
    expect(events.executed.map((p) => p.id)).toEqual(['both']);
    expect(events.totalCount).toBe(1);
  });

  it('the since bound is inclusive', async () => {
    const repo = await seed([{ id: 'on-boundary', createdAt: SINCE }]);
    const events = await listSince(repo, 't1', SINCE);
    expect(events.created.map((p) => p.id)).toEqual(['on-boundary']);
  });

  it("never returns another tenant's proposals", async () => {
    const repo = await seed([
      { id: 'mine', tenantId: 't1', createdAt: AFTER },
      { id: 'theirs', tenantId: 't2', createdAt: AFTER },
    ]);
    const events = await listSince(repo, 't1', SINCE);
    expect(events.created.map((p) => p.id)).toEqual(['mine']);
    expect(events.totalCount).toBe(1);
  });

  it('returns empty buckets when nothing happened since the timestamp', async () => {
    const repo = await seed([{ id: 'old', createdAt: BEFORE }]);
    const events = await listSince(repo, 't1', SINCE);
    expect(events.created).toEqual([]);
    expect(events.executed).toEqual([]);
    expect(events.failed).toEqual([]);
    expect(events.totalCount).toBe(0);
  });
});
