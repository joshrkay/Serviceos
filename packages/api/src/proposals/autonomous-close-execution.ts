/**
 * QUALITY-2026-07-12 WS2 — owner-approval close preparation (supersedes the
 * D-018 sanctioned autonomous close; see docs/decisions.md D-019).
 *
 * The live voice agent may, on a caller-confirmed + consent-gated + catalog-
 * clean quote, PREPARE a close for the owner — hold the slot and stage the
 * proposals — but it must NEVER approve or execute them itself. Human (owner)
 * approval is required before any canonical write, customer communication,
 * booking confirmation, or money movement.
 *
 * `queueCloseFallbackChain` is the single seam:
 *   - it retrofits the live drafted estimate as chain head,
 *   - chains a `send_estimate` DRAFT to it (comms-class; blocked pending
 *     owner approval — `applyChainMetadata` forces 'draft'),
 *   - OPTIONALLY appends a `create_booking` DRAFT for an already-held slot
 *     (concrete appointmentId, no chain ref, capture-class) so the owner's
 *     ONE one-tap approval confirms the held booking too,
 *   - and sends the owner ONE `renderChainSms` one-tap approval SMS via the
 *     existing `routeUnsupervisedProposal` machinery.
 *
 * Nothing here transitions a proposal to 'approved' or executes it. The owner
 * one-tap approve route (routes/one-tap-approve.ts → approveChainSet) is the
 * ONLY path that approves the staged chain, with the D-009 undo window and the
 * standard executor unchanged.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  createProposal as buildProposal,
  type ProposalRepository,
} from './proposal';
import { applyChainMetadata } from './chain';
import type { ProposalSurface } from './surface';
import {
  autonomousCloseStamp,
  type AutonomousCloseEvaluation,
} from './autonomous-close-lane';
import {
  routeUnsupervisedProposal,
  type RouteUnsupervisedProposalDeps,
} from './auto-approve';
import { renderChainSms, type ChainSmsMember } from './sms/render';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'proposals.autonomous-close',
  environment: process.env.NODE_ENV || 'development',
});

/**
 * Actor stamped as `createdBy` on the DRAFTED (never approved) close proposals.
 * It is ONLY ever a creator — no approval or execution path may use it as an
 * approver (enforced structurally in proposals/lifecycle.ts: a `system:` actor
 * can never transition a proposal to 'approved').
 */
export const AUTONOMOUS_CLOSE_ACTOR = 'system:autonomous-close';

export interface CloseFallbackArgs {
  tenantId: string;
  draftEstimateProposalId: string;
  customerId?: string;
  callerPhone?: string;
  sessionId: string;
  /** The lane evaluation (eligible or first-failing gate) — stamped on every member. */
  evaluation: AutonomousCloseEvaluation;
  /**
   * When the caller's confirmation placed a hold, the already-held slot is
   * staged as a `create_booking` DRAFT so the owner's one-tap approval confirms
   * the booking too. Omitted ⇒ a two-member estimate+send chain; the hold (if
   * any) is the caller's to release/expire.
   */
  booking?: {
    appointmentId: string;
    holdExpiryAt: Date;
    /** Human-readable booking summary for the SMS + the create_booking member. */
    summary: string;
  };
}

/**
 * Stage the owner-approval close chain and send the owner ONE one-tap approval
 * SMS. Leaves the estimate a DRAFT, chains a `send_estimate` DRAFT (and,
 * optionally, a `create_booking` DRAFT for the held slot). Nothing is approved
 * or executed — the owner's tap is the only approval.
 *
 * Idempotent per call: a head that is already chained skips re-assembly (and
 * re-texting) so a repeated "yes, book it" can't spam the owner.
 */
