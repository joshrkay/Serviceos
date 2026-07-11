/**
 * D-018 (WS18d) — sanctioned on-call close: chain assembly, explicit system
 * approval, and the synchronous in-order close executor.
 *
 * The live voice agent has a caller-confirmed, consent-gated, catalog-clean
 * quote and a freshly-held slot; the lane (autonomous-close-lane.ts) said
 * every gate passes. This module turns that sanction into execution:
 *
 *   1. `assembleCloseChain` — retrofit the EXISTING drafted estimate proposal
 *      as chain head and mint the two dependents:
 *          draft_estimate → send_estimate($ref:chain[0].estimateId) → create_booking
 *      via `applyChainMetadata` (create_booking is deliberately unwired in
 *      chain.ts's ref map — its appointmentId is concrete, the already-held
 *      slot). Every member gets `sourceContext.autonomousCloseEvaluation`.
 *   2. `sanctionCloseChain` — the EXPLICIT SYSTEM APPROVAL. This is the
 *      analog of the owner's one-tap: `decideInitialStatus` and
 *      `actionClassForProposalType` are untouched (the comms member is still
 *      BORN blocked); each member is individually transitioned to 'approved'
 *      with a `proposal.system_approved` audit event naming the D-018
 *      sanction. `approvedAt` is backdated by UNDO_WINDOW_MS — the documented
 *      D-018 deviation from D-015's 5-second undo delay (caller-initiated +
 *      strict-confirmed + consent-gated ⇒ immediate execution; the safety net
 *      is the strict confirm gate + the owner UNDO) — so the executor's D-009
 *      undo-window gate treats the window as already elapsed WITHOUT any
 *      change to the executor itself.
 *   3. `executeCloseChain` — calls `executor.execute` per member IN ORDER on
 *      the live media-streams turn, exactly as the background sweep does
 *      (same WS11 audited transaction, same idempotency guard —
 *      `withResolvedIdempotencyKey` is applied inside the executor). Chain
 *      resolution threads member 0's resultEntityId (the estimateId) into
 *      send_estimate. Budgeted at CLOSE_EXECUTION_BUDGET_MS (the
 *      SMS_BEFORE_BRIDGE_TIMEOUT_MS precedent): past the deadline the
 *      remaining APPROVED members are left for the background sweep — the
 *      caller must never wait on a slow send.
 *   4. `sendCloseUndoSms` — the owner is texted IMMEDIATELY (success or
 *      timeout-partial) with a one-tap UNDO link minted against the
 *      create_booking member. The undo route compensates: booking canceled +
 *      apology; estimate withdrawn so the approval link stops accepting; the
 *      quote TEXT itself cannot be recalled and the copy says so.
 *   5. `queueCloseFallbackChain` — the no-carve-out mode for ANY failed gate:
 *      the estimate stays a draft, a send_estimate draft is chained to it,
 *      and the owner gets ONE renderChainSms one-tap SMS via the existing
 *      routeUnsupervisedProposal machinery. Nothing executes.
 */
import { v4 as uuidv4 } from 'uuid';
import {
  createProposal as buildProposal,
  type Proposal,
  type ProposalRepository,
} from './proposal';
import { applyChainMetadata } from './chain';
import { UNDO_WINDOW_MS } from './lifecycle';
import {
  autonomousCloseStamp,
  type AutonomousCloseEvaluation,
} from './autonomous-close-lane';
import { createOneTapUndoToken } from './one-tap-undo';
import {
  routeUnsupervisedProposal,
  type RouteUnsupervisedProposalDeps,
} from './auto-approve';
import { renderChainSms, type ChainSmsMember } from './sms/render';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { ExecutionContext } from './execution/handlers';
import type { ExecutionResult } from './execution/handlers';
import { createLogger } from '../logging/logger';

const logger = createLogger({
  service: 'proposals.autonomous-close',
  environment: process.env.NODE_ENV || 'development',
});

/** Actor stamped on the system approvals + executions of a sanctioned close. */
export const AUTONOMOUS_CLOSE_ACTOR = 'system:autonomous-close';

/**
 * Synchronous execution budget for the on-call close (~4s — the
 * SMS_BEFORE_BRIDGE_TIMEOUT_MS precedent). Past the deadline, remaining
 * approved members fall to the background execution sweep.
 */
export const CLOSE_EXECUTION_BUDGET_MS = 4000;

