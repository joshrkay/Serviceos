/**
 * RV-071 — owner voice approval task.
 *
 * The dialogue engine behind "approve the Henderson estimate" on a
 * transport-identified owner line (RV-070's `ownerSession`). Channel-agnostic
 * and session-storage-agnostic: callers (the voice-turn processor and the
 * Gather adapter) hold the returned `PendingVoiceApproval` on the voice
 * session and feed the next utterance back in. The task never trusts an
 * utterance for identity and never acts without an explicit affirmative.
 *
 * Security note — PIN-in-transcript surface: spoken PINs necessarily appear
 * in the call transcript; transcript encryption (AES-256-GCM) is the at-rest
 * control; excluding the challenge turn from summaries is a tracked follow-up.
 *
 * Safety model (D1):
 *   1. Routing gate — only reachable when `ownerSession` is true; the
 *      task re-checks (defense in depth).
 *   2. Target resolution — RV-072 pendingProposals source (τ_ent=0.80,
 *      one clarification, ordinals only against the just-spoken list).
 *   3. READBACK — composed from the PROPOSAL PAYLOAD (type, customer,
 *      key facts, amount), never from the owner's utterance.
 *   4. Strict-affirmative confirm stage (deterministic `classifyStrictConfirm`,
 *      not an LLM) before `approveProposal` runs with channel 'voice'.
 *      Retargeting utterances ("approve the Acme invoice instead") → one
 *      re-ask. Second non-strict reply → keep pending, exit dialogue.
 *      Anything else → no action, the proposal stays pending.
 *   5. Money/irreversible classes additionally require the spoken
 *      challenge from `tenant_settings.escalation_settings
 *      .voice_approval_challenge` (interim JSONB home — see
 *      settings.ts). Unset → polite refusal + a one-tap approve SMS
 *      minted through the EXISTING `routeUnsupervisedProposal` machinery.
 *      Max 3 failed challenge attempts per voice session — counted on
 *      `VoiceApprovalSessionState` (session level, survives dialogue
 *      cancel/restart); the 3rd failure locks money/irreversible
 *      approvals for the rest of the session.
 *   6. Pending-edit parity — approval is blocked while
 *      `hasUnappliedEditRequest` (same guard as SMS reply and one-tap).
 */
import type { Proposal, ProposalRepository } from '../../proposals/proposal';
import { actionClassForProposalType } from '../../proposals/proposal';
import { formatUsdCentsFixed } from '@ai-service-os/shared';
import {
  approveChainSet,
  type ApproveChainSetResult,
  editProposal,
  formatChainSetApprovalMessage,
  rejectProposal,
  summarizeChainSetResult,
} from '../../proposals/actions';
import { routeUnsupervisedProposal } from '../../proposals/auto-approve';
import { renderProposalSms, renderReapprovalSms } from '../../proposals/sms/render';
import { payloadHeadlineCents } from '../../proposals/payload-money';
import {
  chainRefFieldsTouchedByDelta,
  type ProposalEditInterpreter,
} from '../../proposals/edit-interpreter';
import {
  type ProposalSmsEventRepository,
  type OutboundAnchorKind,
  createProposalSmsEvent,
} from '../../proposals/sms/sms-event';
import type { AppointmentRepository } from '../../appointments/appointment';
import { createAuditEvent, type AuditRepository } from '../../audit/audit';
import type { SettingsRepository } from '../../settings/settings';
import { resolveEscalationSettings } from '../../settings/settings';
import { ValidationError } from '../../shared/errors';
import { createLogger } from '../../logging/logger';
import { classifyVoiceApproval, classifyStrictConfirm } from '../tts/readback';
import {
  PendingProposalResolver,
  extractReferenceSignals,
  parseOrdinalReference,
} from '../resolution/pending-proposal-resolver';

const logger = createLogger({
  service: 'ai.tasks.proposal-approval',
  environment: process.env.NODE_ENV || 'development',
});

/** Synthetic actor for voice approvals (no Clerk session — identity is the recognized owner line (caller-ID match; see approver-identity.ts)). */
export const VOICE_APPROVAL_ACTOR_ID = 'voice_approval';

export type VoiceApprovalAction = 'approve' | 'reject';

export type VoiceApprovalStage =
  /** A clarification list was read; the next utterance picks one (name or ordinal). */
  | 'disambiguate'
  /** The readback was spoken; the next utterance must be an explicit affirmative. */
  | 'confirm'
  /** The affirmative landed on a money/irreversible target; the next utterance is the challenge. */
  | 'challenge';

/**
 * Dialogue state carried on the voice session between turns. Contains NO
 * secrets (the challenge value is re-read from settings at verify time)
 * and no payload copies — the proposal is re-fetched on every turn so a
 * meanwhile-handled target fails closed.
 */
export interface PendingVoiceApproval {
  action: VoiceApprovalAction;
  stage: VoiceApprovalStage;
  /** Set once a single target is resolved (confirm / challenge stages). */
  proposalId?: string;
  /** Ordered candidate ids exactly as read out (ordinal anchor). */
  orderedIds?: string[];
  /**
   * True when the confirm re-ask has already been issued once (strict-confirm
   * stage). Second non-strict reply → keep pending, exit dialogue.
   */
  confirmReaskIssued?: boolean;
}

/**
 * Session-level voice-approval state. Callers must carry this on the voice
 * session, pass it in via `VoiceApprovalSessionRef`, and merge each turn's
 * `VoiceApprovalTurnResult.sessionState` back into it. Unlike
 * `PendingVoiceApproval` it is NEVER cleared when a dialogue resolves —
 * canceling and restarting the approval dialogue must not reset it.
 */
export interface VoiceApprovalSessionState {
  /**
   * Failed challenge attempts in this VOICE SESSION (across restarted
   * dialogues — session-level so a cancel/restart cannot reset it).
   * Max 3 per session; the 3rd failure sets `challengeLockedOut`.
   */
  challengeFailCount?: number;
  /**
   * Set when the challenge lockout fires (3rd failed attempt this session).
   * Once true, money/irreversible approval dialogues are refused for the
   * rest of the session without prompting a new challenge. Capture-class
   * proposals (no challenge required) remain voice-approvable.
   */
  challengeLockedOut?: boolean;
  /**
   * Set after the one-tap SMS is sent following a challenge lockout.
   * Prevents re-texting the owner on every subsequent refused attempt —
   * subsequent refusal copy tells the owner the link was already sent.
   */
  oneTapSmsSentAfterLockout?: boolean;
}

