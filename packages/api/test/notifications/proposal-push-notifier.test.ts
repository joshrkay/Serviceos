import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDeviceTokenRepository } from '../../src/push/device-token-service';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import {
  notifyExecuted,
  notifyNeedsApproval,
  type ProposalPushNotifierDeps,
} from '../../src/notifications/proposal-push-notifier';

const TENANT = 'tenant-1';

async function seedTokens(repo: InMemoryDeviceTokenRepository, tokens: string[]): Promise<void> {
  for (const t of tokens) {
    await repo.register({ tenantId: TENANT, userId: 'u1', expoPushToken: t, platform: 'ios' });
  }
}

describe('proposal-push-notifier', () => {
  let repo: InMemoryDeviceTokenRepository;
  let provider: InMemoryPushDeliveryProvider;
  let deps: ProposalPushNotifierDeps;

  beforeEach(() => {
    repo = new InMemoryDeviceTokenRepository();
    provider = new InMemoryPushDeliveryProvider();
    deps = { deviceTokenRepo: repo, provider };
  });

  it('notifyNeedsApproval sends one push per active token with kind=needs_approval', async () => {
    await seedTokens(repo, ['ExponentPushToken[a]', 'ExponentPushToken[b]']);
    await notifyNeedsApproval(deps, { tenantId: TENANT, proposal: { id: 'p1', summary: 'Invoice Acme $123' } });

    expect(provider.sent).toHaveLength(2);
    expect(provider.sent[0].body).toBe('Invoice Acme $123');
    expect(provider.sent[0].data).toEqual({ proposalId: 'p1', kind: 'needs_approval', screen: '/proposals/p1' });
  });

  it('notifyExecuted sends kind=executed once per token', async () => {
    await seedTokens(repo, ['ExponentPushToken[a]']);
    await notifyExecuted(deps, { tenantId: TENANT, proposalId: 'p9', summary: 'Payment recorded' });

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].data).toEqual({ proposalId: 'p9', kind: 'executed', screen: '/proposals/p9' });
  });

  it('no active tokens → no send (no-op)', async () => {
    await notifyNeedsApproval(deps, { tenantId: TENANT, proposal: { id: 'p1', summary: 's' } });
    expect(provider.sent).toHaveLength(0);
  });

  it('prunes a DeviceNotRegistered token', async () => {
    await seedTokens(repo, ['ExponentPushToken[live]', 'ExponentPushToken[dead]']);
    provider.deadTokens.add('ExponentPushToken[dead]');

    await notifyExecuted(deps, { tenantId: TENANT, proposalId: 'p1' });

    const remaining = await repo.listByTenant(TENANT);
    expect(remaining.map((t) => t.expoPushToken)).toEqual(['ExponentPushToken[live]']);
  });

  it('swallows provider errors (never breaks routing/execution)', async () => {
    await seedTokens(repo, ['ExponentPushToken[a]']);
    const throwing: ProposalPushNotifierDeps = {
      deviceTokenRepo: repo,
      provider: {
        async sendPush() {
          throw new Error('gateway down');
        },
      },
    };
    await expect(
      notifyExecuted(throwing, { tenantId: TENANT, proposalId: 'p1' }),
    ).resolves.toBeUndefined();
  });
});