/** The executor surface the close flow calls — never the internals. */
export interface CloseChainExecutor {
  execute(
    proposal: Proposal,
    context: ExecutionContext,
  ): Promise<{ proposal: Proposal; result: ExecutionResult; alreadyExecuted?: boolean }>;
}

export interface CloseExecutionDeps {
  proposalRepo: ProposalRepository;
  executor: CloseChainExecutor;
  auditRepo?: AuditRepository;
}

export interface AssembledCloseChain {
  chainId: string;
  /** In execution order: [draft_estimate, send_estimate, create_booking]. */
  members: Proposal[];
}

export interface AssembleCloseChainArgs {
  tenantId: string;
  /** The live drafted estimate proposal (pendingQuote.proposalId). */
  draftEstimateProposalId: string;
  /** Verified caller — stamped onto the estimate payload (the handler requires it). */
  customerId: string;
  /** Job the work belongs to (also satisfies the estimate handler's container). */
  jobId?: string;
  /** Caller E.164 — the send_estimate SMS recipient (consent just captured). */
  callerPhone: string;
  /** The held appointment (place-hold.ts) the create_booking member confirms. */
  appointmentId: string;
  holdExpiryAt: Date;
  /** The all-gates-passed evaluation, stamped on every member. */
  evaluation: AutonomousCloseEvaluation;
  sessionId: string;
  summary: string;
}

/**
 * Assemble the three-member close chain. Returns null when the drafted
 * estimate proposal cannot be loaded (deleted / wrong tenant) — the caller
 * falls back to owner mode.
 */
export async function assembleCloseChain(
  deps: CloseExecutionDeps,
  args: AssembleCloseChainArgs,
): Promise<AssembledCloseChain | null> {
  const head = await deps.proposalRepo.findById(args.tenantId, args.draftEstimateProposalId);
  if (!head || head.proposalType !== 'draft_estimate') return null;

  const chainId = uuidv4();
  const stamp = autonomousCloseStamp(args.evaluation);

  // Member 0 — the existing drafted estimate becomes the chain head. The
  // execution handler requires a top-level customerId (or jobId); the live
  // draft deliberately carried neither (operator fills at review) — the close
  // sanction supplies the VERIFIED caller.
  const headPayload: Record<string, unknown> = {
    ...head.payload,
    customerId: args.customerId,
    ...(args.jobId ? { jobId: args.jobId } : {}),
  };
  const headSourceContext: Record<string, unknown> = {
    ...((head.sourceContext as Record<string, unknown> | undefined) ?? {}),
    chainId,
    chainIndex: 0,
    chainLength: 3,
    dependsOnChainIndices: [],
    chainRefs: [],
    ...stamp,
  };
  const updatedHead = await deps.proposalRepo.update(args.tenantId, head.id, {
    payload: headPayload,
    sourceContext: headSourceContext,
    chainId,
  });
  if (!updatedHead) return null;

  // Member 1 — send_estimate (comms class; BORN blocked by decideInitialStatus
  // — the sanction approves it explicitly in sanctionCloseChain, never here).
  // estimateId rides as a $ref token applyChainMetadata writes; the executor's
  // chain resolution swaps in member 0's resultEntityId at execution time.
  const sendMember = buildProposal({
    tenantId: args.tenantId,
    proposalType: 'send_estimate',
    payload: {
      channel: 'sms',
      recipient: args.callerPhone,
      estimateReference: 'the quote from this call',
    },
    summary: `Text the quote + booking link to the caller (${args.summary})`,
    sourceContext: {
      source: 'calling-agent',
      channel: 'telephony',
      sessionId: args.sessionId,
      ...stamp,
    },
    createdBy: AUTONOMOUS_CLOSE_ACTOR,
  });
  applyChainMetadata(sendMember, {
    chainId,
    chainIndex: 1,
    chainLength: 3,
    dependsOnChainIndices: [0],
    chainRefs: [{ payloadPath: 'estimateId', parentChainIndex: 0, entityKind: 'estimateId' }],
  });
  const storedSend = await deps.proposalRepo.create(sendMember);

  // Member 2 — create_booking confirms the ALREADY-HELD slot (concrete
  // appointmentId; create_booking is deliberately unwired in the chain ref
  // map — chaining a ref would double-book, chain.ts:180).
  const bookingMember = buildProposal({
    tenantId: args.tenantId,
    proposalType: 'create_booking',
    payload: { appointmentId: args.appointmentId },
    summary: args.summary,
    sourceContext: {
      source: 'calling-agent',
      channel: 'telephony',
      sessionId: args.sessionId,
      chainId,
      chainIndex: 2,
      chainLength: 3,
      dependsOnChainIndices: [1],
      chainRefs: [],
      ...stamp,
    },
    createdBy: AUTONOMOUS_CLOSE_ACTOR,
    expiresAt: args.holdExpiryAt,
  });
  bookingMember.chainId = chainId;
  const storedBooking = await deps.proposalRepo.create(bookingMember);

  return { chainId, members: [updatedHead, storedSend, storedBooking] };
}