export type VoiceApprovalOutcome =
  | 'denied_not_owner'
  | 'nothing_pending'
  | 'not_found'
  | 'clarification'
  | 'blocked_pending_edit'
  | 'refused_challenge_unset'
  | 'readback'
  | 'challenge_prompt'
  | 'challenge_failed'
  | 'challenge_lockout'
  | 'confirm_reask'
  | 'approved'
  | 'rejected'
  | 'kept_for_later'
  | 'approve_failed'
  | 'reject_failed'
  // RV-225 — voice edit dialogue outcomes. 'edited' = the delta was
  // applied (proposal stays pending); 'edit_recorded' = the instruction
  // could not be applied automatically and was recorded (blocking later
  // approval until it is resolved in the review queue).
  | 'edited'
  | 'edit_recorded'
  // Track E — the edit targeted a chained dependent whose payload still
  // holds an unresolved `$ref:chain[…]` token in a field the delta
  // touches. Refused: the edit would overwrite the chain wiring.
  | 'edit_blocked_chain_ref';

export interface VoiceApprovalTurnResult {
  /** TTS-ready line for this turn. */
  speak: string;
  /** Dialogue state to carry to the next turn; null clears it. */
  pending: PendingVoiceApproval | null;
  outcome: VoiceApprovalOutcome;
  proposalId?: string;
  /**
   * Session-level state mutations from this turn. Callers must merge this
   * into their VoiceApprovalSessionState. Absent when no session state changes.
   */
  sessionState?: Partial<VoiceApprovalSessionState>;
}

export interface OneTapFallbackDeps {
  /** Outbound SMS sender (existing message delivery). */
  sendSms?: (to: string, body: string) => Promise<void>;
  /** HMAC secret for the one-tap token (same as P12-004 wiring). */
  secret?: string;
  /** Builds the public approve URL from the signed token. */
  buildApproveUrl?: (token: string) => string;
  /** Owner/backup mobile resolver (same as unsupervised routing). */
  resolveOwnerPhone?: (tenantId: string) => Promise<string | null | undefined>;
  /** Records the outbound render so SMS Y/N replies anchor to it (P2-034). */
  recordSmsEvent?: (args: {
    tenantId: string;
    proposalId: string;
    body: string;
    kind: OutboundAnchorKind;
  }) => Promise<void>;
}

export interface VoiceApprovalDeps {
  proposalRepo: ProposalRepository;
  auditRepo?: AuditRepository;
  settingsRepo?: SettingsRepository;
  /**
   * Pending-edit parity guard — same repo method SMS reply and one-tap use.
   * RV-225: `create` is additionally used (when available) to record voice
   * edit requests / re-approval renders in the SAME event store, so a
   * voice-dictated edit that could not be applied blocks Y / one-tap /
   * voice approval exactly like an SMS edit request would.
   */
  smsEventRepo?: Pick<ProposalSmsEventRepository, 'hasUnappliedEditRequest'> &
    Partial<Pick<ProposalSmsEventRepository, 'create'>>;
  /** Lets a rejected create_booking release its held calendar slot. */
  appointmentRepo?: AppointmentRepository;
  /** One-tap SMS fallback for refused money/irreversible approvals. */
  oneTapFallback?: OneTapFallbackDeps;
  /**
   * RV-225 — shared edit-delta interpreter (proposals/edit-interpreter.ts,
   * the exact seam the SMS EDIT reply uses). Absent or returning null: the
   * instruction is recorded instead of applied — never a silent guess.
   */
  editInterpreter?: ProposalEditInterpreter;
}

export interface VoiceApprovalSessionRef {
  tenantId: string;
  /** Voice session id — audit correlation. */
  sessionId: string;
  /** RV-070 — MUST be true; re-checked here as defense in depth. */
  ownerSession: boolean;
  /** Session-level state (challenge lockout etc.) carried from previous turns. */
  sessionState?: VoiceApprovalSessionState;
}

// ─── Readback (payload-derived, never utterance-derived) ────────────────────

const formatCents = formatUsdCentsFixed;

function payloadCustomerName(payload: Record<string, unknown>): string | null {
  for (const key of ['customerName', 'displayName', 'name']) {
    const v = payload[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

function typeLabel(proposal: Proposal): string {
  switch (proposal.proposalType) {
    case 'draft_estimate':
    case 'update_estimate':
    case 'send_estimate':
      return 'estimate';
    case 'draft_invoice':
    case 'update_invoice':
    case 'issue_invoice':
    case 'send_invoice':
      return 'invoice';
    case 'create_appointment':
    case 'create_booking':
      return 'appointment';
    case 'record_payment':
      return 'payment';
    default:
      return proposal.proposalType.replace(/_/g, ' ');
  }
}

/**
 * Compose the spoken READBACK from the proposal PAYLOAD fields — type,
 * customer, key facts, amount — never from the owner's utterance and
 * never from the free-text summary. The invariant the unit tests pin:
 * the readback contains the payload's customer name and amount.
 */
export function composeReadback(proposal: Proposal, action: VoiceApprovalAction): string {
  const payload = (proposal.payload ?? {}) as Record<string, unknown>;
  const parts: string[] = [];

  const customer = payloadCustomerName(payload);
  parts.push(customer ? `${typeLabel(proposal)} for ${customer}` : typeLabel(proposal));

  const lineItems = payload.lineItems;
  if (Array.isArray(lineItems) && lineItems.length > 0) {
    parts.push(`${lineItems.length} line item${lineItems.length === 1 ? '' : 's'}`);
  }
  for (const key of ['dateTimeDescription', 'scheduledStart'] as const) {
    const v = payload[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      parts.push(v.trim());
      break;
    }
  }

  const cents = payloadHeadlineCents(payload);
  if (cents !== null) parts.push(`total ${formatCents(cents)}`);

  const question = action === 'approve' ? 'approve it?' : 'reject it?';
  const head = parts.join(', ');
  return `${head.charAt(0).toUpperCase()}${head.slice(1)} — ${question}`;
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function audit(
  deps: VoiceApprovalDeps,
  ref: VoiceApprovalSessionRef,
  eventType: string,
  proposalId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  if (!deps.auditRepo) return;
  try {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId: ref.tenantId,
        actorId: VOICE_APPROVAL_ACTOR_ID,
        actorRole: 'system',
        eventType,
        entityType: 'proposal',
        entityId: proposalId || ref.sessionId,
        correlationId: ref.sessionId,
        metadata: { ...metadata, channel: 'voice', sessionId: ref.sessionId },
      }),
    );
  } catch {
    // Audit is best-effort here; the proposal mutations carry their own
    // proposal.approved / proposal.rejected events via actions.ts.
  }
}

function requiresChallenge(proposal: Proposal): boolean {
  const cls = actionClassForProposalType(proposal.proposalType);
  return cls === 'money' || cls === 'irreversible';
}

async function readChallenge(
  deps: VoiceApprovalDeps,
  tenantId: string,
): Promise<string | null> {
  if (!deps.settingsRepo) return null;
  try {
    const settings = await deps.settingsRepo.findByTenant(tenantId);
    const challenge = resolveEscalationSettings(settings).voice_approval_challenge;
    return typeof challenge === 'string' && challenge.trim().length > 0
      ? challenge.trim()
      : null;
  } catch {
    // Fail closed: unreadable settings behave like "no challenge
    // configured" → money/irreversible approvals are refused.
    return null;
  }
}

const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

/** "four two seven one" / "4 2 7 1" / "4271." → "4271". */
export function spokenDigits(utterance: string): string {
  return utterance
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w) => DIGIT_WORDS[w] ?? (/^\d+$/.test(w) ? w : ''))
    .join('');
}

