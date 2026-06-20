import { type Logger } from '../logging/logger';
import { type DeviceTokenRepository } from '../push/device-token-service';
import { hasPermission } from '../auth/rbac';
import { type UserRepository } from '../users/user';
import { type PushDeliveryProvider, type PushMessage } from './push-delivery-provider';

/**
 * Build the approver-id resolver from the user repo: the set of Clerk user ids
 * in a tenant whose role grants `proposals:approve` (owner + dispatcher, not
 * technician). Device tokens are keyed by `userId` (the Clerk subject), so this
 * lets the notifier target only devices that can act on a proposal.
 */
export function approverUserIdsResolver(
  userRepo: Pick<UserRepository, 'findByTenant'>,
): (tenantId: string) => Promise<Set<string>> {
  return async (tenantId: string): Promise<Set<string>> => {
    const users = await userRepo.findByTenant(tenantId);
    const ids = new Set<string>();
    for (const u of users) {
      if (u.clerkUserId && hasPermission(u.role, 'proposals:approve')) {
        ids.add(u.clerkUserId);
      }
    }
    return ids;
  };
}

/**
 * Sends the two owner-facing push notifications: a proposal needs approval, and
 * an approved proposal executed. Pure-ish — takes the device-token repo +
 * provider as deps so it unit-tests without HTTP. Failure-isolated: a push
 * error never propagates (it must never break routing or execution). Dead
 * tokens (Expo DeviceNotRegistered) are pruned as a side effect.
 */
export interface ProposalPushNotifierDeps {
  deviceTokenRepo: Pick<DeviceTokenRepository, 'listByTenant' | 'remove'>;
  provider: PushDeliveryProvider;
  /**
   * Restrict proposal pushes to the devices of users who can approve (so a
   * technician who signs into the app never receives approval-needed/done
   * content for work they can't act on). Without it, all tenant devices
   * receive the push (back-compat).
   */
  resolveApproverUserIds?: (tenantId: string) => Promise<Set<string>>;
  logger?: Logger;
}

async function dispatch(
  deps: ProposalPushNotifierDeps,
  tenantId: string,
  base: Omit<PushMessage, 'to'>,
): Promise<void> {
  try {
    const tokens = await deps.deviceTokenRepo.listByTenant(tenantId);
    if (tokens.length === 0) return;

    let recipients = tokens;
    if (deps.resolveApproverUserIds) {
      const approvers = await deps.resolveApproverUserIds(tenantId);
      recipients = tokens.filter((t) => approvers.has(t.userId));
    }
    if (recipients.length === 0) return;

    const messages: PushMessage[] = recipients.map((t) => ({ to: t.expoPushToken, ...base }));
    const results = await deps.provider.sendPush(messages);

    for (const r of results) {
      if (r.deviceNotRegistered) {
        try {
          await deps.deviceTokenRepo.remove(tenantId, r.to);
        } catch {
          // pruning is best-effort
        }
      }
    }
  } catch (err) {
    deps.logger?.warn('proposal push notify failed', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function notifyNeedsApproval(
  deps: ProposalPushNotifierDeps,
  input: { tenantId: string; proposal: { id: string; summary: string } },
): Promise<void> {
  await dispatch(deps, input.tenantId, {
    title: 'Approval needed',
    body: input.proposal.summary || 'A draft is ready for your review.',
    data: {
      proposalId: input.proposal.id,
      kind: 'needs_approval',
      screen: `/proposals/${input.proposal.id}`,
    },
  });
}

export async function notifyExecuted(
  deps: ProposalPushNotifierDeps,
  input: { tenantId: string; proposalId: string; summary?: string },
): Promise<void> {
  await dispatch(deps, input.tenantId, {
    title: 'Done',
    body: input.summary || 'Your action is done.',
    data: {
      proposalId: input.proposalId,
      kind: 'executed',
      screen: `/proposals/${input.proposalId}`,
    },
  });
}
