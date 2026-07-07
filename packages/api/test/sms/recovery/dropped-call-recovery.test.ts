import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLogger } from '../../../src/logging/logger';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import {
  DroppedCallScheduler,
  InMemoryDroppedCallRecoveryRepository,
  PgDroppedCallRecoveryRepository,
  RECOVERY_DELAY_MS,
  type DroppedCallRecoveryRow,
} from '../../../src/sms/recovery/scheduler';
import {
  handleDroppedCallRecovery,
  type DroppedCallHandlerDeps,
} from '../../../src/sms/recovery/dropped-call-handler';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });
const TENANT = '00000000-0000-0000-0000-000000000001';
const SESSION = '00000000-0000-0000-0000-0000000000aa';
const E164 = '+15551234567';
const T0 = new Date('2026-05-21T12:00:00Z');

function freshHandlerDeps(
  repo: InMemoryDroppedCallRecoveryRepository,
  audit: InMemoryAuditRepository,
  overrides: Partial<DroppedCallHandlerDeps> = {},
): DroppedCallHandlerDeps {
  return {
    repo,
    audit,
    logger,
    rateLimit: { check: vi.fn(async () => true), record: vi.fn(async () => undefined) },
    resolvedSince: vi.fn(async () => null),
    compose: vi.fn(async ({ contextCue }) =>
      contextCue ? `${contextCue} — want to text or call back? We're here.` : 'Sorry we got cut off — text us back anytime.',
    ),
    sendSms: vi.fn(async () => 'SM_fake_sid'),
    now: () => T0,
    ...overrides,
  };
}

async function seedDueRow(
  repo: InMemoryDroppedCallRecoveryRepository,
): Promise<DroppedCallRecoveryRow> {
  return repo.schedule({
    tenantId: TENANT,
    voiceSessionId: SESSION,
    callerE164: E164,
    scheduledFor: new Date(T0.getTime() - 1),
  });
}

describe('P8-015 dropped-call recovery scheduler', () => {
  it('schedules a durable row 60s out for a dropped inbound call (queue, not setTimeout)', async () => {
    const repo = new InMemoryDroppedCallRecoveryRepository();
    const scheduler = new DroppedCallScheduler(repo, logger, () => T0);
    const row = await scheduler.schedule({
      tenantId: TENANT,
      voiceSessionId: SESSION,
      callerE164: E164,
      outcome: 'dropped',
      channel: 'voice_inbound',
    });
    expect(row).not.toBeNull();
    expect(row!.scheduledFor.getTime()).toBe(T0.getTime() + RECOVERY_DELAY_MS);
    expect(repo.rows).toHaveLength(1);
  });

  it('does NOT schedule for a successful booking (completed)', async () => {
    const repo = new InMemoryDroppedCallRecoveryRepository();
    const scheduler = new DroppedCallScheduler(repo, logger, () => T0);
    const row = await scheduler.schedule({
      tenantId: TENANT,
      voiceSessionId: SESSION,
      callerE164: E164,
      outcome: 'completed',
      channel: 'voice_inbound',
    });
    expect(row).toBeNull();
    expect(repo.rows).toHaveLength(0);
  });

  it('is idempotent per (tenant, voice_session) — a duplicate finalize schedules once', async () => {
    const repo = new InMemoryDroppedCallRecoveryRepository();
    const scheduler = new DroppedCallScheduler(repo, logger, () => T0);
    await scheduler.schedule({ tenantId: TENANT, voiceSessionId: SESSION, callerE164: E164, outcome: 'dropped', channel: 'voice_inbound' });
    await scheduler.schedule({ tenantId: TENANT, voiceSessionId: SESSION, callerE164: E164, outcome: 'dropped', channel: 'voice_inbound' });
    expect(repo.rows).toHaveLength(1);
  });
});

