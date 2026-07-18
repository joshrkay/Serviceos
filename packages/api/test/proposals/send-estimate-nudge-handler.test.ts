/**
 * RV-086 — send_estimate_nudge: contract schema, execution handler (send
 * path reuse + 48h cooldown refusal), action-class gating, and registry
 * wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import {
  SendEstimateNudgeExecutionHandler,
  createExecutionHandlerRegistry,
  ESTIMATE_NUDGE_COOLDOWN_MS,
} from '../../src/proposals/execution/handlers';
import {
  validateProposalPayload,
  sendEstimateNudgePayloadSchema,
} from '../../src/proposals/contracts';
import {
  VALID_PROPOSAL_TYPES,
  actionClassForProposalType,
  decideInitialStatus,
} from '../../src/proposals/proposal';
import type { Proposal } from '../../src/proposals/proposal';
import {
  Estimate,
  InMemoryEstimateRepository,
} from '../../src/estimates/estimate';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';
import type { SendService } from '../../src/notifications/send-service';

const TENANT = 't-1';
const ESTIMATE_ID = '3f9d1f2e-1111-4222-8333-444455556666';
const NOW = new Date('2026-06-10T18:00:00Z');

function makeEstimate(overrides: Partial<Estimate> = {}): Estimate {
  const lineItems: LineItem[] = [
    buildLineItem('li-1', 'Service call', 1, 15000, 0, true, 'labor'),
  ];
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

function makeProposal(payload: Record<string, unknown>): Proposal {
  return {
    id: 'prop-nudge-1',
    tenantId: TENANT,
    proposalType: 'send_estimate_nudge',
    status: 'approved',
    payload,
    summary: 'Nudge EST-0042',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeSendService(): Pick<SendService, 'sendEstimate'> & {
  sendEstimate: ReturnType<typeof vi.fn>;
} {
  return {
    sendEstimate: vi.fn().mockResolvedValue({
      estimateId: ESTIMATE_ID,
      viewUrl: 'https://x/e/tok',
      viewToken: 'tok',
      channelsSent: [
        { channel: 'sms', recipient: '+15550001111', provider: 'twilio', providerMessageId: 'SM1', dispatchId: 'd-1' },
      ],
    }),
  };
}

describe('send_estimate_nudge contract schema', () => {
  it('accepts a resolved estimateId with an optional note', () => {
    const result = validateProposalPayload('send_estimate_nudge', {
      estimateId: ESTIMATE_ID,
      note: 'Just checking in!',
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a free-text estimateReference (pre-resolution)', () => {
    const result = validateProposalPayload('send_estimate_nudge', {
      estimateReference: 'the Henderson water-heater estimate',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a payload with neither estimateId nor estimateReference', () => {
    const result = validateProposalPayload('send_estimate_nudge', { note: 'hi' });
    expect(result.valid).toBe(false);
    expect(result.errors!.join(' ')).toMatch(/estimateId or estimateReference/);
  });

  it('rejects a non-uuid estimateId', () => {
    expect(sendEstimateNudgePayloadSchema.safeParse({ estimateId: 'EST-0042' }).success).toBe(false);
  });

  it('is registered in VALID_PROPOSAL_TYPES', () => {
    expect(VALID_PROPOSAL_TYPES).toContain('send_estimate_nudge');
  });
});

describe('send_estimate_nudge action class (comms gate)', () => {
  it('classifies as comms', () => {
    expect(actionClassForProposalType('send_estimate_nudge')).toBe('comms');
  });

  it('never auto-approves, even autonomous + max confidence', () => {
    expect(
      decideInitialStatus({
        proposalType: 'send_estimate_nudge',
        sourceTrustTier: 'autonomous',
        confidenceScore: 1,
      }),
    ).toBe('draft');
  });
});

interface ClaimRow {
  status: 'claimed' | 'sent';
  claimedAt: number;
}

/** T4-F01 claim-aware fake pool — see test/estimates/estimate-nudge.test.ts for the same pattern. */
function claimAwarePool(claims: Map<string, ClaimRow> = new Map()): { pool: Pool; claims: Map<string, ClaimRow> } {
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (!sql.includes('send_claims')) return { rows: [], rowCount: 0 } as unknown as QueryResult;
    const key = `${params[0]}::${params[1]}`;
    if (sql.trim().startsWith('INSERT')) {
      const staleMinutes = Number(params[2]);
      const existing = claims.get(key);
      if (!existing) {
        claims.set(key, { status: 'claimed', claimedAt: Date.now() });
        return { rows: [{ claim_key: params[1] }], rowCount: 1 } as unknown as QueryResult;
      }
      const staleMs = staleMinutes * 60_000;
      if (existing.status === 'claimed' && Date.now() - existing.claimedAt >= staleMs) {
        existing.claimedAt = Date.now();
        return { rows: [{ claim_key: params[1] }], rowCount: 1 } as unknown as QueryResult;
      }
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    }
    if (sql.trim().startsWith('UPDATE')) {
      const existing = claims.get(key);
      if (existing) existing.status = 'sent';
      return { rows: [], rowCount: existing ? 1 : 0 } as unknown as QueryResult;
    }
    if (sql.trim().startsWith('DELETE')) {
      const existing = claims.get(key);
      if (existing?.status === 'claimed') claims.delete(key);
      return { rows: [], rowCount: 1 } as unknown as QueryResult;
    }
    return { rows: [], rowCount: 0 } as unknown as QueryResult;
  });
  return { pool: { query } as unknown as Pool, claims };
}