/**
 * The explicit SYSTEM APPROVAL under the D-018 sanction — the analog of the
 * owner's one-tap, per member, audited. `approvedAt` is backdated by
 * UNDO_WINDOW_MS so the executor's D-009 undo-window gate treats the window
 * as elapsed (the documented D-018 immediate-execution deviation) without
 * modifying the executor. Returns the approved proposals in chain order.
 */
export async function sanctionCloseChain(
  deps: CloseExecutionDeps,
  tenantId: string,
  members: Proposal[],
): Promise<Proposal[]> {
  const approvedAt = new Date(Date.now() - UNDO_WINDOW_MS);
  const approved: Proposal[] = [];
  for (const member of members) {
    const updated = await deps.proposalRepo.updateStatus(tenantId, member.id, 'approved', {
      approvedAt,
    });
    if (!updated) throw new Error(`close sanction: proposal ${member.id} vanished`);
    if (deps.auditRepo) {
      await deps.auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId: AUTONOMOUS_CLOSE_ACTOR,
          actorRole: 'system',
          eventType: 'proposal.system_approved',
          entityType: 'proposal',
          entityId: member.id,
          correlationId: member.chainId ?? member.id,
          metadata: {
            sanction: 'D-018',
            proposalType: member.proposalType,
            chainId: member.chainId ?? null,
            // The undo-window deviation is explicit in the audit trail.
            undoWindowBypassed: true,
          },
        }),
      );
    }
    approved.push(updated);
  }
  return approved;
}

export interface CloseChainExecutionOutcome {
  /** True when every member executed successfully within the budget. */
  completed: boolean;
  /** True when the budget expired (remaining members left for the sweep). */
  timedOut: boolean;
  /** Ids of members that reported success before we stopped. */
  executedIds: string[];
  /** Set when a member FAILED (not timed out) — the first failure stops the loop. */
  failedId?: string;
  failureError?: string;
}

/**
 * The synchronous in-order close executor. Calls `executor.execute` per
 * member exactly as the background sweep does; the WS11 audited transaction
 * and the idempotency guard ride along inside the executor. A timeout does
 * NOT cancel an in-flight execution — its writes land; whatever is still
 * 'approved' afterwards is the background sweep's job (chain resolution
 * preserves ordering there too).
 */
