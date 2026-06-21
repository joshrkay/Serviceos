import { type Logger } from '../logging/logger';
import { type DeviceTokenRepository } from '../push/device-token-service';
import { hasPermission } from '../auth/rbac';
import { type UserRepository } from '../users/user';
import { type PushDeliveryProvider } from './push-delivery-provider';
import { OwnerNotificationService } from './owner-notification-service';

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
 * Sends the two proposal-lifecycle owner pushes (needs-approval, executed).
 * Thin back-compat wrapper over {@link OwnerNotificationService} — the actual
 * fan-out/targeting/dead-token-prune lives there now. Failure-isolated: a push
 * error never propagates.
 */
export interface ProposalPushNotifierDeps {
  deviceTokenRepo: Pick<DeviceTokenRepository, 'listByTenant' | 'remove'>;
  provider: PushDeliveryProvider;
  /**
   * Restrict proposal pushes to the devices of users who can approve. Without
   * it, all tenant devices receive the push (back-compat).
   */
  resolveApproverUserIds?: (tenantId: string) => Promise<Set<string>>;
  logger?: Logger;
}

function serviceFor(deps: ProposalPushNotifierDeps): OwnerNotificationService {
  return new OwnerNotificationService({
    deviceTokenRepo: deps.deviceTokenRepo,
    provider: deps.provider,
    // The approver set IS the `proposals:approve` set, so ignore the requested
    // permission and reuse the proposal resolver directly.
    ...(deps.resolveApproverUserIds
      ? { resolveUserIds: (tenantId: string) => deps.resolveApproverUserIds!(tenantId) }
      : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}

export async function notifyNeedsApproval(
  deps: ProposalPushNotifierDeps,
  input: { tenantId: string; proposal: { id: string; summary: string } },
): Promise<void> {
  await serviceFor(deps).notify(input.tenantId, 'proposal_needs_approval', {
    proposalId: input.proposal.id,
    summary: input.proposal.summary,
  });
}

export async function notifyExecuted(
  deps: ProposalPushNotifierDeps,
  input: { tenantId: string; proposalId: string; summary?: string },
): Promise<void> {
  await serviceFor(deps).notify(input.tenantId, 'proposal_executed', {
    proposalId: input.proposalId,
    ...(input.summary ? { summary: input.summary } : {}),
  });
}
