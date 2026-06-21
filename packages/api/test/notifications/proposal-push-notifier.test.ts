import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDeviceTokenRepository } from '../../src/push/device-token-service';
import { InMemoryPushDeliveryProvider } from '../../src/notifications/push-delivery-provider';
import {
  approverUserIdsResolver,
  notifyExecuted,
  notifyNeedsApproval,
  type ProposalPushNotifierDeps,
} from '../../src/notifications/proposal-push-notifier';
import type { User } from '../../src/users/user';

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
    expect(provider.sent[0].data).toEqual({
      type: 'proposal_needs_approval',
      screen: '/proposals/p1',
      entityId: 'p1',
      proposalId: 'p1',
      kind: 'needs_approval',
    });
  });

  it('notifyExecuted sends kind=executed once per token', async () => {
    await seedTokens(repo, ['ExponentPushToken[a]']);
    await notifyExecuted(deps, { tenantId: TENANT, proposalId: 'p9', summary: 'Payment recorded' });

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].data).toEqual({
      type: 'proposal_executed',
      screen: '/proposals/p9',
      entityId: 'p9',
      proposalId: 'p9',
      kind: 'executed',
    });
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

  it('with resolveApproverUserIds, only approver devices receive the push', async () => {
    await repo.register({ tenantId: TENANT, userId: 'owner-1', expoPushToken: 'ExponentPushToken[owner]', platform: 'ios' });
    await repo.register({ tenantId: TENANT, userId: 'tech-1', expoPushToken: 'ExponentPushToken[tech]', platform: 'android' });
    const filtered: ProposalPushNotifierDeps = {
      deviceTokenRepo: repo,
      provider,
      resolveApproverUserIds: async () => new Set(['owner-1']),
    };
    await notifyNeedsApproval(filtered, { tenantId: TENANT, proposal: { id: 'p1', summary: 's' } });
    expect(provider.sent.map((m) => m.to)).toEqual(['ExponentPushToken[owner]']);
  });

  it('no approver devices in the tenant → no send', async () => {
    await repo.register({ tenantId: TENANT, userId: 'tech-1', expoPushToken: 'ExponentPushToken[tech]', platform: 'android' });
    const filtered: ProposalPushNotifierDeps = {
      deviceTokenRepo: repo,
      provider,
      resolveApproverUserIds: async () => new Set<string>(),
    };
    await notifyExecuted(filtered, { tenantId: TENANT, proposalId: 'p1' });
    expect(provider.sent).toHaveLength(0);
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

describe('approverUserIdsResolver', () => {
  const user = (clerkUserId: string | null, role: User['role']): User =>
    ({
      id: `id-${clerkUserId}`,
      tenantId: TENANT,
      clerkUserId,
      email: 'x@y.test',
      role,
      canFieldServe: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as User;

  it('returns only the Clerk ids of roles that can approve proposals', async () => {
    const userRepo = {
      findByTenant: async () => [
        user('owner-c', 'owner'),
        user('disp-c', 'dispatcher'),
        user('tech-c', 'technician'), // technician cannot approve → excluded
        user(null, 'owner'), // invited owner, no Clerk id yet → excluded
      ],
    };
    const ids = await approverUserIdsResolver(userRepo)(TENANT);
    expect([...ids].sort()).toEqual(['disp-c', 'owner-c']);
  });
});
