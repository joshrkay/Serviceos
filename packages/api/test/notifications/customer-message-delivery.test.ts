/**
 * Unit tests for sendCustomerMessage — the sms_consent + DNC gates, the
 * independent email channel, the per-channel idempotency keys, and (T4-F01)
 * the claim-before-send gate + the no-longer-silent failure path (R5).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { sendCustomerMessage } from '../../src/notifications/customer-message-delivery';
import { InMemoryDeliveryProvider } from '../../src/notifications/delivery-provider';
import { GatedMessageDelivery } from '../../src/notifications/gated-message-delivery';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryDispatchRepository } from '../../src/notifications/dispatch-repository';
import { InMemoryDncRepository, normalizePhone } from '../../src/compliance/dnc';
import { Customer } from '../../src/customers/customer';
import type { Logger } from '../../src/logging/logger';

const TENANT = 'tenant-1';

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cust-1',
    tenantId: TENANT,
    firstName: 'Sam',
    lastName: 'Lee',
    displayName: 'Sam Lee',
    primaryPhone: '+15559876543',
    email: 'sam@example.com',
    preferredChannel: 'sms',
    smsConsent: true,
    isArchived: false,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeLogger(): Logger & {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger as unknown as Logger & typeof logger;
}

// WS1 — the consent/DNC gate now lives in the delivery wrapper. sendCustomerMessage
// is handed a GatedMessageDelivery (enforcement 'block') over the raw in-memory
// double; assertions still inspect the raw `delivery` (sentSms).
function makeDeps() {
  const delivery = new InMemoryDeliveryProvider();
  const dispatchRepo = new InMemoryDispatchRepository();
  const dncRepo = new InMemoryDncRepository();
  const logger = makeLogger();
  const gated = new GatedMessageDelivery({
    base: delivery,
    dnc: dncRepo,
    auditRepo: new InMemoryAuditRepository(),
    enforcement: 'block',
  });
  return {
    delivery,
    dispatchRepo,
    dncRepo,
    logger,
    sendDeps: { delivery: gated, dispatchRepo, pool: null, logger },
  };
}

interface ClaimRow {
  status: 'claimed' | 'sending' | 'sent';
  claimedAt: number;
}

/** T4-F01 claim-aware fake pool — see test/workers/thank-you-sms-worker.test.ts for the same pattern. */
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
      // Two distinct UPDATE shapes hit send_claims: the sending-transition
      // (markSendClaimSending) and the completion tombstone
      // (markSendClaimComplete) — distinguish by the literal SQL text so the
      // fake actually models the intermediate 'sending' state rather than
      // collapsing straight to 'sent'.
      if (existing) existing.status = sql.includes("'sending'") ? 'sending' : 'sent';
      return { rows: [], rowCount: existing ? 1 : 0 } as unknown as QueryResult;
    }
    if (sql.trim().startsWith('DELETE')) {
      const existing = claims.get(key);
      if (existing?.status === 'claimed' || existing?.status === 'sending') claims.delete(key);
      return { rows: [], rowCount: 1 } as unknown as QueryResult;
    }
    if (sql.trim().startsWith('SELECT')) {
      const existing = claims.get(key);
      return {
        rows: existing ? [{ status: existing.status }] : [],
        rowCount: existing ? 1 : 0,
      } as unknown as QueryResult;
    }
    return { rows: [], rowCount: 0 } as unknown as QueryResult;
  });
  return { pool: { query } as unknown as Pool, claims };
}

const baseInput = {
  tenantId: TENANT,
  entityType: 'estimate' as const,
  entityId: 'est-1',
  smsBody: 'Your estimate is ready',
  emailSubject: 'Estimate ready',
  emailText: 'Your estimate is ready',
  idempotencyKeyPrefix: 'estimate:est-1:send',
};