describe('PgDroppedCallRecoveryRepository.listUnansweredRecoveries', () => {
  it('reads sent unsuppressed rows for one tenant, newest first, limit 10', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id, tenant_id, voice_session_id')) {
        return {
          rows: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              tenant_id: tenantId,
              voice_session_id: '33333333-3333-4333-8333-333333333333',
              caller_e164: '+15125550100',
              scheduled_for: '2026-06-11T10:00:00.000Z',
              sent_at: '2026-06-11T10:01:00.000Z',
              suppressed_reason: null,
              sms_message_sid: 'SM1',
              context: null,
              created_at: '2026-06-11T10:00:00.000Z',
            },
          ],
        };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    };
    const repo = new PgDroppedCallRecoveryRepository(pool as never);

    const rows = await repo.listUnansweredRecoveries(tenantId);

    expect(rows).toHaveLength(1);
    const selectCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM dropped_call_recoveries'),
    );
    expect(selectCall).toBeTruthy();
    expect(String(selectCall?.[0])).toContain(
      "tenant_id = current_setting('app.current_tenant_id')::uuid",
    );
    expect(String(selectCall?.[0])).toContain('sent_at IS NOT NULL');
    expect(String(selectCall?.[0])).toContain('suppressed_reason IS NULL');
    expect(String(selectCall?.[0])).toContain('ORDER BY sent_at DESC, created_at DESC');
    expect(selectCall?.[1]).toEqual([10]);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('P8-015 dropped-call recovery orchestrator', () => {
  let repo: InMemoryDroppedCallRecoveryRepository;
  let audit: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryDroppedCallRecoveryRepository();
    audit = new InMemoryAuditRepository();
  });

  it('hangup before booking → SMS sent within the deferred window', async () => {
    const row = await seedDueRow(repo);
    const deps = freshHandlerDeps(repo, audit);
    const result = await handleDroppedCallRecovery(row, deps);
    expect(result).toEqual({ action: 'sent', smsMessageSid: 'SM_fake_sid' });
    expect(deps.sendSms).toHaveBeenCalledTimes(1);
    expect(repo.rows[0].sentAt).toBeTruthy();
  });

  it('successful booking since the drop → no SMS (suppressed booking_completed)', async () => {
    const row = await seedDueRow(repo);
    const deps = freshHandlerDeps(repo, audit, {
      resolvedSince: vi.fn(async () => 'booking_completed' as const),
    });
    const result = await handleDroppedCallRecovery(row, deps);
    expect(result).toEqual({ action: 'suppressed', reason: 'booking_completed' });
    expect(deps.sendSms).not.toHaveBeenCalled();
    expect(repo.rows[0].suppressedReason).toBe('booking_completed');
  });

  it('preSendSuppress (DNC gate) suppresses with its reason and never sends', async () => {
    const row = await seedDueRow(repo);
    const deps = freshHandlerDeps(repo, audit, {
      preSendSuppress: vi.fn(async () => 'opted_out'),
    });
    const result = await handleDroppedCallRecovery(row, deps);
    expect(result).toEqual({ action: 'suppressed', reason: 'opted_out' });
    expect(deps.sendSms).not.toHaveBeenCalled();
    expect(repo.rows[0].suppressedReason).toBe('opted_out');
    // Audit trail carries the compliance reason like every other suppression.
    const suppressedEvent = audit.events.find(
      (e) => e.eventType === 'dropped_call_recovery.suppressed',
    );
    expect(suppressedEvent?.metadata?.reason).toBe('opted_out');
  });

  it('preSendSuppress runs AFTER resolvedSince and BEFORE the rate limit', async () => {
    const callOrder: string[] = [];
    const row = await seedDueRow(repo);
    const deps = freshHandlerDeps(repo, audit, {
      resolvedSince: vi.fn(async () => {
        callOrder.push('resolvedSince');
        return null;
      }),
      preSendSuppress: vi.fn(async () => {
        callOrder.push('preSendSuppress');
        return null;
      }),
      rateLimit: {
        check: vi.fn(async () => {
          callOrder.push('rateLimit.check');
          return true;
        }),
        record: vi.fn(async () => undefined),
      },
    });
    await handleDroppedCallRecovery(row, deps);
    expect(callOrder).toEqual(['resolvedSince', 'preSendSuppress', 'rateLimit.check']);
  });

  it('resolvedSince receives the row context (proposalIds reachable by production checker)', async () => {
    const resolvedSince = vi.fn(async () => null);
    const row = await repo.schedule({
      tenantId: TENANT,
      voiceSessionId: SESSION,
      callerE164: E164,
      scheduledFor: new Date(T0.getTime() - 1),
      context: { state: 'collecting', bucket: 'proposal_created', proposalIds: ['p-9'] },
    });
    const deps = freshHandlerDeps(repo, audit, { resolvedSince });
    await handleDroppedCallRecovery(row, deps);
    expect(resolvedSince).toHaveBeenCalledWith(
      TENANT,
      SESSION,
      expect.objectContaining({ proposalIds: ['p-9'] }),
    );
  });

  it('audio failure mid-call → SMS sent', async () => {
    // A "failed" outcome row reaches the worker the same way; the handler
    // re-checks suppression + rate limit and sends.
    const row = await repo.schedule({
      tenantId: TENANT,
      voiceSessionId: SESSION,
      callerE164: E164,
      scheduledFor: new Date(T0.getTime() - 1),
    });
    const deps = freshHandlerDeps(repo, audit);
    const result = await handleDroppedCallRecovery(row, deps);
    expect(result.action).toBe('sent');
    expect(deps.sendSms).toHaveBeenCalledTimes(1);
  });

  it('partial transcript context cue is included when a top intent is available', async () => {
    const row = await seedDueRow(repo);
    const deps = freshHandlerDeps(repo, audit, {
      topIntentFor: vi.fn(async () => 'ac_repair'),
    });
    await handleDroppedCallRecovery(row, deps);
    const composeArg = (deps.compose as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(composeArg.contextCue).toBe('Sounds like you were calling about your AC');
    const sentBody = (deps.sendSms as ReturnType<typeof vi.fn>).mock.calls[0][0].body;
    expect(sentBody).toContain('Sounds like you were calling about your AC');
  });

  it('no transcript / intent → generic SMS (empty context cue)', async () => {
    const row = await seedDueRow(repo);
    const deps = freshHandlerDeps(repo, audit, {
      topIntentFor: vi.fn(async () => undefined),
    });
    await handleDroppedCallRecovery(row, deps);
    const composeArg = (deps.compose as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(composeArg.contextCue).toBe('');
  });

  it('threads the recovery — links voice_session and sms_conversation to one conversation', async () => {
    const row = await seedDueRow(repo);
    const thread = vi.fn(async () => undefined);
    const deps = freshHandlerDeps(repo, audit, { thread });
    await handleDroppedCallRecovery(row, deps);
    expect(thread).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        voiceSessionId: SESSION,
        smsMessageSid: 'SM_fake_sid',
        callerE164: E164,
        body: expect.stringContaining('cut off'),
      }),
    );
  });

  it('rate-limited — a caller who keeps dropping gets ONE SMS, not multiple', async () => {
    // First recovery: allowed.
    const first = await seedDueRow(repo);
    const check = vi
      .fn<[string, string], Promise<boolean>>()
      .mockResolvedValueOnce(true) // first within window
      .mockResolvedValue(false); // subsequent within window
    const deps = freshHandlerDeps(repo, audit, {
      rateLimit: { check, record: vi.fn(async () => undefined) },
    });
    const r1 = await handleDroppedCallRecovery(first, deps);
    expect(r1.action).toBe('sent');

    // Second drop from same caller within 5 min → different session row.
    const second = await repo.schedule({
      tenantId: TENANT,
      voiceSessionId: '00000000-0000-0000-0000-0000000000bb',
      callerE164: E164,
      scheduledFor: new Date(T0.getTime() - 1),
    });
    const r2 = await handleDroppedCallRecovery(second, deps);
    expect(r2).toEqual({ action: 'suppressed', reason: 'rate_limited' });
    expect((deps.sendSms as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('a failed send does NOT burn the rate-limit token (check before send, record after)', async () => {
    const row = await seedDueRow(repo);
    const check = vi.fn(async () => true);
    const record = vi.fn(async () => undefined);
    const sendSms = vi
      .fn<[unknown], Promise<string>>()
      .mockRejectedValueOnce(new Error('twilio 503')) // transient failure
      .mockResolvedValue('SM_after_retry');
    const deps = freshHandlerDeps(repo, audit, {
      rateLimit: { check, record },
      sendSms,
    });

    // First drain: send throws and propagates so the worker leaves the row
    // pending. Crucially the token was NOT recorded (record only runs on a
    // successful send), so the retry below is not suppressed as rate_limited.
    await expect(handleDroppedCallRecovery(row, deps)).rejects.toThrow('twilio 503');
    expect(record).not.toHaveBeenCalled();

    // Retry: check still allows, send succeeds, token recorded once.
    const r2 = await handleDroppedCallRecovery(row, deps);
    expect(r2).toEqual({ action: 'sent', smsMessageSid: 'SM_after_retry' });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('uses an idempotency key derived from the recovery row id (no double-send on retry)', async () => {
    const row = await seedDueRow(repo);
    const deps = freshHandlerDeps(repo, audit);
    await handleDroppedCallRecovery(row, deps);
    const sendArg = (deps.sendSms as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sendArg.idempotencyKey).toBe(`dropped_call_recovery:${row.id}`);
  });
});
