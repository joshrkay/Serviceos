/**
 * RV-080 — complaint intent task handler.
 *
 * A caller (or an operator relaying a call) reports dissatisfaction with
 * completed work or service. No new proposal types are introduced: a
 * complaint produces:
 *
 *   1. an `add_note` proposal on the resolved customer/job (returned —
 *      persisted by the normal single-action / chain machinery). The
 *      add_note contract has no pin flag, so the note body carries the
 *      '[COMPLAINT]' prefix as the documented stand-in.
 *   2. a companion `callback` proposal for owner follow-up, persisted
 *      directly inside handle() (the one-proposal-per-segment router shape
 *      has no slot for companions; the callback is persisted here before the
 *      note is returned, so the callback is always written first — if the
 *      router crashes after persisting the callback but before persisting the
 *      note, the callback is orphaned but the note is NOT half-executed; a
 *      subsequent redelivery re-creates the note cleanly while the callback
 *      is deduped by its idempotency key).
 *
 * High-severity wording (deterministic keyword list) flags `_meta.markers`
 * with reason 'complaint_high_severity' on BOTH proposals. Both are
 * capture-class with no trust tier → always 'draft', never auto-executed.
 */
import { createProposal, ProposalRepository } from '../../proposals/proposal';
import type { TaskHandler, TaskContext, TaskResult } from './task-handlers';
import type { ProposalType } from '../../proposals/proposal';
import type { ExtractedEntities } from '../orchestration/intent-classifier';

/**
 * Deterministic high-severity complaint detection. A complaint that
 * mentions refunds, legal action, or threats to escalate publicly gets
 * `_meta.markers` flagged with reason 'complaint_high_severity' so every
 * review surface (cards, SMS render, digest) calls it out. Simple fixed
 * keyword list by design — severity must be auditable, not an LLM mood read.
 */
const COMPLAINT_HIGH_SEVERITY_PATTERNS: ReadonlyArray<RegExp> = [
  /\brefunds?\b/i,
  /\bmoney\s+back\b/i,
  /\bcharge\s*backs?\b/i,
  /\blawyers?\b/i,
  /\battorneys?\b/i,
  /\blegal(?:\s+action)?\b/i,
  /\bsue\b|\bsuing\b|\blawsuits?\b/i,
  /\bsmall\s+claims\b/i,
  /\bbetter\s+business\s+bureau\b/i,
  /\bBBB\b/,
  /\bthreat(?:s|en(?:s|ed|ing)?)?\b/i,
  /\breport(?:ing)?\s+you\b/i,
];

export const COMPLAINT_HIGH_SEVERITY_REASON = 'complaint_high_severity';

export function complaintSeverity(text: string): 'high' | 'normal' {
  if (!text) return 'normal';
  return COMPLAINT_HIGH_SEVERITY_PATTERNS.some((rx) => rx.test(text)) ? 'high' : 'normal';
}

export class ComplaintTaskHandler implements TaskHandler {
  readonly taskType: ProposalType = 'add_note';

  constructor(private readonly proposalRepo: ProposalRepository) {}

  async handle(context: TaskContext): Promise<TaskResult> {
    const ee = (context.existingEntities ?? {}) as ExtractedEntities & {
      customerId?: string;
      jobId?: string;
    };
    const description = (ee.noteBody ?? context.message).trim();
    const severity = complaintSeverity(`${context.message} ${description}`);
    const severityMeta =
      severity === 'high'
        ? {
            _meta: {
              // Required by the _meta contract; 'medium' is neutral (only
              // low/very_low gate anything). The marker is the payload here.
              overallConfidence: 'medium',
              markers: [{ path: 'body', reason: COMPLAINT_HIGH_SEVERITY_REASON }],
            },
          }
        : {};

    // Verified caller-ID identity first, then router-resolved entities,
    // then free-text references for the review UI to resolve.
    const resolvedCustomerId = context.customerId ?? ee.customerId;
    const notePayload: Record<string, unknown> = {
      // '[COMPLAINT]' prefix: the add_note contract has no pinned flag.
      body: `[COMPLAINT] ${description}`,
      ...severityMeta,
    };
    const missing: string[] = [];
    if (ee.jobId) {
      notePayload.targetKind = 'job';
      notePayload.targetId = ee.jobId;
    } else if (resolvedCustomerId) {
      notePayload.targetKind = 'customer';
      notePayload.targetId = resolvedCustomerId;
    } else if (ee.jobReference) {
      notePayload.targetKind = 'job';
      notePayload.targetReference = ee.jobReference;
    } else if (ee.customerName) {
      notePayload.targetKind = 'customer';
      notePayload.targetReference = ee.customerName;
    } else {
      notePayload.targetKind = 'customer';
      missing.push('targetId');
    }

    const who = ee.customerName ?? 'the customer';
    const sourceContext: Record<string, unknown> = {
      source: 'voice',
      ...(context.conversationId ? { conversationId: context.conversationId } : {}),
      ...(context.recordingId ? { recordingId: context.recordingId } : {}),
    };

    // Companion: owner follow-up callback. Persisted directly (see class
    // doc); capture-class, no trust tier → 'draft'.
    // RV-080 dedup: derive a stable idempotency key from recordingId so
    // concurrent-style redelivery of the same recording never double-creates
    // the callback. Key is absent (and dedup skipped) only when recordingId
    // is genuinely unknown (e.g. synthetic / test-mode transcripts).
    const callbackIdempotencyKey = context.recordingId
      ? `voice-complaint-callback:${context.recordingId}`
      : undefined;
    const callbackProposal = createProposal({
      tenantId: context.tenantId,
      proposalType: 'callback',
      payload: {
        reason: 'customer_complaint_followup',
        transcript: context.message,
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        ...severityMeta,
      },
      summary:
        severity === 'high'
          ? `HIGH-SEVERITY complaint — call ${who} back`
          : `Complaint follow-up — call ${who} back`,
      explanation:
        'Logged from a complaint heard on a call. The pinned-prefix note carries the details; this callback is the owner follow-up.',
      sourceContext,
      createdBy: context.userId,
      ...(callbackIdempotencyKey ? { idempotencyKey: callbackIdempotencyKey } : {}),
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
    });
    await this.proposalRepo.create(callbackProposal);

    const noteProposal = createProposal({
      tenantId: context.tenantId,
      proposalType: 'add_note',
      payload: notePayload,
      summary:
        severity === 'high'
          ? `HIGH-SEVERITY complaint from ${who}`
          : `Complaint from ${who}`,
      sourceContext,
      createdBy: context.userId,
      missingFields: missing.length > 0 ? missing : undefined,
      ...(context.tenantThresholdOverride
        ? { tenantThresholdOverride: context.tenantThresholdOverride }
        : {}),
    });

    return { proposal: noteProposal, taskType: 'add_note' };
  }
}
