import { describe, it, expect, beforeEach } from 'vitest';
import { createPushNotificationWorker } from '../../src/workers/push-notification-worker';
import { InMemoryDeviceTokenRepository } from '../../src/devices/device-token-repository';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { Logger } from '../../src/logging/logger';
import { QueueMessage } from '../../src/queues/queue';
import { PUSH_NOTIFICATION_JOB_TYPE, PushNotificationJob } from '@ai-service-os/shared';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

function jobMsg(payload: PushNotificationJob): QueueMessage<PushNotificationJob> {
  return {
    id: 'm1',
    type: PUSH_NOTIFICATION_JOB_TYPE,
    payload,
    attempts: 1,
    maxAttempts: 3,
    idempotencyKey: 'idem-1',
    createdAt: new Date().toISOString(),
  };
}

describe('push-notification-worker', () => {
  let repo: InMemoryDeviceTokenRepository;
  let audit: InMemoryAuditRepository;

  beforeEach(() => {
    repo = new InMemoryDeviceTokenRepository();
    audit = new InMemoryAuditRepository();
  });

  it('sends to all of the tenant devices and writes a system-actor audit', async () => {
    await repo.register({ tenantId: TENANT_A, userId: 'u1', platform: 'ios', token: 'tok-1' });
    await repo.register({ tenantId: TENANT_A, userId: 'u2', platform: 'android', token: 'tok-2' });
    const provider = new InMemoryPushDeliveryProvider();
    const worker = createPushNotificationWorker({ deviceTokenRepo: repo, pushProvider: provider, auditRepo: audit });

    await worker.handle(jobMsg({ tenantId: TENANT_A, title: 'Hi', body: 'Job assigned' }), noopLogger);

    expect(provider.sent.map((s) => s.token).sort()).toEqual(['tok-1', 'tok-2']);
    const events = audit.getAll();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('push.sent');
    expect(events[0].actorId).toBe('system');
    expect(events[0].actorRole).toBe('system');
    expect(events[0].metadata).toMatchObject({ recipients: 2, delivered: 2, pruned: 0, failures: 0 });
  });

  it('narrows the send to a single user when userId is set', async () => {
    await repo.register({ tenantId: TENANT_A, userId: 'u1', platform: 'ios', token: 'tok-1' });
    await repo.register({ tenantId: TENANT_A, userId: 'u2', platform: 'android', token: 'tok-2' });
    const provider = new InMemoryPushDeliveryProvider();
    const worker = createPushNotificationWorker({ deviceTokenRepo: repo, pushProvider: provider, auditRepo: audit });

    await worker.handle(jobMsg({ tenantId: TENANT_A, userId: 'u1', title: 'Hi', body: 'b' }), noopLogger);

    expect(provider.sent.map((s) => s.token)).toEqual(['tok-1']);
  });

  it('prunes a token the provider reports as unregistered', async () => {
    await repo.register({ tenantId: TENANT_A, userId: 'u1', platform: 'ios', token: 'dead' });
    await repo.register({ tenantId: TENANT_A, userId: 'u1', platform: 'ios', token: 'live' });
    const provider = new InMemoryPushDeliveryProvider(new Set(['dead']));
    const worker = createPushNotificationWorker({ deviceTokenRepo: repo, pushProvider: provider, auditRepo: audit });

    await worker.handle(jobMsg({ tenantId: TENANT_A, title: 'Hi', body: 'b' }), noopLogger);

    const remaining = await repo.listByTenant(TENANT_A);
    expect(remaining.map((r) => r.token)).toEqual(['live']);
    expect(audit.getAll()[0].metadata).toMatchObject({ pruned: 1, delivered: 1 });
  });

  it('no-ops (no send, no audit) when the tenant has no devices', async () => {
    const provider = new InMemoryPushDeliveryProvider();
    const worker = createPushNotificationWorker({ deviceTokenRepo: repo, pushProvider: provider, auditRepo: audit });

    await worker.handle(jobMsg({ tenantId: TENANT_A, title: 'Hi', body: 'b' }), noopLogger);

    expect(provider.sent).toHaveLength(0);
    expect(audit.getAll()).toHaveLength(0);
  });

  it("never sends to another tenant's devices", async () => {
    await repo.register({ tenantId: TENANT_A, userId: 'u1', platform: 'ios', token: 'a-tok' });
    await repo.register({ tenantId: TENANT_B, userId: 'u9', platform: 'ios', token: 'b-tok' });
    const provider = new InMemoryPushDeliveryProvider();
    const worker = createPushNotificationWorker({ deviceTokenRepo: repo, pushProvider: provider, auditRepo: audit });

    await worker.handle(jobMsg({ tenantId: TENANT_A, title: 'Hi', body: 'b' }), noopLogger);

    expect(provider.sent.map((s) => s.token)).toEqual(['a-tok']);
  });
});