const NOT_FOUND_LINE =
  "I couldn't find a pending proposal matching that — it may already be handled. Check your review queue when you get a chance.";
const KEEP_FOR_LATER_LINE =
  "No problem — I'll keep it in your review queue for later.";

/**
 * `totalCount` is the PRE-cap candidate count so the spoken line is
 * truthful when more matched than we read out ("I found 8 — here are
 * the first 5"), instead of misreporting the capped list length.
 */
function clarificationLine(candidates: Proposal[], totalCount: number): string {
  const shown = candidates.slice(0, 5);
  const listed = shown.map((p, i) => `${i + 1}: ${p.summary}`).join('. ');
  if (totalCount > shown.length) {
    return `I found ${totalCount} pending — here are the first ${shown.length}: ${listed}. Which one?`;
  }
  return `I found ${totalCount} pending: ${listed}. Which one?`;
}

/**
 * One-tap SMS fallback for a refused money/irreversible voice approval.
 * Reuses the EXISTING `routeUnsupervisedProposal` mint+send+audit
 * machinery (P12-004 / P2-034) — no duplicate token or SMS logic here.
 * Returns true when the SMS actually went out.
 */
async function sendOneTapFallback(
  deps: VoiceApprovalDeps,
  ref: VoiceApprovalSessionRef,
  proposal: Proposal,
): Promise<boolean> {
  const fallback = deps.oneTapFallback;
  if (!fallback || !deps.auditRepo) return false;
  try {
    const ownerPhone = await fallback.resolveOwnerPhone?.(ref.tenantId);
    const result = await routeUnsupervisedProposal(
      {
        auditRepo: deps.auditRepo,
        ...(fallback.sendSms ? { sendSms: fallback.sendSms } : {}),
        ...(fallback.secret ? { secret: fallback.secret } : {}),
        ...(fallback.buildApproveUrl ? { buildApproveUrl: fallback.buildApproveUrl } : {}),
        ...(fallback.recordSmsEvent
          ? {
              onSmsSent: async ({
                body,
                kind,
              }: {
                body: string;
                kind: OutboundAnchorKind;
              }) =>
                fallback.recordSmsEvent!({
                  tenantId: ref.tenantId,
                  proposalId: proposal.id,
                  body,
                  kind,
                }),
            }
          : {}),
      },
      {
        tenantId: ref.tenantId,
        proposalId: proposal.id,
        // The owner explicitly asked to act on this proposal — always try
        // the SMS regardless of the tenant's unsupervised routing setting.
        routing: 'queue_and_sms',
        channel: 'voice_inbound',
        // Track-E — sanctioned non-capture approval: this fallback only fires
        // for a refused money/irreversible voice approval the owner explicitly
        // requested, so the minted one-tap link is flagged to clear the
        // redeem-side class gate. An ordinary digest/queue link is not.
        confirmNonCapture: true,
        ...(ownerPhone ? { ownerPhone } : {}),
        summaryText: proposal.summary,
        renderSmsBody: (approveUrl: string) =>
          renderProposalSms(
            {
              proposalType: proposal.proposalType,
              summary: proposal.summary,
              payload: proposal.payload,
            },
            { approveUrl: approveUrl || undefined },
          ),
        // RV-074 (F-4) — pass payload so the routing site can guard
        // low/very_low proposals against one-tap Y-able links.
        payload: proposal.payload,
      },
    );
    return result.smsSent;
  } catch (err) {
    logger.warn('voice approval one-tap SMS fallback failed', {
      tenantId: ref.tenantId,
      proposalId: proposal.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Shared guard + readback step once a single target proposal is in hand.
 */
async function prepareResolvedTarget(
  deps: VoiceApprovalDeps,
  ref: VoiceApprovalSessionRef,
  proposal: Proposal,
  action: VoiceApprovalAction,
): Promise<VoiceApprovalTurnResult> {
  // Pending-edit parity (approve only — rejecting stays allowed, same as SMS).
  if (
    action === 'approve' &&
    deps.smsEventRepo &&
    (await deps.smsEventRepo.hasUnappliedEditRequest(ref.tenantId, proposal.id))
  ) {
    await audit(deps, ref, 'proposal.voice_approve_blocked_pending_edit', proposal.id);
    return {
      speak:
        'You asked to change that one — your note is attached. Review and approve it in your queue.',
      pending: null,
      outcome: 'blocked_pending_edit',
      proposalId: proposal.id,
    };
  }

  // Challenge lockout — 3 failed attempts this session; refuse without prompting.
  // Send-once: the one-tap SMS is sent on the FIRST post-lockout refusal only —
  // subsequent attempts get a "link already sent" message to avoid re-texting
  // the owner on every repeated attempt.
  if (action === 'approve' && requiresChallenge(proposal) && ref.sessionState?.challengeLockedOut) {
    const alreadySent = ref.sessionState.oneTapSmsSentAfterLockout === true;
    const smsSent = alreadySent ? false : await sendOneTapFallback(deps, ref, proposal);
    await audit(deps, ref, 'proposal.voice_approve_refused_challenge_lockout', proposal.id, {
      proposalType: proposal.proposalType,
      oneTapSmsSent: smsSent,
      smsSendSkippedAlreadySent: alreadySent,
    });
    const sessionState: Partial<VoiceApprovalSessionState> | undefined =
      smsSent ? { oneTapSmsSentAfterLockout: true } : undefined;
    const speak = alreadySent
      ? "For security, I can’t take that approval by voice this call. The text link was already sent."
      : smsSent
      ? "For security, I can’t take that approval by voice right now — I’ve sent you a text link instead."
      : "For security, I can’t take that approval by voice right now. Use the app or your review queue.";
    return {
      speak,
      pending: null,
      outcome: 'challenge_lockout',
      proposalId: proposal.id,
      ...(sessionState ? { sessionState } : {}),
    };
  }

  // Money/irreversible approvals need the spoken challenge; without one
  // configured they are politely refused and the one-tap SMS goes out.
  if (action === 'approve' && requiresChallenge(proposal)) {
    const challenge = await readChallenge(deps, ref.tenantId);
    if (!challenge) {
      const smsSent = await sendOneTapFallback(deps, ref, proposal);
      await audit(deps, ref, 'proposal.voice_approve_refused_no_challenge', proposal.id, {
        proposalType: proposal.proposalType,
        oneTapSmsSent: smsSent,
      });
      return {
        speak: smsSent
          ? 'That one needs a tap to confirm — I’ve sent you a text link.'
          : 'That one needs a tap to confirm — check the app or your review queue.',
        pending: null,
        outcome: 'refused_challenge_unset',
        proposalId: proposal.id,
      };
    }
  }

  const readback = composeReadback(proposal, action);
  await audit(deps, ref, 'proposal.voice_approval_readback', proposal.id, {
    action,
    proposalType: proposal.proposalType,
  });
  return {
    speak: readback,
    pending: { action, stage: 'confirm', proposalId: proposal.id },
    outcome: 'readback',
    proposalId: proposal.id,
  };
}

async function fetchReviewable(
  deps: VoiceApprovalDeps,
  tenantId: string,
  proposalId: string,
): Promise<Proposal | null> {
  const proposal = await deps.proposalRepo.findById(tenantId, proposalId);
  if (!proposal) return null;
  if (proposal.status !== 'draft' && proposal.status !== 'ready_for_review') return null;
  return proposal;
}

async function executeApprove(
  deps: VoiceApprovalDeps,
  ref: VoiceApprovalSessionRef,
  proposalId: string,
): Promise<VoiceApprovalTurnResult> {
  // Track E — confirm-stage race: `prepareResolvedTarget` checked the
  // pending-edit guard at READBACK time, but between the readback and the
  // owner's "yes" (and, for money targets, the challenge turn) an SMS
  // edit_request may have landed. Re-run the guard at the moment the
  // mutation would actually apply, so a strict affirmative can never
  // execute a payload the owner just asked to change.
  if (
    deps.smsEventRepo &&
    (await deps.smsEventRepo.hasUnappliedEditRequest(ref.tenantId, proposalId))
  ) {
    await audit(deps, ref, 'proposal.voice_approve_blocked_pending_edit', proposalId, {
      stage: 'confirm',
    });
    return {
      speak:
        'You asked to change that one — your note is attached. Review and approve it in your queue.',
      pending: null,
      outcome: 'blocked_pending_edit',
      proposalId,
    };
  }

  let approved: Proposal;
  let approvedCount = 0;
  let skippedCount = 0;
  let skipped: ApproveChainSetResult['skipped'] = [];
  try {
    const result = await approveChainSet(
      deps.proposalRepo,
      ref.tenantId,
      proposalId,
      VOICE_APPROVAL_ACTOR_ID,
      'owner',
      deps.auditRepo,
      'voice', // RV-073 — voice approval channel
      deps.smsEventRepo
        ? (tenantId, id) => deps.smsEventRepo!.hasUnappliedEditRequest(tenantId, id)
        : undefined,
    );
    const summary = summarizeChainSetResult(result);
    approved = result.approved[0];
    approvedCount = summary.approvedCount;
    skippedCount = summary.followCount;
    skipped = summary.skipped;
  } catch (err) {
    if (err instanceof ValidationError) {
      await audit(deps, ref, 'proposal.voice_approve_blocked', proposalId, {
        error: err.message,
      });
      return {
        speak:
          "Can't approve that yet — it's missing required info. Finish it in your review queue.",
        pending: null,
        outcome: 'approve_failed',
        proposalId,
      };
    }
    await audit(deps, ref, 'proposal.voice_approve_failed', proposalId, {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      speak: 'Couldn’t approve that — it may already be handled. Check your review queue.',
      pending: null,
      outcome: 'approve_failed',
      proposalId,
    };
  }
  await audit(deps, ref, 'proposal.voice_approved', approved.id, {
    proposalType: approved.proposalType,
    approvedCount,
    skippedCount,
    skipped,
  });
  return {
    speak: formatChainSetApprovalMessage(
      { approvedCount, followCount: skippedCount, skipped },
      `Approved — "${approved.summary}" will run shortly.`,
    ),
    pending: null,
    outcome: 'approved',
    proposalId: approved.id,
  };
}

async function executeReject(
  deps: VoiceApprovalDeps,
  ref: VoiceApprovalSessionRef,
  proposalId: string,
): Promise<VoiceApprovalTurnResult> {
  let rejected: Proposal;
  try {
    rejected = await rejectProposal(
      deps.proposalRepo,
      ref.tenantId,
      proposalId,
      VOICE_APPROVAL_ACTOR_ID,
      'owner',
      'Rejected by voice approval',
      undefined,
      deps.appointmentRepo,
      deps.auditRepo,
      'voice', // RV-073 — voice approval channel
    );
  } catch (err) {
    await audit(deps, ref, 'proposal.voice_reject_failed', proposalId, {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      speak: 'Couldn’t reject that — it may already be handled. Check your review queue.',
      pending: null,
      outcome: 'reject_failed',
      proposalId,
    };
  }
  await audit(deps, ref, 'proposal.voice_rejected', rejected.id, {
    proposalType: rejected.proposalType,
  });
  return {
    speak: `Rejected — "${rejected.summary}" won't run.`,
    pending: null,
    outcome: 'rejected',
    proposalId: rejected.id,
  };
}

// ─── Turn 1 — start ──────────────────────────────────────────────────────────

export interface StartVoiceApprovalInput extends VoiceApprovalSessionRef {
  action: VoiceApprovalAction;
  /**
   * The owner's words identifying the target — classifier
   * `proposalReference` when extracted, else the raw utterance (the
   * signal extractor strips intent verbs/fillers).
   */
  reference: string;
}

export async function startVoiceApproval(
  deps: VoiceApprovalDeps,
  input: StartVoiceApprovalInput,
): Promise<VoiceApprovalTurnResult> {
  // Defense in depth — routing already gates on ownerSession (RV-070).
  if (!input.ownerSession) {
    await audit(deps, input, 'proposal.voice_approval_denied_not_owner', '', {
      action: input.action,
    });
    return {
      speak: 'I can’t take approvals on this line. How else can I help?',
      pending: null,
      outcome: 'denied_not_owner',
    };
  }

  const resolver = new PendingProposalResolver(deps.proposalRepo);
  const { result, pending } = await resolver.resolve({
    tenantId: input.tenantId,
    reference: input.reference,
  });

  switch (result.kind) {
    case 'resolved': {
      const proposal = pending.find((p) => p.id === result.candidate.id);
      if (!proposal) {
        return { speak: NOT_FOUND_LINE, pending: null, outcome: 'not_found' };
      }
      return prepareResolvedTarget(deps, input, proposal, input.action);
    }
    case 'ambiguous': {
      const candidates = result.candidates
        .map((c) => pending.find((p) => p.id === c.id))
        .filter((p): p is Proposal => Boolean(p));
      await audit(deps, input, 'proposal.voice_approval_clarification', '', {
        action: input.action,
        candidateCount: candidates.length,
      });
      return {
        speak: clarificationLine(candidates, candidates.length),
        pending: {
          action: input.action,
          stage: 'disambiguate',
          orderedIds: candidates.map((p) => p.id),
        },
        outcome: 'clarification',
      };
    }
    case 'not_found':
    case 'skipped': {
      // A reference with NO usable signals ("approve it") falls back to
      // the SMS-like behavior: a single pending proposal is the only
      // thing the owner can mean (the readback still gates); several →
      // ONE clarification; none → truthful nothing-pending.
      const signals = extractReferenceSignals(input.reference);
      const hasSignals =
        signals.nameTokens.length > 0 ||
        signals.types !== null ||
        signals.amountCents !== null ||
        parseOrdinalReference(input.reference) !== null;
      if (!hasSignals) {
        if (pending.length === 0) {
          await audit(deps, input, 'proposal.voice_approval_nothing_pending', '');
          return {
            speak: 'Nothing is waiting for your approval right now.',
            pending: null,
            outcome: 'nothing_pending',
          };
        }
        if (pending.length === 1) {
          return prepareResolvedTarget(deps, input, pending[0], input.action);
        }
        const candidates = pending.slice(0, 5);
        await audit(deps, input, 'proposal.voice_approval_clarification', '', {
          action: input.action,
          candidateCount: candidates.length,
          totalPending: pending.length,
        });
        return {
          // Thread the PRE-cap total so the spoken count is truthful
          // when more than 5 proposals are pending (M3).
          speak: clarificationLine(candidates, pending.length),
          pending: {
            action: input.action,
            stage: 'disambiguate',
            orderedIds: candidates.map((p) => p.id),
          },
          outcome: 'clarification',
        };
      }
      await audit(deps, input, 'proposal.voice_approval_target_not_found', '', {
        action: input.action,
      });
      return { speak: NOT_FOUND_LINE, pending: null, outcome: 'not_found' };
    }
  }
}

// ─── RV-225 — voice edit dialogue ────────────────────────────────────────────

/**
 * Spoken confirmation of an APPLIED edit, composed from the UPDATED
 * payload — the same payload-not-utterance provenance rule as
 * `composeReadback`. The proposal stays pending: editing never approves.
 */
export function composeEditedReadback(proposal: Proposal): string {
  const payload = (proposal.payload ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const customer = payloadCustomerName(payload);
  parts.push(customer ? `${typeLabel(proposal)} for ${customer}` : typeLabel(proposal));
  const cents = payloadHeadlineCents(payload);
  if (cents !== null) parts.push(`total ${formatCents(cents)}`);
  const head = parts.join(', ');
  return `Updated — ${head}. It stays pending; say "approve it" when you're ready.`;
}

const EDIT_RECORDED_LINE =
  'I couldn’t apply that automatically, so I attached your note to the proposal. Finish it in your review queue.';

/**
 * Record a voice edit request in the SAME proposal_sms_events store the
 * SMS EDIT flow uses, so `hasUnappliedEditRequest` blocks approval on
 * EVERY channel (voice, SMS Y, one-tap) until the request is resolved.
 * Best-effort when the deps only wire the read side.
 */
async function recordVoiceEditEvent(
  deps: VoiceApprovalDeps,
  tenantId: string,
  proposalId: string,
  kind: 'edit_request' | 'reapproval_rendered' | 'voice_reapproval',
  body: string,
): Promise<void> {
  if (!deps.smsEventRepo?.create) return;
  await deps.smsEventRepo.create(
    createProposalSmsEvent({
      tenantId,
      proposalId,
      direction: kind === 'edit_request' ? 'inbound' : 'outbound',
      kind,
      body,
    }),
  );
}

/**
 * Track E (architect ruling) — deliver the re-approval render after an
 * APPLIED voice edit.
 *
 * The pre-fix behavior recorded `reapproval_rendered` for a message that
 * was never sent, making the voice-edited proposal the owner's latest
 * SMS reply anchor — a later texted Y would have targeted a proposal the
 * owner never received text for (retargeting hazard).
 *
 *   WIRED (oneTapFallback.sendSms + a resolvable owner phone): send the
 *     REAL re-render SMS through the existing m156–158 re-approval
 *     machinery (`renderReapprovalSms`, the exact body the SMS edit path
 *     sends) and record `reapproval_rendered` from the actual send —
 *     send FIRST, record after, so an unsent render never anchors.
 *   UNWIRED (or the send failed): record `voice_reapproval` instead —
 *     the owner heard the updated values read back on the call, so the
 *     pending-edit block clears, but the kind is EXCLUDED from
 *     findRecentOutbound and can never become a reply anchor.
 */
async function deliverVoiceEditReapproval(
  deps: VoiceApprovalDeps,
  ref: VoiceApprovalSessionRef,
  updated: Proposal,
  instruction: string,
  spokenReadback: string,
): Promise<void> {
  const fallback = deps.oneTapFallback;
  let ownerPhone: string | null | undefined;
  if (fallback?.sendSms && fallback.resolveOwnerPhone) {
    try {
      ownerPhone = await fallback.resolveOwnerPhone(ref.tenantId);
    } catch {
      ownerPhone = undefined;
    }
  }

  if (fallback?.sendSms && ownerPhone) {
    const body = renderReapprovalSms(
      {
        proposalType: updated.proposalType,
        summary: updated.summary,
        payload: updated.payload,
      },
      instruction,
    );
    try {
      await fallback.sendSms(ownerPhone, body);
      // Real send → real anchor. Clears hasUnappliedEditRequest and, like
      // the SMS re-render, becomes the latest reply target so a later
      // texted Y correctly targets the proposal just edited.
      await recordVoiceEditEvent(deps, ref.tenantId, updated.id, 'reapproval_rendered', body);
      return;
    } catch (err) {
      await audit(deps, ref, 'proposal.voice_reapproval_send_failed', updated.id, {
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through: the spoken readback was still delivered on the call.
    }
  }

  await recordVoiceEditEvent(deps, ref.tenantId, updated.id, 'voice_reapproval', spokenReadback);
}

export interface StartVoiceEditInput extends VoiceApprovalSessionRef {
  /** The owner's words identifying the target proposal (or the utterance). */
  reference: string;
  /** The owner's change instruction ("change the second line to $200"). */
  instruction: string;
}

/**
 * RV-225 — "change the second line to $200" on a verified owner line.
 *
 *   1. Owner gate (defense in depth — routing already gates).
 *   2. Target resolution via the SAME pendingProposals resolver the
 *      approve dialogue uses (single-pending fallback included).
 *   3. The instruction is recorded as an `edit_request` FIRST (SMS-flow
 *      parity): if the apply fails — or never happens — approval stays
 *      blocked by `hasUnappliedEditRequest` until the queue resolves it.
 *   4. Delta interpretation via the shared `editInterpreter` seam, applied
 *      through the EXISTING `editProposal` path (Zod-validated merge, same
 *      audit). On success a `reapproval_rendered` event clears the block
 *      and the EDITED values are read back from the UPDATED payload.
 *   5. The proposal stays pending — an edit never approves anything.
 */
export async function startVoiceEdit(
  deps: VoiceApprovalDeps,
  input: StartVoiceEditInput,
): Promise<VoiceApprovalTurnResult> {
  if (!input.ownerSession) {
    await audit(deps, input, 'proposal.voice_edit_denied_not_owner', '');
    return {
      speak: 'I can’t take changes to pending work on this line. How else can I help?',
      pending: null,
      outcome: 'denied_not_owner',
    };
  }

  // ── Target resolution (same source as the approve dialogue) ──
  const resolver = new PendingProposalResolver(deps.proposalRepo);
  const { result, pending } = await resolver.resolve({
    tenantId: input.tenantId,
    reference: input.reference,
  });

  let proposal: Proposal | undefined;
  if (result.kind === 'resolved') {
    proposal = pending.find((p) => p.id === result.candidate.id);
  } else if (result.kind === 'not_found' || result.kind === 'skipped') {
    // No usable signals ("change it to $200") + exactly one pending →
    // that one is the only thing the owner can mean.
    const signals = extractReferenceSignals(input.reference);
    const hasSignals =
      signals.nameTokens.length > 0 ||
      signals.types !== null ||
      signals.amountCents !== null ||
      parseOrdinalReference(input.reference) !== null;
    if (!hasSignals && pending.length === 1) {
      proposal = pending[0];
    } else if (!hasSignals && pending.length === 0) {
      await audit(deps, input, 'proposal.voice_edit_nothing_pending', '');
      return {
        speak: 'Nothing is waiting for your review right now.',
        pending: null,
        outcome: 'nothing_pending',
      };
    }
  }

  if (!proposal && result.kind === 'ambiguous') {
    // ONE spoken clarification, stateless: the owner repeats the command
    // with a clearer reference ("change the HENDERSON estimate to ...").
    const candidates = result.candidates
      .map((c) => pending.find((p) => p.id === c.id))
      .filter((p): p is Proposal => Boolean(p));
    await audit(deps, input, 'proposal.voice_edit_clarification', '', {
      candidateCount: candidates.length,
    });
    return {
      speak: `${clarificationLine(candidates, candidates.length)} Say the change again with that one's name.`,
      pending: null,
      outcome: 'clarification',
    };
  }

  if (!proposal) {
    await audit(deps, input, 'proposal.voice_edit_target_not_found', '');
    return { speak: NOT_FOUND_LINE, pending: null, outcome: 'not_found' };
  }

  // ── Record-first (SMS parity), then interpret + apply ──
  await recordVoiceEditEvent(deps, input.tenantId, proposal.id, 'edit_request', input.instruction);

  if (deps.editInterpreter) {
    try {
      const delta = await deps.editInterpreter({ proposal, instruction: input.instruction });
      if (delta && Object.keys(delta).length > 0) {
        // Track E — chain-ref guard: a chained dependent can hold unresolved
        // `$ref:chain[N].…` tokens (resolved from the parent's resultEntityId
        // at execution time). A delta touching one of those fields would
        // overwrite the chain wiring — refuse with a clear spoken line.
        // (Deltas that DON'T touch the token field already fail closed for
        // uuid-typed contract fields: editProposal Zod-validates the merged
        // payload and the still-present token is not a uuid — see
        // chainRefFieldsTouchedByDelta in proposals/edit-interpreter.ts.)
        const refFields = chainRefFieldsTouchedByDelta(proposal.payload, delta);
        if (refFields.length > 0) {
          await audit(deps, input, 'proposal.voice_edit_blocked_chain_ref', proposal.id, {
            fields: refFields,
          });
          // Stamp sourceContext so the review queue shows WHAT the owner asked
          // to change — parity with the edit_recorded path and the SMS handler.
          // The edit_request was already recorded above (record-first parity),
          // so approval is blocked on every channel until the queue resolves it.
          await deps.proposalRepo.update(input.tenantId, proposal.id, {
            sourceContext: {
              ...(proposal.sourceContext ?? {}),
              pendingVoiceEditRequest: {
                instruction: input.instruction,
                receivedAt: new Date().toISOString(),
              },
            },
          });
          return {
            speak:
              'That one’s waiting on an earlier step — approval by text is paused until then. Edit it after that step runs.',
            pending: null,
            outcome: 'edit_blocked_chain_ref',
            proposalId: proposal.id,
          };
        }
        // editProposal Zod-validates the merged payload — a hallucinated
        // delta fails closed into the recorded-note path below.
        const { proposal: updated, editedFields } = await editProposal(
          deps.proposalRepo,
          input.tenantId,
          proposal.id,
          VOICE_APPROVAL_ACTOR_ID,
          'owner',
          delta,
          deps.auditRepo,
        );
        const speak = composeEditedReadback(updated);
        // Clears hasUnappliedEditRequest (insertion order decides). When the
        // SMS deps are wired this also sends the REAL re-render text and
        // anchors it; otherwise a voice_reapproval row clears the block
        // without ever becoming a reply anchor (see deliverVoiceEditReapproval).
        await deliverVoiceEditReapproval(deps, input, updated, input.instruction, speak);
        await audit(deps, input, 'proposal.voice_edited', updated.id, {
          proposalType: updated.proposalType,
          editedFields,
        });
        return { speak, pending: null, outcome: 'edited', proposalId: updated.id };
      }
    } catch (err) {
      await audit(deps, input, 'proposal.voice_edit_failed', proposal.id, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // No interpreter, an empty delta, or a failed/invalid one: the request
  // stays recorded (edit_request — approval is blocked on every channel)
  // and the instruction is stamped on sourceContext so the review queue
  // shows WHAT the owner asked to change. Never a silent guess.
  await deps.proposalRepo.update(input.tenantId, proposal.id, {
    sourceContext: {
      ...(proposal.sourceContext ?? {}),
      pendingVoiceEditRequest: {
        instruction: input.instruction,
        receivedAt: new Date().toISOString(),
      },
    },
  });
  await audit(deps, input, 'proposal.voice_edit_requested', proposal.id);
  return {
    speak: EDIT_RECORDED_LINE,
    pending: null,
    outcome: 'edit_recorded',
    proposalId: proposal.id,
  };
}

// ─── Turn 2+ — continue ──────────────────────────────────────────────────────

export interface ContinueVoiceApprovalInput extends VoiceApprovalSessionRef {
  utterance: string;
  pending: PendingVoiceApproval;
}

/**
 * The reject readback asks "— reject it?", so the natural affirmative is
 * "yes, reject it" — but `classifyStrictConfirm` counts "reject" as a
 * cancel word. Strip the echoed verb for the reject flow, and accept the
 * bare echo ("reject"/"reject it") as an affirmative.
 *
 * Returns: 'approve' | 'reject' | 'reask' | 'unknown' (strict semantics).
 */
function strictConfirmDecision(
  action: VoiceApprovalAction,
  utterance: string,
): ReturnType<typeof classifyStrictConfirm> | 'repeat' {
  // Repeat is a special case that bypasses strict-confirm — re-speak
  // the readback without consuming the re-ask slot.
  if (classifyVoiceApproval(utterance) === 'repeat') return 'repeat';
  if (action === 'reject') {
    if (/^\s*(please\s+)?reject( it| that( one)?)?[.! ]*$/i.test(utterance)) return 'approve';
    return classifyStrictConfirm(utterance.replace(/\breject(ing|ed)?\b/gi, ' '));
  }
  return classifyStrictConfirm(utterance);
}

export async function continueVoiceApproval(
  deps: VoiceApprovalDeps,
  input: ContinueVoiceApprovalInput,
): Promise<VoiceApprovalTurnResult> {
  if (!input.ownerSession) {
    // The session flag cannot change mid-call, but fail closed anyway.
    return {
      speak: 'I can’t take approvals on this line. How else can I help?',
      pending: null,
      outcome: 'denied_not_owner',
    };
  }
  const { pending } = input;

  // 'disambiguate' — re-resolve the reply against the just-spoken list.
  if (pending.stage === 'disambiguate') {
    const resolver = new PendingProposalResolver(deps.proposalRepo);
    const { result, pending: reviewable } = await resolver.resolve({
      tenantId: input.tenantId,
      reference: input.utterance,
      ...(pending.orderedIds ? { orderedIds: pending.orderedIds } : {}),
    });
    if (result.kind === 'resolved') {
      const proposal = reviewable.find((p) => p.id === result.candidate.id);
      if (proposal) {
        return prepareResolvedTarget(deps, input, proposal, pending.action);
      }
    }
    // ONE clarification only — anything that still doesn't resolve keeps
    // everything pending and hands the queue back to the owner.
    await audit(deps, input, 'proposal.voice_approval_clarification_failed', '', {
      action: pending.action,
    });
    return {
      speak: "I'll leave those in your review queue — you can approve them in the app.",
      pending: null,
      outcome: 'kept_for_later',
    };
  }

  if (!pending.proposalId) {
    return { speak: KEEP_FOR_LATER_LINE, pending: null, outcome: 'kept_for_later' };
  }

  // The target is re-fetched every turn — a meanwhile-handled proposal
  // (dashboard approval, SMS Y) fails closed with a truthful line.
  const proposal = await fetchReviewable(deps, input.tenantId, pending.proposalId);
  if (!proposal) {
    await audit(deps, input, 'proposal.voice_approval_stale_target', pending.proposalId);
    return {
      speak: 'That one was already handled — nothing changed.',
      pending: null,
      outcome: 'not_found',
      proposalId: pending.proposalId,
    };
  }

  // 'confirm' — strict affirmative required to prevent retargeting attacks.
  // Policy: approval ONLY when utterance is a short affirmative (≤3 words,
  // approve-word set only, no other content). Anything else → one re-ask;
  // second non-strict reply → keep pending, exit. Negation always cancels.
  if (pending.stage === 'confirm') {
    const decision = strictConfirmDecision(pending.action, input.utterance);

    // Repeat — re-speak the readback without consuming the re-ask slot.
    if (decision === 'repeat') {
      return {
        speak: composeReadback(proposal, pending.action),
        pending,
        outcome: 'readback',
        proposalId: proposal.id,
      };
    }

    // Negation dominates — keep pending, exit without re-ask.
    if (decision === 'reject') {
      await audit(deps, input, 'proposal.voice_approval_declined', proposal.id, {
        action: pending.action,
        decision,
      });
      return {
        speak: KEEP_FOR_LATER_LINE,
        pending: null,
        outcome: 'kept_for_later',
        proposalId: proposal.id,
      };
    }

    // Non-strict, non-negating utterance → one re-ask opportunity.
    if (decision === 'reask' || decision === 'unknown') {
      if (!pending.confirmReaskIssued) {
        // Issue the re-ask exactly once.
        const shortForm = proposal.summary.length > 60
          ? `${proposal.summary.slice(0, 57)}…`
          : proposal.summary;
        const reaskAction = pending.action === 'approve' ? 'approve' : 'reject';
        await audit(deps, input, 'proposal.voice_approval_confirm_reask', proposal.id, {
          action: pending.action,
        });
        return {
          speak: `Just to be safe — say yes to ${reaskAction} "${shortForm}", or no to leave it pending.`,
          pending: { ...pending, confirmReaskIssued: true },
          outcome: 'confirm_reask',
          proposalId: proposal.id,
        };
      }
      // Second non-strict reply → keep pending, exit dialogue.
      await audit(deps, input, 'proposal.voice_approval_declined', proposal.id, {
        action: pending.action,
        decision,
        reaskExhausted: true,
      });
      return {
        speak: KEEP_FOR_LATER_LINE,
        pending: null,
        outcome: 'kept_for_later',
        proposalId: proposal.id,
      };
    }

    // decision === 'approve' — strict affirmative confirmed.
    if (pending.action === 'approve' && requiresChallenge(proposal)) {
      const challenge = await readChallenge(deps, input.tenantId);
      if (!challenge) {
        // Config disappeared between readback and confirm — refuse the
        // same way the readback stage would have.
        const smsSent = await sendOneTapFallback(deps, input, proposal);
        await audit(deps, input, 'proposal.voice_approve_refused_no_challenge', proposal.id, {
          proposalType: proposal.proposalType,
          oneTapSmsSent: smsSent,
        });
        return {
          speak: smsSent
            ? 'That one needs a tap to confirm — I’ve sent you a text link.'
            : 'That one needs a tap to confirm — check the app or your review queue.',
          pending: null,
          outcome: 'refused_challenge_unset',
          proposalId: proposal.id,
        };
      }
      await audit(deps, input, 'proposal.voice_approval_challenge_prompted', proposal.id);
      return {
        speak: 'This one moves money, so I need your approval code first — go ahead.',
        pending: { ...pending, stage: 'challenge' },
        outcome: 'challenge_prompt',
        proposalId: proposal.id,
      };
    }

    return pending.action === 'approve'
      ? executeApprove(deps, input, proposal.id)
      : executeReject(deps, input, proposal.id);
  }

  // 'challenge' — verify the spoken code against the configured value.
  // Digit challenges ("4271") compare on extracted digits so "four two
  // seven one" passes; non-digit passphrases compare case-insensitively.

  // Stage assert: action MUST be 'approve' here — 'reject' never reaches
  // the challenge stage (the confirm handler routes reject directly to
  // executeReject). Structurally impossible today; make it impossible tomorrow.
  if (pending.action !== 'approve') {
    await audit(deps, input, 'proposal.voice_approval_stage_invariant_violated', proposal.id, {
      stage: pending.stage,
      action: pending.action,
    });
    return { speak: KEEP_FOR_LATER_LINE, pending: null, outcome: 'kept_for_later', proposalId: proposal.id };
  }

  const challenge = await readChallenge(deps, input.tenantId);
  const expectedDigits = challenge ? spokenDigits(challenge) : '';
  const matched = challenge
    ? expectedDigits.length > 0
      ? spokenDigits(input.utterance) === expectedDigits
      : input.utterance.trim().toLowerCase() === challenge.toLowerCase()
    : false;
  if (!matched) {
    // An explicit cancel ("cancel", "never mind") with NO digits exits the
    // dialogue without burning an attempt — the proposal stays pending.
    // Digit-bearing utterances are always treated as code attempts so a
    // passphrase containing a negation word can't be misread as a cancel.
    if (
      spokenDigits(input.utterance).length === 0 &&
      classifyVoiceApproval(input.utterance) === 'cancel'
    ) {
      await audit(deps, input, 'proposal.voice_approval_declined', proposal.id, {
        action: pending.action,
        stage: 'challenge',
      });
      return {
        speak: KEEP_FOR_LATER_LINE,
        pending: null,
        outcome: 'kept_for_later',
        proposalId: proposal.id,
      };
    }
    // SESSION-level fail counter (I1): lives on VoiceApprovalSessionState,
    // not on the per-dialogue PendingVoiceApproval, so canceling and
    // restarting the dialogue cannot reset it — the 3rd wrong code in the
    // CALL trips the lockout, however many dialogues it was spread across.
    const failCount = (input.sessionState?.challengeFailCount ?? 0) + 1;
    const maxAttempts = 3;
    if (failCount >= maxAttempts) {
      // 3rd failure — lock the session and send the SMS fallback.
      const smsSent = await sendOneTapFallback(deps, input, proposal);
      await audit(deps, input, 'proposal.voice_challenge_lockout', proposal.id, {
        attemptCount: failCount,
        oneTapSmsSent: smsSent,
      });
      return {
        speak: smsSent
          ? "Too many incorrect codes — I can’t take that approval by voice this call. I’ve sent you a text link."
          : "Too many incorrect codes — I can’t take that approval by voice this call. Use the app or your review queue.",
        pending: null,
        outcome: 'challenge_lockout',
        proposalId: proposal.id,
        sessionState: { challengeFailCount: failCount, challengeLockedOut: true },
      };
    }
    await audit(deps, input, 'proposal.voice_approval_challenge_failed', proposal.id, {
      attemptCount: failCount,
    });
    return {
      speak: 'That code didn’t match — try again.',
      pending,
      outcome: 'challenge_failed',
      proposalId: proposal.id,
      sessionState: { challengeFailCount: failCount },
    };
  }
  await audit(deps, input, 'proposal.voice_approval_challenge_passed', proposal.id);
  return executeApprove(deps, input, proposal.id);
}