describe('SendEstimateNudgeExecutionHandler', () => {
  let estimateRepo: InMemoryEstimateRepository;
  let dispatchRepo: InMemoryDispatchRepository;
  let auditRepo: InMemoryAuditRepository;
  let sendService: ReturnType<typeof makeSendService>;
  let handler: SendEstimateNudgeExecutionHandler;

  beforeEach(async () => {
    estimateRepo = new InMemoryEstimateRepository();
    dispatchRepo = new InMemoryDispatchRepository();
    auditRepo = new InMemoryAuditRepository();
    sendService = makeSendService();
    await estimateRepo.create(makeEstimate());
    handler = new SendEstimateNudgeExecutionHandler(
      estimateRepo,
      sendService,
      dispatchRepo,
      auditRepo,
      () => NOW,
    );
  });

  it('re-sends the estimate via the shared send path and records the nudge', async () => {
    const result = await handler.execute(
      makeProposal({ estimateId: ESTIMATE_ID, note: 'Any questions?' }),
      { tenantId: TENANT, executedBy: 'owner-1' },
    );

    expect(result.success).toBe(true);
    expect(result.resultEntityId).toBe(ESTIMATE_ID);
    expect(sendService.sendEstimate).toHaveBeenCalledWith({
      tenantId: TENANT,
      estimateId: ESTIMATE_ID,
      channel: 'sms',
      customMessage: 'Any questions?',
    });

    const updated = await estimateRepo.findById(TENANT, ESTIMATE_ID);
    expect(updated!.reminderCount).toBe(1);
    expect(updated!.lastReminderAt).toEqual(NOW);

    const events = auditRepo.getAll();
    const nudgeEvent = events.find((e) => e.eventType === 'estimate.reminder_sent');
    expect(nudgeEvent).toBeDefined();
    expect(nudgeEvent!.entityId).toBe(ESTIMATE_ID);
    expect(nudgeEvent!.metadata).toMatchObject({ estimateNumber: 'EST-0042', reminderCount: 1 });
  });

  it('refuses (execution failure) when a dispatch for this estimate exists within 48h', async () => {
    await dispatchRepo.create({
      tenantId: TENANT,
      entityType: 'estimate',
      entityId: ESTIMATE_ID,
      channel: 'sms',
      recipient: '+15550001111',
      provider: 'twilio',
      status: 'sent',
    });

    const result = await handler.execute(makeProposal({ estimateId: ESTIMATE_ID }), {
      tenantId: TENANT,
      executedBy: 'owner-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Nudge refused/);
    expect(result.error).toMatch(/48h/);
    expect(sendService.sendEstimate).not.toHaveBeenCalled();
  });

  it('allows the nudge when the last dispatch is older than 48h', async () => {
    const old = await dispatchRepo.create({
      tenantId: TENANT,
      entityType: 'estimate',
      entityId: ESTIMATE_ID,
      channel: 'sms',
      recipient: '+15550001111',
      provider: 'twilio',
      status: 'sent',
    });
    // Reach into the in-memory row to backdate sentAt (the repo stamps now()).
    const rows = (dispatchRepo as unknown as { rows: Map<string, { sentAt: Date }> }).rows;
    rows.get(old.id)!.sentAt = new Date(NOW.getTime() - ESTIMATE_NUDGE_COOLDOWN_MS - 1);

    const result = await handler.execute(makeProposal({ estimateId: ESTIMATE_ID }), {
      tenantId: TENANT,
      executedBy: 'owner-1',
    });
    expect(result.success).toBe(true);
    expect(sendService.sendEstimate).toHaveBeenCalledTimes(1);
  });

  it('ignores failed dispatch rows for the cooldown', async () => {
    await dispatchRepo.create({
      tenantId: TENANT,
      entityType: 'estimate',
      entityId: ESTIMATE_ID,
      channel: 'sms',
      recipient: '+15550001111',
      provider: 'suppressed',
      status: 'failed',
      errorMessage: 'SMS suppressed: customer sms_consent is not granted',
    });
    const result = await handler.execute(makeProposal({ estimateId: ESTIMATE_ID }), {
      tenantId: TENANT,
      executedBy: 'owner-1',
    });
    expect(result.success).toBe(true);
  });

  it('ignores bounced dispatch rows for the cooldown (never reached the customer)', async () => {
    await dispatchRepo.create({
      tenantId: TENANT,
      entityType: 'estimate',
      entityId: ESTIMATE_ID,
      channel: 'sms',
      recipient: '+15550001111',
      provider: 'twilio',
      status: 'bounced',
      errorMessage: 'undeliverable',
    });
    const result = await handler.execute(makeProposal({ estimateId: ESTIMATE_ID }), {
      tenantId: TENANT,
      executedBy: 'owner-1',
    });
    expect(result.success).toBe(true);
    expect(sendService.sendEstimate).toHaveBeenCalledTimes(1);
  });

  it('fails-closed when estimateRepo/sendService are absent — returns FAILURE, never a synthetic success', async () => {
    const bare = new SendEstimateNudgeExecutionHandler(
      undefined,
      undefined,
      undefined,
      undefined,
      () => NOW,
    );
    const result = await bare.execute(makeProposal({ estimateId: ESTIMATE_ID }), {
      tenantId: TENANT,
      executedBy: 'owner-1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/send service not configured/);
  });

  it('belt-and-braces: lastReminderAt also blocks the nudge even when dispatch repo clears (both sources consulted)', async () => {
    // dispatchRepo has no recent rows, but lastReminderAt is recent — must still block.
    await estimateRepo.update(TENANT, ESTIMATE_ID, {
      reminderCount: 1,
      lastReminderAt: new Date(NOW.getTime() - 60 * 60 * 1000), // 1h ago — within 48h
    });
    const result = await handler.execute(makeProposal({ estimateId: ESTIMATE_ID }), {
      tenantId: TENANT,
      executedBy: 'owner-1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Nudge refused/);
    expect(sendService.sendEstimate).not.toHaveBeenCalled();
  });

  it('falls back to lastReminderAt for the cooldown when no dispatch repo is wired', async () => {
    await estimateRepo.update(TENANT, ESTIMATE_ID, {
      reminderCount: 1,
      lastReminderAt: new Date(NOW.getTime() - 60 * 60 * 1000), // 1h ago
    });
    handler = new SendEstimateNudgeExecutionHandler(
      estimateRepo,
      sendService,
      undefined,
      auditRepo,
      () => NOW,
    );
    const result = await handler.execute(makeProposal({ estimateId: ESTIMATE_ID }), {
      tenantId: TENANT,
      executedBy: 'owner-1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Nudge refused/);
  });

  it('rejects an unresolved estimateReference (no uuid)', async () => {
    const result = await handler.execute(
      makeProposal({ estimateReference: 'the Henderson estimate' }),
      { tenantId: TENANT, executedBy: 'owner-1' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/estimateId UUID/);
  });

  it('fails when the estimate is missing (or belongs to another tenant)', async () => {
    const result = await handler.execute(makeProposal({ estimateId: ESTIMATE_ID }), {
      tenantId: 'other-tenant',
      executedBy: 'owner-1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('refuses to nudge an estimate that is not in sent status', async () => {
    await estimateRepo.update(TENANT, ESTIMATE_ID, { status: 'accepted' });
    const result = await handler.execute(makeProposal({ estimateId: ESTIMATE_ID }), {
      tenantId: TENANT,
      executedBy: 'owner-1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/'accepted'/);
  });

  it('surfaces a send failure as an execution failure', async () => {
    sendService.sendEstimate.mockRejectedValueOnce(new Error('delivery provider failed'));
    const result = await handler.execute(makeProposal({ estimateId: ESTIMATE_ID }), {
      tenantId: TENANT,
      executedBy: 'owner-1',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('delivery provider failed');
  });

  describe('T4-F01 — claim-before-send collision', () => {
    it('refuses (execution failure, distinguishable message) when a concurrent attempt already claimed this reminder occurrence', async () => {
      const { pool, claims } = claimAwarePool();
      // Simulate the estimate-reminder sweep having already won the claim for
      // reminder #1 on this estimate moments earlier (still fresh — not stale).
      claims.set(`${TENANT}::estimate_nudge:${ESTIMATE_ID}:1`, {
        status: 'claimed',
        claimedAt: Date.now(),
      });
      const clashHandler = new SendEstimateNudgeExecutionHandler(
        estimateRepo,
        sendService,
        dispatchRepo,
        auditRepo,
        () => NOW,
        pool,
      );

      const result = await clashHandler.execute(makeProposal({ estimateId: ESTIMATE_ID }), {
        tenantId: TENANT,
        executedBy: 'owner-1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already in flight/);
      expect(sendService.sendEstimate).not.toHaveBeenCalled();
    });

    it('sends normally when the pool is wired and no concurrent claim exists', async () => {
      const { pool } = claimAwarePool();
      const clashHandler = new SendEstimateNudgeExecutionHandler(
        estimateRepo,
        sendService,
        dispatchRepo,
        auditRepo,
        () => NOW,
        pool,
      );

      const result = await clashHandler.execute(makeProposal({ estimateId: ESTIMATE_ID }), {
        tenantId: TENANT,
        executedBy: 'owner-1',
      });

      expect(result.success).toBe(true);
      expect(sendService.sendEstimate).toHaveBeenCalledTimes(1);
    });
  });
});

describe('registry wiring', () => {
  it('registers send_estimate_nudge in the execution handler registry', () => {
    const registry = createExecutionHandlerRegistry();
    expect(registry.get('send_estimate_nudge')).toBeInstanceOf(SendEstimateNudgeExecutionHandler);
  });
});
