/**
 * #1238 — the queue-driven retry for the tenant PIN-lock owner alert. It
 * re-sends only while the claim is unsent, schedules its own bounded
 * continuation before sending, and audits each attempt.
 */
import { describe, it, expect } from 'vitest';
import { createPinLockAlertRetryWorker, createPinLockAlertRetryScheduler } from '../../src/workers/pin-lock-alert-retry';
import { InMemoryVoiceApprovalPinLockAlertRepository } from '../../src/settings/voice-approval-pin-lock-alert';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { QueueMessage } from '../../src/queues/queue';

const TENANT = 't-alert-retry';
const OWNER_PHONE = '+15125550100';
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

function harness(opts: { sendFails?: boolean; ownerPhone?: string | null } = {}) {
  const alertRepo = new InMemoryVoiceApprovalPinLockAlertRepository();
  const auditRepo = new InMemoryAuditRepository();
  const sent: Array<{ to: string; body: string }> = [];
  const enqueued: Array<{ type: string; payload: unknown; key?: string; delaySeconds?: number }> = [];
  const worker = createPinLockAlertRetryWorker({
    queue: {
      send: async (type: string, payload: unknown, key?: string, o?: { delaySeconds?: number }) => {
        enqueued.push({ type, payload, key, delaySeconds: o?.delaySeconds });
        return 'q';
      },
    },
    alertRepo,
    auditRepo,
    sendSms: async (to, body) => {
      if (opts.sendFails) throw new Error('sms provider down');
      sent.push({ to, body });
    },
    resolveOwnerPhone: async () => (opts.ownerPhone === undefined ? OWNER_PHONE : opts.ownerPhone),
  });
  const run = (attempt: number) =>
    worker.handle(
      {
        id: 'm',
        type: worker.type,
        payload: { tenantId: TENANT, episodeKey: 'ep-1', strikeCount: 5, attempt },
        attempts: 0,
        maxAttempts: 3,
        idempotencyKey: 'k',
        createdAt: new Date().toISOString(),
      } as QueueMessage<unknown>,
      silent,
    );
  return { alertRepo, auditRepo, sent, enqueued, run };
}

describe('#1238 — PIN-lock alert retry worker', () => {
  it('an unsent claim: sends the link-free alert to the owner and stamps the claim sent', async () => {
    const h = harness();
    await h.alertRepo.claim({ tenantId: TENANT, episodeKey: 'ep-1', strikeCount: 5 });
    await h.run(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.to).toBe(OWNER_PHONE);
    expect(h.sent[0]!.body).toContain('locked');
    expect(h.sent[0]!.body).not.toMatch(/https?:\/\//);
    expect(await h.alertRepo.isSent(TENANT, 'ep-1')).toBe(true);
  });

  it('an already-sent claim: sends nothing and schedules nothing', async () => {
    const h = harness();
    await h.alertRepo.claim({ tenantId: TENANT, episodeKey: 'ep-1', strikeCount: 5 });
    await h.alertRepo.markSent(TENANT, 'ep-1');
    await h.run(1);
    expect(h.sent).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it('a send that fails again: the claim stays unsent and the NEXT attempt is scheduled (10 min later)', async () => {
    const h = harness({ sendFails: true });
    await h.alertRepo.claim({ tenantId: TENANT, episodeKey: 'ep-1', strikeCount: 5 });
    await h.run(1);
    expect(await h.alertRepo.isSent(TENANT, 'ep-1')).toBe(false);
    expect(h.enqueued).toEqual([
      {
        type: 'voice_approval.pin_lock_alert_retry',
        payload: { tenantId: TENANT, episodeKey: 'ep-1', strikeCount: 5, attempt: 2 },
        key: `pin_lock_alert_retry:${TENANT}:ep-1:2`,
        delaySeconds: 600,
      },
    ]);
  });

  it('the LAST attempt failing schedules nothing more and is audited as exhausted; a success is audited as sent', async () => {
    const failing = harness({ ownerPhone: null });
    await failing.alertRepo.claim({ tenantId: TENANT, episodeKey: 'ep-1', strikeCount: 5 });
    await failing.run(5);
    expect(failing.enqueued).toEqual([]);
    const [gaveUp] = await failing.auditRepo.findByEntity(TENANT, 'voice_approval_pin_lock_alert', 'ep-1');
    expect(gaveUp).toMatchObject({
      eventType: 'proposal.voice_approval_tenant_lock_alert_retried',
      metadata: { attempt: 5, smsSent: false, exhausted: true },
    });

    const ok = harness();
    await ok.alertRepo.claim({ tenantId: TENANT, episodeKey: 'ep-1', strikeCount: 5 });
    await ok.run(2);
    const [sentEvent] = await ok.auditRepo.findByEntity(TENANT, 'voice_approval_pin_lock_alert', 'ep-1');
    expect(sentEvent!.metadata).toMatchObject({ attempt: 2, smsSent: true, exhausted: false });
  });

  it('the production scheduler enqueues attempt 1 two minutes out, keyed per attempt', async () => {
    const calls: unknown[][] = [];
    const scheduler = createPinLockAlertRetryScheduler({
      send: async (...args: unknown[]) => {
        calls.push(args);
        return 'q';
      },
    } as never);
    await scheduler.schedule({ tenantId: TENANT, episodeKey: 'ep-1', strikeCount: 5, attempt: 1 });
    expect(calls).toEqual([
      [
        'voice_approval.pin_lock_alert_retry',
        { tenantId: TENANT, episodeKey: 'ep-1', strikeCount: 5, attempt: 1 },
        `pin_lock_alert_retry:${TENANT}:ep-1:1`,
        { delaySeconds: 120 },
      ],
    ]);
  });
});
