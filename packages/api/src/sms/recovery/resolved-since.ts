/**
 * P8-015 — production ResolvedSinceChecker.
 *
 * Decides at SEND time (T≈60s) whether the dropped call already resolved,
 * so we never apologize for a call that ultimately succeeded. Three durable
 * signals, checked in order, each individually failure-isolated (one broken
 * query must not silently disable the others):
 *
 *   1. Same-session outcome — a finalize race can resolve the session
 *      differently than the schedule-time snapshot: `completed` →
 *      'booking_completed', `escalated_to_human` → 'transferred' (the
 *      voice_sessions outcome enum has no 'transferred' value; escalation
 *      to a human IS the transfer).
 *   2. An executed proposal from the drop — proposals carry no session FK,
 *      so the ids come from the row's persisted FSM context snapshot.
 *   3. A call-back: a NEWER ended session for the same customer that
 *      completed or was escalated. Only reachable when the dropped session
 *      was linked to a customer — voice_sessions has no caller-phone
 *      column, so an unidentified caller ringing back is undetectable
 *      (accepted v1 limitation, documented in the plan).
 *
 * Failure bias: indeterminate → null → send. The feature exists to not lose
 * the lead; a redundant "we got cut off, reply to pick back up" is benign.
 */
import type { Logger } from '../../logging/logger';
import type { VoiceSessionRepository, VoiceSessionRow } from '../../voice/voice-session';
import type { Proposal } from '../../proposals/proposal';
import type { DroppedCallRecoveryContext } from './scheduler';
import type { ResolvedSinceChecker } from './dropped-call-handler';

/** How many recent ended sessions to scan for the call-back signal. */
const CALLBACK_SCAN_LIMIT = 25;

export interface ResolvedSinceDeps {
  voiceSessionRepo: VoiceSessionRepository;
  proposalRepo: Pick<import('../../proposals/proposal').ProposalRepository, 'findById'>;
  logger: Logger;
}

function mapOutcome(
  session: Pick<VoiceSessionRow, 'outcome'>,
): 'booking_completed' | 'transferred' | null {
  if (session.outcome === 'completed') return 'booking_completed';
  if (session.outcome === 'escalated_to_human') return 'transferred';
  return null;
}

export function createDroppedCallResolvedSince(deps: ResolvedSinceDeps): ResolvedSinceChecker {
  const { voiceSessionRepo, proposalRepo, logger } = deps;

  return async (
    tenantId: string,
    voiceSessionId: string,
    context?: DroppedCallRecoveryContext | null,
  ): Promise<'booking_completed' | 'transferred' | null> => {
    // Signal 1 — the dropped session itself resolved after scheduling.
    let session: VoiceSessionRow | null = null;
    try {
      session = await voiceSessionRepo.findById(tenantId, voiceSessionId);
      if (session) {
        const mapped = mapOutcome(session);
        if (mapped) return mapped;
      }
    } catch (err) {
      logger.warn('resolved-since: session outcome check failed', {
        tenantId,
        voiceSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Signal 2 — a proposal captured during the call was executed.
    const proposalIds = context?.proposalIds ?? [];
    for (const proposalId of proposalIds) {
      try {
        const proposal: Proposal | null = await proposalRepo.findById(tenantId, proposalId);
        if (proposal?.status === 'executed') return 'booking_completed';
      } catch (err) {
        logger.warn('resolved-since: proposal status check failed', {
          tenantId,
          voiceSessionId,
          proposalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Signal 3 — the identified customer called back on a NEW session that
    // resolved. Filtered in code: findByTenant has no startedAfter option,
    // and the recent-ended list is small and bounded.
    if (session?.customerId) {
      try {
        const recent = await voiceSessionRepo.findByTenant(tenantId, {
          customerId: session.customerId,
          endedOnly: true,
          limit: CALLBACK_SCAN_LIMIT,
        });
        const droppedStart = session.startedAt.getTime();
        for (const candidate of recent) {
          if (candidate.id === voiceSessionId) continue;
          if (candidate.startedAt.getTime() <= droppedStart) continue;
          const mapped = mapOutcome(candidate);
          if (mapped) return mapped;
        }
      } catch (err) {
        logger.warn('resolved-since: call-back check failed', {
          tenantId,
          voiceSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return null;
  };
}