describe('sendCustomerMessage — both channels', () => {
  it('sends SMS + email and logs a dispatch row each with channel-specific idempotency keys', async () => {
    const deps = makeDeps();
    await sendCustomerMessage(deps.sendDeps, {
      ...baseInput,
      customer: makeCustomer(),
      channels: ['sms', 'email'],
    });

    expect(deps.delivery.sentSms).toHaveLength(1);
    expect(deps.delivery.sentEmails).toHaveLength(1);

    const smsRows = await deps.dispatchRepo.findByEntity(TENANT, 'estimate', 'est-1');
    const keys = smsRows.map((r) => r.idempotencyKey).sort();
    expect(keys).toEqual(['estimate:est-1:send:email', 'estimate:est-1:send:sms']);
    expect(smsRows.every((r) => r.status === 'sent')).toBe(true);
  });
});

describe('sendCustomerMessage — SMS consent + DNC gates', () => {
  it('skips SMS (no row) when smsConsent is false but still sends email', async () => {
    const deps = makeDeps();
    await sendCustomerMessage(deps.sendDeps, {
      ...baseInput,
      customer: makeCustomer({ smsConsent: false }),
      channels: ['sms', 'email'],
    });

    expect(deps.delivery.sentSms).toHaveLength(0);
    expect(deps.delivery.sentEmails).toHaveLength(1);
    const rows = await deps.dispatchRepo.findByEntity(TENANT, 'estimate', 'est-1');
    expect(rows.map((r) => r.channel)).toEqual(['email']);
  });

  it('skips SMS (no row) when the number is on the DNC list, and logs the suppression at info (not silent, not a warn)', async () => {
    const deps = makeDeps();
    await deps.dncRepo.addToDnc(TENANT, normalizePhone('+15559876543'), 'test');
    await sendCustomerMessage(deps.sendDeps, {
      ...baseInput,
      customer: makeCustomer(),
      channels: ['sms'],
    });
    expect(deps.delivery.sentSms).toHaveLength(0);
    expect(await deps.dispatchRepo.findByEntity(TENANT, 'estimate', 'est-1')).toHaveLength(0);
    expect(deps.logger.info).toHaveBeenCalledWith(
      'Customer SMS suppressed by the consent/DNC gate',
      expect.objectContaining({ tenantId: TENANT, channel: 'sms' }),
    );
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it('skips SMS when the customer has no primary phone', async () => {
    const deps = makeDeps();
    await sendCustomerMessage(deps.sendDeps, {
      ...baseInput,
      customer: makeCustomer({ primaryPhone: undefined }),
      channels: ['sms'],
    });
    expect(deps.delivery.sentSms).toHaveLength(0);
  });
});

describe('sendCustomerMessage — email requirements', () => {
  it('skips email when the customer has no email address', async () => {
    const deps = makeDeps();
    await sendCustomerMessage(deps.sendDeps, {
      ...baseInput,
      customer: makeCustomer({ email: undefined }),
      channels: ['email'],
    });
    expect(deps.delivery.sentEmails).toHaveLength(0);
  });

  it('does not send a channel that was not requested', async () => {
    const deps = makeDeps();
    await sendCustomerMessage(deps.sendDeps, {
      ...baseInput,
      customer: makeCustomer(),
      channels: ['sms'],
    });
    expect(deps.delivery.sentSms).toHaveLength(1);
    expect(deps.delivery.sentEmails).toHaveLength(0);
  });
});

describe('sendCustomerMessage — no-longer-silent failure path (R5)', () => {
  it('a genuine provider error is caught, logged as a warn, and the function still resolves (never blocks the caller)', async () => {
    const deps = makeDeps();
    vi.spyOn(deps.delivery, 'sendSms').mockRejectedValueOnce(new Error('Twilio 500'));

    // A provider error is caught (never blocks the caller); the result reports
    // no eligibility suppression (this was a send FAILURE, not a suppression).
    await expect(
      sendCustomerMessage(deps.sendDeps, {
        ...baseInput,
        customer: makeCustomer(),
        channels: ['sms'],
      }),
    ).resolves.toEqual({ eligibilitySuppressed: false });

    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Customer message send failed',
      expect.objectContaining({ tenantId: TENANT, channel: 'sms', error: 'Twilio 500' }),
    );
    expect(await deps.dispatchRepo.findByEntity(TENANT, 'estimate', 'est-1')).toHaveLength(0);
  });
});

describe('sendCustomerMessage — T4-F01 claim-before-send', () => {
  it('crash-between-claim-and-send recovery: a stale claim is reclaimed and the send + dispatch row proceed', async () => {
    const deps = makeDeps();
    const { pool, claims } = claimAwarePool();
    claims.set(`${TENANT}::estimate:est-1:send:sms`, {
      status: 'claimed',
      claimedAt: Date.now() - 20 * 60_000,
    });

    await sendCustomerMessage(
      { ...deps.sendDeps, pool },
      { ...baseInput, customer: makeCustomer(), channels: ['sms'] },
    );

    expect(deps.delivery.sentSms).toHaveLength(1);
    const rows = await deps.dispatchRepo.findByEntity(TENANT, 'estimate', 'est-1');
    expect(rows).toHaveLength(1);
  });

  it('crash-between-send-and-mark: a "sent" claim with no dispatch row is NOT resent, and warns about the inconsistency', async () => {
    const deps = makeDeps();
    const { pool, claims } = claimAwarePool();
    claims.set(`${TENANT}::estimate:est-1:send:sms`, { status: 'sent', claimedAt: Date.now() });

    await sendCustomerMessage(
      { ...deps.sendDeps, pool },
      { ...baseInput, customer: makeCustomer(), channels: ['sms'] },
    );

    expect(deps.delivery.sentSms).toHaveLength(0);
    expect(await deps.dispatchRepo.findByEntity(TENANT, 'estimate', 'est-1')).toHaveLength(0);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/claim is "sent" but no dispatch row exists/),
      expect.objectContaining({ tenantId: TENANT, channel: 'sms' }),
    );
  });

  it('in-flight "claimed" loser logs info, never the crash warning (review: false-positive race)', async () => {
    const deps = makeDeps();
    const { pool, claims } = claimAwarePool();
    // Fresh claim held by a concurrent process — its dispatch row doesn't
    // exist yet, which must NOT be read as a crash inconsistency.
    claims.set(`${TENANT}::estimate:est-1:send:sms`, { status: 'claimed', claimedAt: Date.now() });

    await sendCustomerMessage(
      { ...deps.sendDeps, pool },
      { ...baseInput, customer: makeCustomer(), channels: ['sms'] },
    );

    expect(deps.delivery.sentSms).toHaveLength(0);
    expect(deps.logger.warn).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/held by another in-flight send/),
      expect.objectContaining({ tenantId: TENANT, channel: 'sms' }),
    );
  });

  it('in-flight "sending" loser (post-send-crash fix) logs info, never the crash warning', async () => {
    const deps = makeDeps();
    const { pool, claims } = claimAwarePool();
    // A racing process already flipped the claim to 'sending' — a provider
    // call may be in flight or may have crashed mid-flight. Either way this
    // is the ledger working as designed, not the "sent, no dispatch row"
    // crash-inconsistency case, so it must land in the same info bucket as
    // a 'claimed' loser, never the warn.
    claims.set(`${TENANT}::estimate:est-1:send:sms`, { status: 'sending', claimedAt: Date.now() });

    await sendCustomerMessage(
      { ...deps.sendDeps, pool },
      { ...baseInput, customer: makeCustomer(), channels: ['sms'] },
    );

    expect(deps.delivery.sentSms).toHaveLength(0);
    expect(deps.logger.warn).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/held by another in-flight send/),
      expect.objectContaining({ tenantId: TENANT, channel: 'sms' }),
    );
  });

  it('concurrent calls with the same idempotencyKeyPrefix: exactly one send', async () => {
    const deps = makeDeps();
    const { pool } = claimAwarePool();
    const send = () =>
      sendCustomerMessage(
        { ...deps.sendDeps, pool },
        { ...baseInput, customer: makeCustomer(), channels: ['sms'] },
      );

    await Promise.all([send(), send()]);
    expect(deps.delivery.sentSms).toHaveLength(1);
  });

  it('a provider throw releases the claim so an immediate retry can send', async () => {
    const deps = makeDeps();
    const { pool, claims } = claimAwarePool();
    vi.spyOn(deps.delivery, 'sendSms').mockRejectedValueOnce(new Error('Twilio 503'));

    await sendCustomerMessage(
      { ...deps.sendDeps, pool },
      { ...baseInput, customer: makeCustomer(), channels: ['sms'] },
    );
    expect(deps.delivery.sentSms).toHaveLength(0);
    expect(claims.has(`${TENANT}::estimate:est-1:send:sms`)).toBe(false);

    await sendCustomerMessage(
      { ...deps.sendDeps, pool },
      { ...baseInput, customer: makeCustomer(), channels: ['sms'] },
    );
    expect(deps.delivery.sentSms).toHaveLength(1);
  });

  describe('Codex P1 #2 — post-provider-acceptance bookkeeping failure must NOT release the claim', () => {
    it('provider send succeeds but the dispatch-row write throws: the SMS is not resent, the claim ends "sent", and the failure is logged (not swallowed as a generic send failure)', async () => {
      const deps = makeDeps();
      const { pool, claims } = claimAwarePool();
      vi.spyOn(deps.dispatchRepo, 'create').mockRejectedValueOnce(new Error('db down'));

      await sendCustomerMessage(
        { ...deps.sendDeps, pool },
        { ...baseInput, customer: makeCustomer(), channels: ['sms'] },
      );

      // The provider call genuinely went out...
      expect(deps.delivery.sentSms).toHaveLength(1);
      // ...the claim is finalized 'sent', NOT released...
      expect(claims.get(`${TENANT}::estimate:est-1:send:sms`)?.status).toBe('sent');
      // ...and the bookkeeping failure is logged distinctly from a provider failure.
      expect(deps.logger.warn).toHaveBeenCalledWith(
        'Customer message sent but the dispatch-row write failed',
        expect.objectContaining({ tenantId: TENANT, channel: 'sms' }),
      );
      expect(deps.logger.warn).not.toHaveBeenCalledWith(
        'Customer message send failed',
        expect.anything(),
      );

      // A second invocation with the SAME idempotency prefix must be a clean
      // duplicate no-op — never a resend — because the claim already ended 'sent'.
      await sendCustomerMessage(
        { ...deps.sendDeps, pool },
        { ...baseInput, customer: makeCustomer(), channels: ['sms'] },
      );
      expect(deps.delivery.sentSms).toHaveLength(1); // still just the one send
    });
  });
});

