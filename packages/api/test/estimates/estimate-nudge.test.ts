/**
 * T4-F01 — unit tests for dispatchEstimateNudge's claim-before-send gate.
 * Mocked Pool with a small in-memory send_claims simulation (claim/reclaim/
 * tombstone), matching send-claim-ledger.ts's exact SQL shapes closely
 * enough to exercise dispatchEstimateNudge's control flow. Real-Postgres
 * proof of the SQL itself lives in test/integration/send-claim-ledger.test.ts
 * and test/integration/estimate-nudge.test.ts (Docker-gated).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import {
  dispatchEstimateNudge,
  EstimateNudgeAlreadyClaimedError,
  type EstimateNudgeDeps,
} from '../../src/estimates/estimate-nudge';
import { Estimate, InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';
import type { SendService } from '../../src/notifications/send-service';

const TENANT = 't-1';
const ESTIMATE_ID = '3f9d1f2e-1111-4222-8333-444455556666';
const NOW = new Date('2026-06-10T18:00:00Z');

function makeEstimate(overrides: Partial<Estimate> = {}): Estimate {
  const lineItems: LineItem[] = [buildLineItem('li-1', 'Service call', 1, 15000, 0, true, 'labor')];
  return {
    id: ESTIMATE_ID,
    tenantId: TENANT,
    jobId: 'job-1',
    estimateNumber: 'EST-0042',
    status: 'sent',
    lineItems,
    totals: calculateDocumentTotals(lineItems, 0, 0),
    sentAt: new Date('2026-06-01T12:00:00Z'),
    version: 1,
    createdBy: 'u-1',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

interface ClaimRow {
  status: 'claimed' | 'sending' | 'sent';
  claimedAt: number;
}

/** See test/workers/thank-you-sms-worker.test.ts for the same pattern/rationale. */
function claimAwarePool(claims: Map<string, ClaimRow> = new Map()): { pool: Pool; claims: Map<string, ClaimRow> } {
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (!sql.includes('send_claims')) {
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    }
    const key = `${params[0]}::${params[1]}`;
    if (sql.trim().startsWith('INSERT')) {
      const staleMinutes = Number(params[2]);
      const existing = claims.get(key);
      if (!existing) {
        claims.set(key, { status: 'claimed', claimedAt: Date.now() });
        return { rows: [{ claim_key: params[1] }], rowCount: 1 } as unknown as QueryResult;
      }
      const staleMs = staleMinutes * 60_000;
      // Only ever reclaims 'claimed' rows — a 'sending' row (provider call
      // in flight or crashed mid-flight) is NEVER auto-reclaimed, matching
      // claimSend's real WHERE clause.
      if (existing.status === 'claimed' && Date.now() - existing.claimedAt >= staleMs) {
        existing.claimedAt = Date.now();
        return { rows: [{ claim_key: params[1] }], rowCount: 1 } as unknown as QueryResult;
      }
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    }
    if (sql.trim().startsWith('UPDATE')) {
      const existing = claims.get(key);
      // Distinguish the sending-transition UPDATE from the completion
      // UPDATE by SQL text so the fake models the intermediate state.
      if (existing) existing.status = sql.includes("'sending'") ? 'sending' : 'sent';
      return { rows: [], rowCount: existing ? 1 : 0 } as unknown as QueryResult;
    }
    if (sql.trim().startsWith('DELETE')) {
      const existing = claims.get(key);
      if (existing?.status === 'claimed' || existing?.status === 'sending') claims.delete(key);
      return { rows: [], rowCount: 1 } as unknown as QueryResult;
    }
    return { rows: [], rowCount: 0 } as unknown as QueryResult;
  });
  return { pool: { query } as unknown as Pool, claims };
}

function makeSendService(): Pick<SendService, 'sendEstimate'> & {
  sendEstimate: ReturnType<typeof vi.fn>;
} {
  return {
    sendEstimate: vi.fn().mockResolvedValue({
      estimateId: ESTIMATE_ID,
      viewUrl: 'https://x/e/tok',
      viewToken: 'tok',
      channelsSent: [],
    }),
  };
}

