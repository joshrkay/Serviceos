/**
 * Proposal auto-expiry sweeper (§5.5 + §10.4).
 *
 * Mirrors the cross-tenant sweep pattern from estimate-expiry-worker.ts: a
 * per-tenant try/catch so one tenant's failure never crashes the loop, plus a
 * per-proposal try/catch so one bad row doesn't skip the rest of that tenant's
 * proposals. For each tenant it finds still-pending proposals (draft /
 * ready_for_review) whose `expiresAt` has passed, transitions them to
 * 'expired', and emits an audit event.
 *
 * Only schedule (§5.5) and outbound-message (§10.4) proposal cards carry an
 * `expiresAt` (set at creation by `defaultProposalExpiry`), so every other
 * proposal type is invisible to this sweep and persists indefinitely. An
 * expired card is terminal; the operator re-proposes by creating a fresh
 * proposal (the inbox surfaces the expired one as re-proposable).
 *
 * The sweep cadence is owned by app.ts (a setInterval driver). Tests exercise
 * this function directly with an in-memory repo and a fixed clock.
 */
import { Logger } from '../logging/logger';
import { Proposal, ProposalRepository, ProposalStatus } from '../proposals/proposal';
import { canTransition } from '../proposals/lifecycle';
import { AuditRepository, createAuditEvent } from '../audit/audit';

/** Statuses a still-pending proposal can be expired from. */
export const EXPIRABLE_PROPOSAL_STATUSES: readonly ProposalStatus[] = ['draft', 'ready_for_review'];

/**
 * True when `proposal` is a pending proposal whose 48h window has elapsed as of
 * `asOf`. Proposals with no `expiresAt` (every non-schedule type) never expire,
 * and already-decided proposals (approved/executed/rejected/…) are left alone.
 */
export function isProposalExpired(proposal: Proposal, asOf: Date): boolean {
  if (!proposal.expiresAt) return false;
  if (!EXPIRABLE_PROPOSAL_STATUSES.includes(proposal.status)) return false;
  return proposal.expiresAt.getTime() <= asOf.getTime();
}

export interface ProposalExpiryWorkerDeps {
  proposalRepo: ProposalRepository;
  /** Returns the list of tenant IDs to sweep. */
  listTenantIds: () => Promise<string[]>;
  logger: Logger;
  /** Injectable clock — defaults to `() => new Date()`. */
  now?: () => Date;
  /** Optional audit trail of each expiry. */
  auditRepo?: AuditRepository;
}

export async function runProposalExpirySweep(
  deps: ProposalExpiryWorkerDeps,
): Promise<{ tenants: number; expired: number; failed: number }> {
  const now = deps.now ?? (() => new Date());

  let tenantIds: string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (err) {
    deps.logger.error('Proposal-expiry sweep: failed to list tenants', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { tenants: 0, expired: 0, failed: 0 };
  }

  const asOf = now(); // One snapshot for the entire sweep.
  let expired = 0;
  let failed = 0;

  for (const tenantId of tenantIds) {
    let candidates: Proposal[];
    try {
      // Only the two pending statuses can carry a live expiry; fetching them
      // (rather than the whole tenant) keeps the sweep cheap on busy tenants.
      const pending = await Promise.all(
        EXPIRABLE_PROPOSAL_STATUSES.map((status) => deps.proposalRepo.findByStatus(tenantId, status)),
      );
      candidates = pending.flat();
    } catch (err) {
      failed++;
      deps.logger.warn('Proposal-expiry sweep: tenant failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const proposal of candidates) {
      if (!isProposalExpired(proposal, asOf)) continue;

      try {
        // Re-read immediately before writing: `candidates` was a snapshot, and
        // an operator may have approved/rejected this proposal in the same tick.
        // updateStatus sets status unconditionally, so without this guard the
        // sweep would clobber a fresh decision (e.g. approved → expired). Skip
        // unless the row is still a pending, past-expiry schedule card.
        const fresh = await deps.proposalRepo.findById(tenantId, proposal.id);
        if (!fresh || !isProposalExpired(fresh, asOf)) continue;
        if (!canTransition(fresh.status, 'expired')) continue;

        await deps.proposalRepo.updateStatus(tenantId, proposal.id, 'expired');
        expired++;
        if (deps.auditRepo) {
          await deps.auditRepo.create(
            createAuditEvent({
              tenantId,
              actorId: 'proposal-expiry-worker',
              actorRole: 'system',
              eventType: 'proposal.expired',
              entityType: 'proposal',
              entityId: proposal.id,
              metadata: {
                proposalType: proposal.proposalType,
                expiresAt: proposal.expiresAt?.toISOString(),
              },
            }),
          );
        }
      } catch (err) {
        failed++;
        deps.logger.warn('Proposal-expiry sweep: proposal failed', {
          tenantId,
          proposalId: proposal.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  deps.logger.info('Proposal-expiry sweep completed', {
    tenants: tenantIds.length,
    expired,
    failed,
  });

  return { tenants: tenantIds.length, expired, failed };
}