describe('sendCustomerMessage — Codex P1 #1: per-occurrence claim keys', () => {
  it('two sends with DISTINCT idempotencyKeyPrefix values (e.g. per-paymentId / per-reminder-occurrence) both go out', async () => {
    const deps = makeDeps();
    const { pool } = claimAwarePool();

    await sendCustomerMessage(
      { ...deps.sendDeps, pool },
      {
        ...baseInput,
        idempotencyKeyPrefix: 'payment-receipt:inv-1:pay-AAA',
        customer: makeCustomer(),
        channels: ['sms'],
      },
    );
    await sendCustomerMessage(
      { ...deps.sendDeps, pool },
      {
        ...baseInput,
        idempotencyKeyPrefix: 'payment-receipt:inv-1:pay-BBB',
        customer: makeCustomer(),
        channels: ['sms'],
      },
    );

    // Distinct occurrence tokens (different paymentIds on the SAME invoice) —
    // both are legitimate, independent sends and neither is suppressed by the
    // other's tombstone.
    expect(deps.delivery.sentSms).toHaveLength(2);
  });

  it('two sends with the SAME idempotencyKeyPrefix dedupe — the second is a no-op', async () => {
    const deps = makeDeps();
    const { pool } = claimAwarePool();

    await sendCustomerMessage(
      { ...deps.sendDeps, pool },
      {
        ...baseInput,
        idempotencyKeyPrefix: 'invoice-overdue:inv-1:3:sms',
        customer: makeCustomer(),
        channels: ['sms'],
      },
    );
    await sendCustomerMessage(
      { ...deps.sendDeps, pool },
      {
        ...baseInput,
        idempotencyKeyPrefix: 'invoice-overdue:inv-1:3:sms',
        customer: makeCustomer(),
        channels: ['sms'],
      },
    );

    expect(deps.delivery.sentSms).toHaveLength(1);
  });
});