export async function queueCloseFallbackChain(
  deps: {
    proposalRepo: ProposalRepository;
    auditRepo?: AuditRepository;
    routing?: RouteUnsupervisedProposalDeps & { ownerPhoneResolver?: (tenantId: string) => Promise<string | null | undefined> };
  },
  args: CloseFallbackArgs,
): Promise<{ queued: boolean; smsSent: boolean }> {
  const head = await deps.proposalRepo.findById(args.tenantId, args.draftEstimateProposalId);
  if (!head || head.proposalType !== 'draft_estimate') return { queued: false, smsSent: false };
  if (head.chainId) return { queued: false, smsSent: false }; // already assembled

  const chainLength = args.booking ? 3 : 2;
  const chainId = uuidv4();
  const stamp = autonomousCloseStamp(args.evaluation);

  const headSourceContext: Record<string, unknown> = {
    ...((head.sourceContext as Record<string, unknown> | undefined) ?? {}),
    chainId,
    chainIndex: 0,
    chainLength,
    dependsOnChainIndices: [],
    chainRefs: [],
    ...stamp,
  };
  const updatedHead = await deps.proposalRepo.update(args.tenantId, head.id, {
    sourceContext: headSourceContext,
    chainId,
    ...(args.customerId
      ? { payload: { ...head.payload, customerId: args.customerId } }
      : {}),
  });
  if (!updatedHead) return { queued: false, smsSent: false };

  // Member 1 — send_estimate (comms class; born blocked). The estimateId rides
  // as a $ref token applyChainMetadata writes; the executor's chain resolution
  // swaps in member 0's resultEntityId once the head executes (after approval).
  const sendMember = buildProposal({
    tenantId: args.tenantId,
    proposalType: 'send_estimate',
    payload: {
      channel: 'sms',
      ...(args.callerPhone ? { recipient: args.callerPhone } : {}),
      estimateReference: 'the quote from this call',
    },
    summary: 'Text the quote to the caller',
    sourceContext: {
      source: 'calling-agent',
      channel: 'telephony',
      // RIVET P4 — surface S2. This is the D-019 owner-approval close chain:
      // the send_estimate is born blocked and can ONLY execute after the owner
      // explicitly one-tap approves the chain (approveChainSet, a human actor),
      // and its recipient is server-derived from the call (the caller's own
      // phone), never from transcript content. Its execution authority is the
      // owner's, so it is stamped S2 rather than inferred S1 from the telephony
      // channel — otherwise the executor's fail-safe would block a legitimate
      // owner-approved send.
      surface: 'S2' as ProposalSurface,
      sessionId: args.sessionId,
      ...stamp,
    },
    createdBy: AUTONOMOUS_CLOSE_ACTOR,
  });
  applyChainMetadata(sendMember, {
    chainId,
    chainIndex: 1,
    chainLength,
    dependsOnChainIndices: [0],
    chainRefs: [{ payloadPath: 'estimateId', parentChainIndex: 0, entityKind: 'estimateId' }],
  });
  const storedSend = await deps.proposalRepo.create(sendMember);

  // Member 2 (optional) — create_booking confirms the ALREADY-HELD slot
  // (concrete appointmentId, no chain ref — chaining a ref would double-book,
  // chain.ts:180). Born 'draft' (no trust tier) and capture-class, so the
  // owner's single one-tap approval (approveChainSet) approves + executes it
  // alongside the estimate head; the held appointment is confirmed only then.
  const members = [updatedHead, storedSend];
  if (args.booking) {
    const bookingMember = buildProposal({
      tenantId: args.tenantId,
      proposalType: 'create_booking',
      payload: { appointmentId: args.booking.appointmentId },
      summary: args.booking.summary,
      sourceContext: {
        source: 'calling-agent',
        channel: 'telephony',
        // Owner-approval close chain member (see send_estimate above). S2 by
        // execution authority; create_booking is S1-allowlisted regardless.
        surface: 'S2' as ProposalSurface,
        sessionId: args.sessionId,
        chainId,
        chainIndex: 2,
        chainLength,
        dependsOnChainIndices: [],
        chainRefs: [],
        ...stamp,
      },
      createdBy: AUTONOMOUS_CLOSE_ACTOR,
      expiresAt: args.booking.holdExpiryAt,
    });
    bookingMember.chainId = chainId;
    const storedBooking = await deps.proposalRepo.create(bookingMember);
    members.push(storedBooking);
  }

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: args.tenantId,
        actorId: AUTONOMOUS_CLOSE_ACTOR,
        actorRole: 'system',
        eventType: 'agent.calling.close_owner_chain_queued',
        entityType: 'proposal',
        entityId: updatedHead.id,
        correlationId: chainId,
        metadata: {
          eligible: args.evaluation.eligible,
          ...(args.evaluation.eligible ? {} : { reason: args.evaluation.reason }),
          chainId,
          chainLength,
          sendProposalId: storedSend.id,
          ...(members[2] ? { bookingProposalId: members[2].id } : {}),
        },
      }),
    );
  }

  // ONE owner chain SMS through the existing one-tap machinery. Y approves the
  // capture-class head (drafting the estimate) + the capture-class booking; the
  // starred comms member (send_estimate) keeps its separate approval, exactly
  // as renderChainSms legends it. Nothing here approves anything.
  let smsSent = false;
  if (deps.routing?.sendSms && deps.routing.ownerPhoneResolver) {
    try {
      const ownerPhone = await deps.routing.ownerPhoneResolver(args.tenantId);
      if (ownerPhone) {
        const smsMembers: ChainSmsMember[] = members.map((m) => ({
          proposalType: m.proposalType,
          summary: m.summary,
          payload: m.payload,
        }));
        const result = await routeUnsupervisedProposal(deps.routing, {
          tenantId: args.tenantId,
          proposalId: updatedHead.id,
          channel: 'voice_inbound',
          ownerPhone,
          summaryText: updatedHead.summary,
          renderSmsBody: (approveUrl: string) =>
            renderChainSms(smsMembers, { approveUrl: approveUrl || undefined }),
          payload: updatedHead.payload,
        });
        smsSent = result.smsSent;
      }
    } catch (err) {
      logger.warn('close owner chain SMS failed', {
        proposalId: updatedHead.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { queued: true, smsSent };
}