export async function executeCloseChain(
  deps: CloseExecutionDeps,
  tenantId: string,
  members: Proposal[],
  budgetMs: number = CLOSE_EXECUTION_BUDGET_MS,
): Promise<CloseChainExecutionOutcome> {
  const deadline = Date.now() + budgetMs;
  const executedIds: string[] = [];
  const context: ExecutionContext = { tenantId, executedBy: AUTONOMOUS_CLOSE_ACTOR };

  for (const member of members) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { completed: false, timedOut: true, executedIds };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMarker = Symbol('close-budget');
    try {
      const raced = await Promise.race([
        deps.executor.execute(member, context),
        new Promise<typeof timeoutMarker>((resolve) => {
          timer = setTimeout(() => resolve(timeoutMarker), remaining);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      if (raced === timeoutMarker) {
        return { completed: false, timedOut: true, executedIds };
      }
      if (!raced.result.success) {
        return {
          completed: false,
          timedOut: false,
          executedIds,
          failedId: member.id,
          ...(raced.result.error ? { failureError: raced.result.error } : {}),
        };
      }
      executedIds.push(member.id);
    } catch (err) {
      // A thrown execute (lock contention, transient repo error) leaves the
      // member approved — the sweep retries it. Same posture as timeout.
      logger.warn('close executor: member threw — leaving to the sweep', {
        proposalId: member.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { completed: false, timedOut: true, executedIds };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { completed: true, timedOut: false, executedIds };
}

export interface CloseOwnerSmsDeps {
  sendSms(to: string, body: string): Promise<unknown>;
  resolveOwnerPhone(tenantId: string): Promise<string | null | undefined>;
  secret?: string;
  buildUndoUrl?: (token: string) => string;
  buildApproveUrl?: (token: string) => string;
}

/**
 * Owner UNDO SMS, sent IMMEDIATELY on close (full success AND timeout-partial
 * — the hold is placed and the members are approved either way). Minted
 * against the create_booking member; the undo route's D-018 extension also
 * withdraws the estimate. Best-effort: an SMS failure never unwinds the close.
 */
export async function sendCloseUndoSms(
  sms: CloseOwnerSmsDeps,
  args: { tenantId: string; bookingProposal: Proposal; summary: string },
): Promise<boolean> {
  try {
    if (!sms.secret || !sms.buildUndoUrl) return false;
    const ownerPhone = await sms.resolveOwnerPhone(args.tenantId);
    if (!ownerPhone) return false;
    const { token } = createOneTapUndoToken({
      proposalId: args.bookingProposal.id,
      tenantId: args.tenantId,
      secret: sms.secret,
    });
    await sms.sendSms(
      ownerPhone,
      `Rivet closed on the call: ${args.summary}. Quote sent by text. ` +
        `Tap to UNDO (cancels the booking + voids the quote; the text can't be recalled): ${sms.buildUndoUrl(token)}`,
    );
    return true;
  } catch (err) {
    logger.warn('close undo SMS failed', {
      proposalId: args.bookingProposal.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export interface CloseFallbackArgs {
  tenantId: string;
  draftEstimateProposalId: string;
  customerId?: string;
  callerPhone?: string;
  sessionId: string;
  /** First-failing gate — stamped on both members + the audit event. */
  evaluation: AutonomousCloseEvaluation;
}

/**
 * The no-carve-out fallback for ANY failed gate: leave the estimate a draft,
 * chain a send_estimate DRAFT to it, and send the owner ONE renderChainSms
 * one-tap SMS via the existing routeUnsupervisedProposal machinery (finding
 * 8). Idempotent per call: a head that is already chained skips re-assembly
 * (and re-texting) so a repeated "yes, book it" can't spam the owner.
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

  const chainId = uuidv4();
  const stamp = autonomousCloseStamp(args.evaluation);

  const headSourceContext: Record<string, unknown> = {
    ...((head.sourceContext as Record<string, unknown> | undefined) ?? {}),
    chainId,
    chainIndex: 0,
    chainLength: 2,
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
      sessionId: args.sessionId,
      ...stamp,
    },
    createdBy: AUTONOMOUS_CLOSE_ACTOR,
  });
  applyChainMetadata(sendMember, {
    chainId,
    chainIndex: 1,
    chainLength: 2,
    dependsOnChainIndices: [0],
    chainRefs: [{ payloadPath: 'estimateId', parentChainIndex: 0, entityKind: 'estimateId' }],
  });
  const storedSend = await deps.proposalRepo.create(sendMember);

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: args.tenantId,
        actorId: AUTONOMOUS_CLOSE_ACTOR,
        actorRole: 'system',
        eventType: 'agent.calling.close_fallback_queued',
        entityType: 'proposal',
        entityId: updatedHead.id,
        correlationId: chainId,
        metadata: {
          reason: args.evaluation.eligible ? 'unknown' : args.evaluation.reason,
          chainId,
          sendProposalId: storedSend.id,
        },
      }),
    );
  }

  // ONE owner chain SMS through the existing one-tap machinery. Y approves
  // the capture-class head (drafting the estimate); the starred comms member
  // keeps its separate approval, exactly as renderChainSms legends it.
  let smsSent = false;
  if (deps.routing?.sendSms && deps.routing.ownerPhoneResolver) {
    try {
      const ownerPhone = await deps.routing.ownerPhoneResolver(args.tenantId);
      if (ownerPhone) {
        const members: ChainSmsMember[] = [updatedHead, storedSend].map((m) => ({
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
            renderChainSms(members, { approveUrl: approveUrl || undefined }),
          payload: updatedHead.payload,
        });
        smsSent = result.smsSent;
      }
    } catch (err) {
      logger.warn('close fallback owner SMS failed', {
        proposalId: updatedHead.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { queued: true, smsSent };
}
