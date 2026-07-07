/**
 * P8-015 — production ResolvedSinceChecker (createDroppedCallResolvedSince).
 *
 * Pins the three suppression signals and their failure isolation. Uses an
 * explicit stub session repo (not InMemoryVoiceSessionRepository) so
 * startedAt ordering is deterministic; the real-Postgres behavior (including
 * the context JSONB round-trip) is pinned in
 * test/integration/dropped-call-worker.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDroppedCallResolvedSince } from '../../../src/sms/recovery/resolved-since';
import type { VoiceSessionRepository, VoiceSessionRow } from '../../../src/voice/voice-session';
import type { Proposal } from '../../../src/proposals/proposal';
import { createLogger } from '../../../src/logging/logger';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

const TENANT = 'tenant-1';
const DROPPED_ID = 'vs-dropped';
const T0 = new Date('2026-07-01T10:00:00.000Z');

function session(overrides: Partial<VoiceSessionRow>): VoiceSessionRow {
  return {
    id: DROPPED_ID,
    tenantId: TENANT,
    channel: 'telephony',
    state: 'ended',
    startedAt: T0,
    ...overrides,
  } as VoiceSessionRow;
}

function stubSessionRepo(rows: VoiceSessionRow[]): VoiceSessionRepository {
  return {
    create: vi.fn(),
    markEnded: vi.fn(),
    async findById(tenantId, id) {
      return rows.find((r) => r.tenantId === tenantId && r.id === id) ?? null;
    },
    async findByTenant(tenantId, opts = {}) {
      return rows
        .filter((r) => r.tenantId === tenantId)
        .filter((r) => !opts.endedOnly || r.endedAt !== undefined)
        .filter((r) => !opts.customerId || r.customerId === opts.customerId)
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, opts.limit ?? 50);
    },
  } as unknown as VoiceSessionRepository;
}

function stubProposalRepo(proposals: Record<string, Proposal | null>) {
  return {
    findById: vi.fn(async (_tenantId: string, id: string) => proposals[id] ?? null),
  };
}

describe('createDroppedCallResolvedSince', () => {
  it('signal 1: same-session outcome completed → booking_completed', async () => {
    const check = createDroppedCallResolvedSince({
      voiceSessionRepo: stubSessionRepo([session({ outcome: 'completed' })]),
      proposalRepo: stubProposalRepo({}),
      logger,
    });
    expect(await check(TENANT, DROPPED_ID)).toBe('booking_completed');
  });

  it('signal 1: escalated_to_human maps to transferred (enum has no transferred value)', async () => {
    const check = createDroppedCallResolvedSince({
      voiceSessionRepo: stubSessionRepo([session({ outcome: 'escalated_to_human' })]),
      proposalRepo: stubProposalRepo({}),
      logger,
    });
    expect(await check(TENANT, DROPPED_ID)).toBe('transferred');
  });

  it('signal 2: an executed proposal from the row context → booking_completed', async () => {
    const check = createDroppedCallResolvedSince({
      voiceSessionRepo: stubSessionRepo([session({ outcome: 'dropped' })]),
      proposalRepo: stubProposalRepo({
        'p-1': { status: 'pending_approval' } as Proposal,
        'p-2': { status: 'executed' } as Proposal,
      }),
      logger,
    });
    expect(
      await check(TENANT, DROPPED_ID, {
        state: 'collecting',
        bucket: 'proposal_created',
        proposalIds: ['p-1', 'p-2'],
      }),
    ).toBe('booking_completed');
  });

  it('signal 3: a NEWER completed session for the same customer → booking_completed', async () => {
    const later = new Date(T0.getTime() + 5 * 60_000);
    const check = createDroppedCallResolvedSince({
      voiceSessionRepo: stubSessionRepo([
        session({ outcome: 'dropped', customerId: 'cust-1', endedAt: T0 }),
        session({
          id: 'vs-callback',
          outcome: 'completed',
          customerId: 'cust-1',
          startedAt: later,
          endedAt: new Date(later.getTime() + 60_000),
        }),
      ]),
      proposalRepo: stubProposalRepo({}),
      logger,
    });
    expect(await check(TENANT, DROPPED_ID)).toBe('booking_completed');
  });

  it('signal 3: a call-back session started BEFORE the drop is ignored', async () => {
    const earlier = new Date(T0.getTime() - 5 * 60_000);
    const check = createDroppedCallResolvedSince({
      voiceSessionRepo: stubSessionRepo([
        session({ outcome: 'dropped', customerId: 'cust-1', endedAt: T0 }),
        session({
          id: 'vs-older',
          outcome: 'completed',
          customerId: 'cust-1',
          startedAt: earlier,
          endedAt: T0,
        }),
      ]),
      proposalRepo: stubProposalRepo({}),
      logger,
    });
    expect(await check(TENANT, DROPPED_ID)).toBeNull();
  });

  it('returns null when nothing resolved (session missing, no context, no customer)', async () => {
    const check = createDroppedCallResolvedSince({
      voiceSessionRepo: stubSessionRepo([]),
      proposalRepo: stubProposalRepo({}),
      logger,
    });
    expect(await check(TENANT, DROPPED_ID)).toBeNull();
  });

  it('malformed context (no proposalIds) skips signal 2 without breaking the others', async () => {
    const check = createDroppedCallResolvedSince({
      voiceSessionRepo: stubSessionRepo([session({ outcome: 'dropped' })]),
      proposalRepo: stubProposalRepo({}),
      logger,
    });
    expect(
      await check(TENANT, DROPPED_ID, {
        state: 'collecting',
        bucket: 'early',
      } as never),
    ).toBeNull();
  });

  it('failure isolation: a throwing session repo does not disable the proposal signal', async () => {
    const failingSessions = {
      create: vi.fn(),
      markEnded: vi.fn(),
      findById: vi.fn(async () => {
        throw new Error('db down');
      }),
      findByTenant: vi.fn(async () => []),
    } as unknown as VoiceSessionRepository;

    const check = createDroppedCallResolvedSince({
      voiceSessionRepo: failingSessions,
      proposalRepo: stubProposalRepo({ 'p-1': { status: 'executed' } as Proposal }),
      logger,
    });
    expect(
      await check(TENANT, DROPPED_ID, {
        state: 'collecting',
        bucket: 'proposal_created',
        proposalIds: ['p-1'],
      }),
    ).toBe('booking_completed');
  });

  it('failure isolation: a throwing proposal repo falls through to null (send wins)', async () => {
    const check = createDroppedCallResolvedSince({
      voiceSessionRepo: stubSessionRepo([session({ outcome: 'dropped' })]),
      proposalRepo: {
        findById: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
      logger,
    });
    expect(
      await check(TENANT, DROPPED_ID, {
        state: 'collecting',
        bucket: 'proposal_created',
        proposalIds: ['p-1'],
      }),
    ).toBeNull();
  });
});