describe('dispatchEstimateNudge', () => {
  let estimateRepo: InMemoryEstimateRepository;
  let auditRepo: InMemoryAuditRepository;
  let sendService: ReturnType<typeof makeSendService>;
  let sendEstimate: ReturnType<typeof makeSendService>['sendEstimate'];

  beforeEach(async () => {
    estimateRepo = new InMemoryEstimateRepository();
    auditRepo = new InMemoryAuditRepository();
    sendService = makeSendService();
    sendEstimate = sendService.sendEstimate;
    await estimateRepo.create(makeEstimate());
  });

  function deps(overrides: Partial<EstimateNudgeDeps> = {}): EstimateNudgeDeps {
    return { estimateRepo, sendService, auditRepo, pool: null, ...overrides };
  }

  it('happy path: sends once, increments reminderCount, fires the audit event', async () => {
    await dispatchEstimateNudge(deps(), {
      tenantId: TENANT,
      estimate: makeEstimate(),
      channel: 'sms',
      asOf: NOW,
      actorId: 'worker',
    });

    expect(sendEstimate).toHaveBeenCalledTimes(1);
    const updated = await estimateRepo.findById(TENANT, ESTIMATE_ID);
    expect(updated!.reminderCount).toBe(1);
    expect(updated!.lastReminderAt).toEqual(NOW);
    const events = auditRepo.getAll();
    expect(events.some((e) => e.eventType === 'estimate.reminder_sent')).toBe(true);
  });

  it('no pool (dev/test posture): claim wrapper is skipped and the send proceeds directly', async () => {
    await dispatchEstimateNudge(deps({ pool: null }), {
      tenantId: TENANT,
      estimate: makeEstimate(),
      channel: 'sms',
      asOf: NOW,
      actorId: 'worker',
    });
    expect(sendEstimate).toHaveBeenCalledTimes(1);
  });

  describe('with a pool wired (claim-before-send active)', () => {
    it('crash-between-claim-and-send recovery: a stale claim for reminder #1 is reclaimed and sent', async () => {
      const { pool, claims } = claimAwarePool();
      claims.set(`${TENANT}::estimate_nudge:${ESTIMATE_ID}:1`, {
        status: 'claimed',
        claimedAt: Date.now() - 20 * 60_000,
      });

      await dispatchEstimateNudge(deps({ pool }), {
        tenantId: TENANT,
        estimate: makeEstimate(),
        channel: 'sms',
        asOf: NOW,
        actorId: 'worker',
      });

      expect(sendEstimate).toHaveBeenCalledTimes(1);
      const updated = await estimateRepo.findById(TENANT, ESTIMATE_ID);
      expect(updated!.reminderCount).toBe(1);
    });

    it('crash-between-send-and-mark: a "sent" claim for reminder #1 throws EstimateNudgeAlreadyClaimedError and does not resend', async () => {
      const { pool, claims } = claimAwarePool();
      claims.set(`${TENANT}::estimate_nudge:${ESTIMATE_ID}:1`, { status: 'sent', claimedAt: Date.now() });

      await expect(
        dispatchEstimateNudge(deps({ pool }), {
          tenantId: TENANT,
          estimate: makeEstimate(),
          channel: 'sms',
          asOf: NOW,
          actorId: 'worker',
        }),
      ).rejects.toThrow(EstimateNudgeAlreadyClaimedError);

      expect(sendEstimate).not.toHaveBeenCalled();
      const updated = await estimateRepo.findById(TENANT, ESTIMATE_ID);
      // reminderCount bookkeeping write never ran — this attempt didn't own the send.
      expect(updated!.reminderCount ?? 0).toBe(0);
    });

    it('concurrent race on the same occurrence: exactly one send wins, the other observes the claimed error', async () => {
      const { pool } = claimAwarePool();
      const attempt = () =>
        dispatchEstimateNudge(deps({ pool }), {
          tenantId: TENANT,
          estimate: makeEstimate(),
          channel: 'sms',
          asOf: NOW,
          actorId: 'worker',
        });

      const results = await Promise.allSettled([attempt(), attempt()]);
      expect(sendEstimate).toHaveBeenCalledTimes(1);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        EstimateNudgeAlreadyClaimedError,
      );
    });

    it('repeatability across occurrences: after reminderCount becomes 1, a second nudge (occurrence 2) is a fresh independent claim', async () => {
      const { pool } = claimAwarePool();
      await dispatchEstimateNudge(deps({ pool }), {
        tenantId: TENANT,
        estimate: makeEstimate(),
        channel: 'sms',
        asOf: NOW,
        actorId: 'worker',
      });
      const afterFirst = await estimateRepo.findById(TENANT, ESTIMATE_ID);
      expect(afterFirst!.reminderCount).toBe(1);

      await dispatchEstimateNudge(deps({ pool }), {
        tenantId: TENANT,
        estimate: afterFirst!,
        channel: 'sms',
        asOf: new Date(NOW.getTime() + 1000),
        actorId: 'worker',
      });

      expect(sendEstimate).toHaveBeenCalledTimes(2);
      const afterSecond = await estimateRepo.findById(TENANT, ESTIMATE_ID);
      expect(afterSecond!.reminderCount).toBe(2);
    });

    it('sendFn throw releases the claim so an immediate retry for the same occurrence can succeed', async () => {
      const { pool, claims } = claimAwarePool();
      sendEstimate.mockRejectedValueOnce(new Error('provider down'));

      await expect(
        dispatchEstimateNudge(deps({ pool }), {
          tenantId: TENANT,
          estimate: makeEstimate(),
          channel: 'sms',
          asOf: NOW,
          actorId: 'worker',
        }),
      ).rejects.toThrow('provider down');

      expect(claims.has(`${TENANT}::estimate_nudge:${ESTIMATE_ID}:1`)).toBe(false);

      await dispatchEstimateNudge(deps({ pool }), {
        tenantId: TENANT,
        estimate: makeEstimate(),
        channel: 'sms',
        asOf: NOW,
        actorId: 'worker',
      });
      expect(sendEstimate).toHaveBeenCalledTimes(2);
    });

    it('Codex P1 #2: SendService.sendEstimate signals provider-acceptance then its own entity-write throws — the claim ends "sent" (not released), reminderCount is NOT bumped by this attempt, and a retry is a duplicate no-op (never a resend)', async () => {
      const { pool, claims } = claimAwarePool();
      // Model SendService.sendEstimate's real shape: it calls
      // options.onProviderAccepted() once the provider channel dispatch
      // succeeds, THEN does its own estimate-entity write (sentAt/status/
      // lastDispatchId) — which we simulate throwing here.
      sendEstimate.mockImplementationOnce(
        async (_input: unknown, options?: { onProviderAccepted?: () => void }) => {
          options?.onProviderAccepted?.();
          throw new Error('estimate entity write failed');
        },
      );

      await expect(
        dispatchEstimateNudge(deps({ pool }), {
          tenantId: TENANT,
          estimate: makeEstimate(),
          channel: 'sms',
          asOf: NOW,
          actorId: 'worker',
        }),
      ).rejects.toThrow('estimate entity write failed');

      // The claim is finalized 'sent' (the customer really did receive the
      // estimate) — NOT released.
      expect(claims.get(`${TENANT}::estimate_nudge:${ESTIMATE_ID}:1`)?.status).toBe('sent');
      // This attempt didn't complete dispatchEstimateNudge's own bookkeeping.
      const updated = await estimateRepo.findById(TENANT, ESTIMATE_ID);
      expect(updated!.reminderCount ?? 0).toBe(0);

      // A retry for the same occurrence must be a duplicate no-op, never a
      // second real send.
      await expect(
        dispatchEstimateNudge(deps({ pool }), {
          tenantId: TENANT,
          estimate: makeEstimate(),
          channel: 'sms',
          asOf: NOW,
          actorId: 'worker',
        }),
      ).rejects.toThrow(EstimateNudgeAlreadyClaimedError);
      expect(sendEstimate).toHaveBeenCalledTimes(1); // only the one (failed-bookkeeping) real attempt
    });
  });
});
