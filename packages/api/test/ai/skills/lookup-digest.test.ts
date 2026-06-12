/**
 * RV-064 — `lookup_digest` skill tests. Read-only over the digest repo;
 * fixture repo only (the digest worker owns generation).
 */
import { describe, it, expect } from 'vitest';
import { lookupDigest } from '../../../src/ai/skills/lookup-digest';
import {
  InMemoryDailyDigestRepository,
  type DailyDigestPayload,
} from '../../../src/digest/digest-service';

const TENANT = 'tenant-1';
const TZ = 'America/New_York';
// 2026-06-11 ~07:00 New York.
const NOW = new Date('2026-06-11T11:00:00.000Z');

function makePayload(over: Partial<DailyDigestPayload> = {}): DailyDigestPayload {
  return {
    date: '2026-06-11',
    timezone: TZ,
    revenueCents: 45000,
    grossRevenueCents: 45000,
    refundsCents: 0,
    paymentsCount: 1,
    jobsCompletedCount: 2,
    tomorrow: { appointmentCount: 3, firstStartIso: '2026-06-12T12:00:00.000Z' },
    pendingApprovals: { totalCount: 1, top: [] },
    overdueInvoicesCount: 0,
    unbilledJobs: [],
    ...over,
  };
}

describe('lookupDigest (RV-064)', () => {
  it("speaks today's stored narrative verbatim", async () => {
    const digestRepo = new InMemoryDailyDigestRepository();
    await digestRepo.upsert(TENANT, '2026-06-11', makePayload(), 'Strong close: $450 in, two jobs done.');

    const result = await lookupDigest({ tenantId: TENANT, timezone: TZ, now: NOW }, { digestRepo });

    expect(result.status).toBe('found');
    expect(result.summary).toBe('Strong close: $450 in, two jobs done.');
    if (result.status !== 'found') throw new Error('unexpected');
    expect(result.data).toEqual({ digestDate: '2026-06-11', narrativeSource: 'stored' });
  });

  it('falls back to the most recent digest with a spoken date prefix', async () => {
    const digestRepo = new InMemoryDailyDigestRepository();
    await digestRepo.upsert(TENANT, '2026-06-09', makePayload({ date: '2026-06-09' }), 'Older day.');
    await digestRepo.upsert(TENANT, '2026-06-10', makePayload({ date: '2026-06-10' }), 'Quiet Wednesday.');

    const result = await lookupDigest({ tenantId: TENANT, timezone: TZ, now: NOW }, { digestRepo });

    expect(result.status).toBe('found');
    expect(result.summary).toBe("Here's your latest digest, from June 10: Quiet Wednesday.");
  });

  it('computes a fallback line from payload counts when the narrative is empty', async () => {
    const digestRepo = new InMemoryDailyDigestRepository();
    await digestRepo.upsert(TENANT, '2026-06-11', makePayload(), undefined);

    const result = await lookupDigest({ tenantId: TENANT, timezone: TZ, now: NOW }, { digestRepo });

    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected');
    expect(result.data.narrativeSource).toBe('fallback');
    // buildFallbackNarrative shape — counts from the stored payload.
    expect(result.summary).toContain('Today you brought in $450 and completed 2 jobs.');
    expect(result.summary).toContain('Tomorrow has 3 visits');
    expect(result.summary).toContain('1 approval is waiting on you.');
  });

  it('treats a whitespace-only narrative as empty', async () => {
    const digestRepo = new InMemoryDailyDigestRepository();
    await digestRepo.upsert(TENANT, '2026-06-11', makePayload(), '   ');
    const result = await lookupDigest({ tenantId: TENANT, timezone: TZ, now: NOW }, { digestRepo });
    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('unexpected');
    expect(result.data.narrativeSource).toBe('fallback');
  });

  it("returns none when the tenant has no digest yet (and never reads another tenant's)", async () => {
    const digestRepo = new InMemoryDailyDigestRepository();
    await digestRepo.upsert('tenant-2', '2026-06-11', makePayload(), 'Not yours.');

    const result = await lookupDigest({ tenantId: TENANT, timezone: TZ, now: NOW }, { digestRepo });

    expect(result.status).toBe('none');
    expect(result.summary).toBe(
      "I don't have a daily digest for you yet — one is generated at the end of each day.",
    );
  });

  it('degrades to an error summary when the repo throws', async () => {
    const digestRepo = new InMemoryDailyDigestRepository();
    digestRepo.findByTenantAndDate = async () => {
      throw new Error('boom');
    };
    const result = await lookupDigest({ tenantId: TENANT, timezone: TZ, now: NOW }, { digestRepo });
    expect(result.status).toBe('error');
    expect(result.summary).toBe("I'm having trouble pulling up your digest right now.");
  });

  it('records a lookup_events audit row when wired', async () => {
    const digestRepo = new InMemoryDailyDigestRepository();
    await digestRepo.upsert(TENANT, '2026-06-11', makePayload(), 'Strong close.');
    const recorded: unknown[] = [];

    await lookupDigest(
      { tenantId: TENANT, timezone: TZ, now: NOW, sessionId: 'sess-1' },
      {
        digestRepo,
        lookupEvents: {
          record: async (input: unknown) => {
            recorded.push(input);
          },
        } as never,
      },
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      tenantId: TENANT,
      intent: 'lookup_digest',
      sessionId: 'sess-1',
      resultStatus: 'found',
      resultCount: 1,
    });
  });
});
