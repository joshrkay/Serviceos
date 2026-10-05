import { Proposal, ProposalType } from '../proposal';
import { ExecutionContext, ExecutionHandler, ExecutionResult } from './handlers';
import { AuditRepository, createAuditEvent } from '../../audit/audit';

/**
 * Task 14 (2026-08-07 tradesperson plan) — `callback` execution handler.
 *
 * `callback` proposals route a caller to a human — they mutate nothing (see
 * `actionClassForProposalType`'s doc comment in proposal.ts and the S1
 * allowlist comment in surface.ts: "routes the caller to a human — never a
 * mutation"). Historically `callback` had NO execution handler at all: an
 * approved callback reached ProposalExecutor, found nothing in the handler
 * map, and threw `HANDLER_NOT_FOUND` — which the execution sweep
 * (workers/execution-worker.ts) caught and logged, leaving the row claimed
 * ('executing') until `resetStaleExecuting` retried it up to 3 times (a
 * 10-minute stale window each) and finally landed it in terminal
 * 'execution_failed'. (PR #815 closed the audit gap on THAT path generically
 * — resetStaleExecuting now emits `proposal.execution_timed_out` — but the
 * caller's callback request would still dead-end there with no domain
 * outcome ever recorded, ~30-40 minutes after being approved.) This handler
 * makes approval a graceful no-op instead: it acknowledges the callback (a
 * failure-soft audit event, LogExpense-family posture) and completes
 * successfully, immediately.
 *
 * ── Why a no-op is correct, not a gap ─────────────────────────────────────
 * A `callback` proposal's payload (`reason`/`requestedService`/
 * `callerPhone`/`transcript`/`conversationId` — contracts.ts, an
 * all-optional passthrough) IS the durable capture: the proposal row is
 * persisted the moment it's drafted — long before any approval — so nothing
 * about approving it is the only chance to record the caller's need.
 *
 * ── Production creation-site inventory (counting rule stated explicitly,
 * since this got miscounted twice before) ─────────────────────────────────
 * 4 production FILES; 5 `createProposal`/`buildProposal` CALL SITES; 7 total
 * CONTENT BRANCHES that resolve to `proposalType: 'callback'` (two of the
 * files share one call site across three evaluation-outcome branches, two of
 * which are 'callback' — the third is 'voice_clarification'):
 *   - `negotiation-task.ts` — 2 direct `createProposal` calls (ALLOW branch +
 *     the enriched/default branch), both unconditionally 'callback'.
 *   - `complaint-task.ts` — 1 direct `createProposal` call (the companion
 *     owner-followup callback), unconditionally 'callback'.
 *   - `create-voice-turn-processor.ts` — 1 `buildProposal` call fed by
 *     inline branching (the live-call negotiation branch, FSM path); 2 of
 *     its 3 possible outcomes (ALLOW, enriched/default) are 'callback', the
 *     third (CLARIFY) is 'voice_clarification'.
 *   - `sms/negotiation/inbound-negotiation-handler.ts` — 1 `createProposal`
 *     call fed by `buildNegotiationProposalContent`; same 2-of-3 shape as
 *     above. The ONLY site that stamps `callerPhone` into the payload.
 * `text-mode-driver.ts`'s after-hours branch ALSO constructs a `callback`
 * proposal, but that file is the VQ-007 voice-quality corpus harness, not
 * production — excluded from every count above. The real production
 * after-hours path (`routes/telephony.ts`'s `afterHours` branch) sends the
 * caller to voicemail TwiML and drafts no `callback` proposal at all.
 *
 * The SEPARATE `call_me_back_tasks` operational-task system
 * (voice/call-me-back/call-me-back.ts, its own CSR-notification worker) is
 * created directly by its own call sites — warm-transfer failure
 * (routes/telephony.ts, sms/recovery/resume-handler.ts), an E1 safety
 * follow-up (create-voice-turn-processor.ts's createE1FollowUpTask), or a
 * patched-through voicemail (ai/skills/patch-owner-through.ts) — entirely
 * independent of any `callback` PROPOSAL's lifecycle. None of the
 * `callback`-proposal creation sites above ALSO write a call_me_back_tasks
 * row, so there is no upstream durable row this handler would need to
 * create on approval to avoid dropping the customer's request; the
 * operator's proposal queue (visible in 'draft'/'ready_for_review' before
 * approval, and readable afterward via the audit trail this handler emits)
 * IS that durable record.
 *
 * ── Deliberately dep-free ──────────────────────────────────────────────
 * There is nothing to wire: no repository call, no external send. Registered
 * UNCONDITIONALLY in handlers.ts (no dep gate) and reports
 * `isFullyWired() === true` unconditionally — it can never degrade, because
 * it has no dependency to be missing.
 *
 * ── resultEntityId: the proposal's own id ─────────────────────────────────
 * No domain entity is created, so a fabricated random uuid would be
 * misleading (it would look like a real referenced entity while pointing at
 * nothing). Mirrors `UpdateBrandVoiceExecutionHandler`'s use of
 * `context.tenantId` when there's no distinct created row: fall back to the
 * most meaningful id actually in scope, which for a callback is the
 * proposal itself.
 */
export class CallbackExecutionHandler implements ExecutionHandler {
  proposalType: ProposalType = 'callback';

  constructor(private readonly auditRepo?: AuditRepository) {}

  // Deliberately dep-free: nothing to wire, so this can never degrade.
  isFullyWired(): boolean {
    return true;
  }

  async execute(proposal: Proposal, context: ExecutionContext): Promise<ExecutionResult> {
    if (this.auditRepo) {
      try {
        // conversationId links the acknowledgement back to the call/thread
        // that raised it without joining through the proposal row. Present
        // on every production `callback`-creation branch EXCEPT the
        // inbound-SMS one (sms/negotiation/inbound-negotiation-handler.ts),
        // which has no conversationId concept at all — it keys on
        // fromPhone/messageSid instead (see this class's own doc comment for
        // the full production-site inventory). So this is opportunistic, not
        // a contract guarantee.
        const conversationId =
          typeof proposal.payload.conversationId === 'string'
            ? proposal.payload.conversationId
            : undefined;
        await this.auditRepo.create(
          createAuditEvent({
            tenantId: context.tenantId,
            actorId: context.executedBy,
            actorRole: context.executedByRole ?? 'voice_agent',
            eventType: 'callback.acknowledged',
            entityType: 'proposal',
            entityId: proposal.id,
            metadata: {
              proposalId: proposal.id,
              proposalType: 'callback',
              ...(conversationId ? { conversationId } : {}),
            },
          }),
        );
      } catch (auditErr) {
        // Audit failures must not unwind a successful acknowledgement — but
        // they MUST be diagnosable. Mirrors LogExpenseExecutionHandler /
        // AddCatalogItemExecutionHandler / AddMaterialExecutionHandler.
        const msg = auditErr instanceof Error ? auditErr.message : String(auditErr);
        console.warn(
          `Failed to emit callback.acknowledged audit event for proposal ${proposal.id}: ${msg}`,
        );
      }
    }

    return { success: true, resultEntityId: proposal.id };
  }
}
