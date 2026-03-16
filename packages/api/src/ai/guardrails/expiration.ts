import { Proposal, ProposalRepository } from '../../proposals/proposal';
import { transitionProposal, canTransition } from '../../proposals/lifecycle';
import { createHash } from 'crypto';

export interface ExpirationConfig {
  defaultTtlMs: number; // default 86400000 (24h)
  typeTtlMs?: Record<string, number>; // per-proposal-type TTL
}

export const DEFAULT_EXPIRATION_CONFIG: ExpirationConfig = {
  defaultTtlMs: 86400000, // 24 hours
  typeTtlMs: {
    'draft_estimate': 43200000, // 12 hours - financial proposals expire faster
    'create_appointment': 14400000, // 4 hours - time-sensitive
  },
};

export function isProposalExpired(proposal: Proposal, config?: ExpirationConfig): boolean {
  const now = new Date();

  // If expiresAt is explicitly set, use it
  if (proposal.expiresAt) {
    return now >= proposal.expiresAt;
  }

  // Otherwise calculate based on createdAt + TTL
  const expirationTime = getExpirationTime(proposal, config);
  return now >= expirationTime;
}

export function hashSourceContext(context: Record<string, unknown>): string {
  const json = JSON.stringify(context);
  return createHash('sha256').update(json).digest('hex');
}

export function checkProposalFreshness(
  proposal: Proposal,
  currentContext: Record<string, unknown>
): { fresh: boolean; reason?: string } {
  if (!proposal.sourceContext) {
    return { fresh: true };
  }

  const originalHash = hashSourceContext(proposal.sourceContext);
  const currentHash = hashSourceContext(currentContext);

  if (originalHash !== currentHash) {
    return {
      fresh: false,
      reason: 'Source context has changed since proposal was created',
    };
  }

  return { fresh: true };
}

export async function expireStaleProposals(
  proposalRepo: ProposalRepository,
  tenantId: string,
  config?: ExpirationConfig
): Promise<Proposal[]> {
  const readyProposals = await proposalRepo.findByStatus(tenantId, 'ready_for_review');
  const expired: Proposal[] = [];

  for (const proposal of readyProposals) {
    if (isProposalExpired(proposal, config)) {
      const transitioned = transitionProposal(proposal, 'expired', 'system');
      const updated = await proposalRepo.updateStatus(tenantId, proposal.id, 'expired');
      if (updated) {
        expired.push(updated);
      }
    }
  }

  return expired;
}

export function getExpirationTime(proposal: Proposal, config?: ExpirationConfig): Date {
  // If expiresAt is explicitly set, return it
  if (proposal.expiresAt) {
    return proposal.expiresAt;
  }

  const expirationConfig = config || DEFAULT_EXPIRATION_CONFIG;
  const typeTtl = expirationConfig.typeTtlMs?.[proposal.proposalType];
  const ttlMs = typeTtl ?? expirationConfig.defaultTtlMs;

  return new Date(proposal.createdAt.getTime() + ttlMs);
}
