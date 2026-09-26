/**
 * #350 — canonical home for the "rotation cascade exhausted" callback
 * proposal. Previously duplicated verbatim as `TwilioGatherAdapter
 * #queueCallbackProposal` (telephony/twilio-adapter.ts, public — the
 * `/dial-result` route calls it after walking the rotation cursor off the
 * end) and `queueCallbackProposalInternal` (ai/voice-turn/create-voice-turn-
 * processor.ts, used by `handleNotifyOncall` when the rotation cascade is
 * empty). Same circular-import constraint as `xml-escape.ts`: the processor
 * cannot import from the adapter. This module depends on neither, so both
 * import it directly.
 */
import { createLogger } from '../../logging/logger';
import type { ProposalRepository } from '../../proposals/proposal';
import { createProposal as buildProposal } from '../../proposals/proposal';
import type { AuditRepository } from '../../audit/audit';
import { createAuditEvent } from '../../audit/audit';
import type { VoiceSession } from '../../ai/agents/customer-calling/voice-session-store';

const logger = createLogger({
  service: 'telephony.shared.queue-callback-proposal',
  environment: process.env.NODE_ENV || 'development',
});

export type CallbackProposalOutcome = 'rotation_empty' | 'rotation_exhausted';

export type TenantThresholdOverride = Partial<
  Record<'supervisor' | 'tech' | 'both', number>
>;

export interface QueueCallbackProposalDeps {
  proposalRepo?: ProposalRepository;
  auditRepo?: AuditRepository;
  systemActorId?: string;
  callControl?: { clearCursor(sessionId: string): void };
}

/**
 * Queue the `customer_callback_required` proposal when the rotation
 * cascade is exhausted. Idempotent against the session: subsequent calls
 * (e.g. if the caller redials) will create a new proposal, which is
 * intentional — operators want one row per request.
 *
 * `resolveThresholdOverride` is injected rather than imported: both call
 * sites (adapter, processor) already carry their own tenant-threshold
 * resolution wired through their respective deps, and this module has no
 * business owning that resolution.
 */
export async function queueCallbackProposal(
  deps: QueueCallbackProposalDeps,
  session: VoiceSession,
  tenantId: string,
  reason: string,
  outcome: CallbackProposalOutcome,
  resolveThresholdOverride: (
    tenantId: string,
  ) => Promise<TenantThresholdOverride | undefined>,
): Promise<void> {
  if (!deps.proposalRepo) {
    logger.warn('queueCallbackProposal: proposalRepo not wired', {
      sessionId: session.id,
      outcome,
    });
    return;
  }
  try {
    const tenantThresholdOverride = await resolveThresholdOverride(tenantId);
    const proposal = buildProposal({
      tenantId,
      // No dedicated `customer_callback_required` ProposalType exists;
      // voice_clarification is the closest existing bucket (it's the
      // "needs human follow-up" capture-class proposal). The semantic
      // intent rides in payload.intent so the review UI / future
      // executor can branch on it.
      proposalType: 'voice_clarification',
      payload: {
        intent: 'customer_callback_required',
        reason,
        outcome,
        sessionId: session.id,
        callSid: session.callSid,
      },
      summary: `Customer callback required (${outcome})`,
      sourceContext: {
        source: 'calling-agent',
        channel: 'telephony',
        sessionId: session.id,
        escalationReason: reason,
      },
      // QA-2026-07-10: do NOT fabricate an aiRunId. proposals.ai_run_id has
      // an FK to ai_runs(id); a random uuid violates it and the swallowed
      // insert error silently dropped EVERY inbound-voice proposal on
      // Postgres-backed envs (in-memory repos don't enforce the FK, which
      // is why tests passed). This callback proposal is generated
      // internally with no associated ai_runs row, so ai_run_id stays null.
      createdBy: deps.systemActorId ?? 'calling-agent',
      ...(tenantThresholdOverride ? { tenantThresholdOverride } : {}),
    });
    const stored = await deps.proposalRepo.create(proposal);
    session.proposalIds.push(stored.id);

    // Audit for parity with normal escalation paths: operators searching
    // for "callback queued" want a single audit row to jump from.
    if (deps.auditRepo) {
      try {
        const auditEvent = createAuditEvent({
          tenantId,
          actorId: deps.systemActorId ?? 'calling-agent',
          actorRole: 'system',
          eventType: 'customer_callback_required',
          entityType: 'voice_session',
          entityId: session.id,
          correlationId: session.id,
          metadata: {
            proposalId: stored.id,
            reason,
            outcome,
            callSid: session.callSid,
          },
        });
        await deps.auditRepo.create(auditEvent);
      } catch (err) {
        logger.warn('queueCallbackProposal: audit persist failed', {
          error: err instanceof Error ? err.message : String(err),
          sessionId: session.id,
        });
      }
    }

    // Drop the rotation cursor — the call is done with the dial flow.
    deps.callControl?.clearCursor(session.id);
  } catch (err) {
    logger.warn('queueCallbackProposal failed', {
      error: err instanceof Error ? err.message : String(err),
      sessionId: session.id,
    });
  }
}
