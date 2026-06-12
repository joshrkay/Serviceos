/**
 * Operator mode (Phase 12). Mirrors the same type defined in
 * `middleware/auth.ts` and `packages/shared/src/types.ts`. We re-declare
 * locally to keep this module a pure leaf — proposals depending on
 * middleware would invert the layering.
 */
export type Mode = 'supervisor' | 'tech' | 'both';

/**
 * Default per-mode auto-approve thresholds for proposals (Phase 12).
 *
 * The numbers correspond to the supervisor's *current_mode* on the
 * voice_session that produced the proposal. Higher = stricter.
 *
 * Tunable per tenant via `tenant_settings.auto_approve_threshold` (a
 * JSONB map keyed by mode); see `resolveAutoApproveThreshold`. The
 * defaults below are the locked launch values from
 * docs/superpowers/plans/2026-05-03-ship-this-week-analysis.md
 * (Appendix C, "Decisions locked").
 */
export const DEFAULT_AUTO_APPROVE_THRESHOLDS: Record<Mode, number> = {
  supervisor: 0.9,
  both: 0.92,
  tech: 0.95,
};

/**
 * Pre-Phase-12 default. Used when no `supervisorMode` is supplied —
 * i.e. callers that don't yet thread mode through (legacy paths,
 * backfills). Keeps the existing 0.9 behavior unchanged.
 */
export const LEGACY_AUTO_APPROVE_THRESHOLD = 0.9;

export interface ResolveThresholdInput {
  /**
   * The current_mode of the user-on-record for the originating session.
   * Read from `voice_sessions.supervisor_mode_at_start`. Optional so
   * legacy callers (no mode threaded yet) keep the pre-Phase-12 0.9
   * default.
   */
  supervisorMode?: Mode;

  /**
   * Tenant-wide presence: is *any* user currently in 'supervisor' or
   * 'both' mode? When false, the tenant is "unsupervised" and no
   * auto-approval is allowed regardless of confidence.
   *
   * Optional with a default of `true` so callers that don't know
   * (legacy paths) preserve existing behavior. Production callers
   * should always pass a real value via `isSupervisorPresent`.
   */
  supervisorPresent?: boolean;

  /**
   * Optional per-tenant override map from `tenant_settings.auto_approve_threshold`.
   * Shape: `{ supervisor?: number; tech?: number; both?: number }`. Any
   * missing mode falls through to `DEFAULT_AUTO_APPROVE_THRESHOLDS`.
   */
  tenantOverride?: Partial<Record<Mode, number>>;
}

/**
 * Resolve the confidence threshold a proposal must clear to auto-approve.
 *
 * Returns `null` when auto-approval is *categorically blocked* — i.e.
 * the tenant has no supervisor present. Callers must read `null` as
 * "do not auto-approve regardless of confidence" and route the
 * proposal through the unsupervised path (queue + SMS owner per
 * `tenant_settings.unsupervised_proposal_routing`).
 *
 * Resolution order (when `supervisorPresent !== false`):
 *   1. tenantOverride[mode]   (per-tenant, per-mode override)
 *   2. DEFAULT_AUTO_APPROVE_THRESHOLDS[mode]   (locked product default)
 *   3. LEGACY_AUTO_APPROVE_THRESHOLD          (mode unknown)
 */
export function resolveAutoApproveThreshold(
  input: ResolveThresholdInput = {},
): number | null {
  // The unsupervised guard is the hard rule — overrides every other
  // resolution. A confidence of 1.0 in an unsupervised tenant still
  // does not auto-approve. The proposal queues for review.
  if (input.supervisorPresent === false) {
    return null;
  }

  if (input.supervisorMode === undefined) {
    return LEGACY_AUTO_APPROVE_THRESHOLD;
  }

  const override = input.tenantOverride?.[input.supervisorMode];
  if (typeof override === 'number') {
    return override;
  }

  return DEFAULT_AUTO_APPROVE_THRESHOLDS[input.supervisorMode];
}

/**
 * True if `confidenceScore` is high enough to auto-approve given the
 * resolved `threshold`. Returns false when threshold is `null` (the
 * unsupervised case).
 *
 * Inequality: `confidenceScore >= threshold` (inclusive). Tested at
 * the boundary in `auto-approve.test.ts`.
 */
export function shouldAutoApprove(
  confidenceScore: number | undefined,
  threshold: number | null,
): boolean {
  if (threshold === null) return false;
  if (typeof confidenceScore !== 'number') return false;
  return confidenceScore >= threshold;
}

// ───────────────────────────────────────────────────────────────────────────
// RV-007 (F-4) — Confidence Marker auto-approve guard.
//
// AI task handlers stamp `payload._meta.overallConfidence` with the level
// from the single confidence vocabulary (src/ai/guardrails/confidence.ts:
// high | medium | low | very_low). A proposal carrying a 'low' or
// 'very_low' overall level must NEVER auto-approve, regardless of how the
// numeric confidence score compares to the resolved threshold.
//
// This guard is ADDITIVE only:
//   - payloads without `_meta` (all pre-RV-007 proposals) are untouched —
//     the numeric-threshold rules apply exactly as before;
//   - 'medium' does NOT block (per F-4 it renders as a marker downstream);
//   - a malformed `_meta` never blocks and never throws — it is a
//     defensively structural guard; assertValidProposalPayload is wired
//     only where AI task handlers emit proposals, not on every path.
//
// `decideInitialStatus` (proposals/proposal.ts) is the single place that
// can return 'approved', so the check is applied there — every
// auto-approve path flows through it.
// ───────────────────────────────────────────────────────────────────────────

import type { ConfidenceLevel } from '../ai/guardrails/confidence';

/** Levels that hard-block auto-approval (F-4: only low / very_low block). */
export const AUTO_APPROVE_BLOCKING_CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = [
  'low',
  'very_low',
];

/**
 * True when `payload._meta.overallConfidence` is a blocking level.
 * Pure observer — tolerates any payload shape (absent/malformed `_meta`
 * returns false, preserving pre-RV-007 behavior exactly).
 */
export function confidenceMetaBlocksAutoApprove(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const meta = (payload as Record<string, unknown>)._meta;
  if (meta === null || typeof meta !== 'object') return false;
  const overall = (meta as Record<string, unknown>).overallConfidence;
  return (
    typeof overall === 'string' &&
    (AUTO_APPROVE_BLOCKING_CONFIDENCE_LEVELS as readonly string[]).includes(overall)
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 12 — one-tap re-approve token (SMS deep link)
//
// When a proposal is routed via `queue_and_sms`, the owner gets an SMS with
// a link that pre-authenticates a single-use approve action for exactly one
// proposal. Same conceptual shape as the estimate `view_token` pattern
// (opaque token + expiry checked server-side), hardened per the P12-004
// risk note: HMAC-SHA256 signed, bound to proposal_id + tenant_id + nonce,
// single-use (nonce consumed on first successful verify), TTL ≤ 30 min.
// ───────────────────────────────────────────────────────────────────────────

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuditRepository } from '../audit/audit';
import { createAuditEvent } from '../audit/audit';
import type { UnsupervisedProposalRouting } from '../settings/settings';
import type { OutboundAnchorKind } from './sms/sms-event';

/** Hard ceiling on one-tap link lifetime (risk note: TTL ≤ 30 minutes). */
export const ONE_TAP_APPROVE_MAX_TTL_MS = 30 * 60 * 1000;

/**
 * RV-065 — one-tap action discriminator. 'approve' is the original P12-004
 * behavior (approve an existing proposal); 'mint_draft_invoice' is the
 * digest's "invoice it" tap: mint a draft_invoice proposal for a completed
 * unbilled job, then continue into the standard approve flow. Defaults to
 * 'approve' everywhere so pre-RV-065 tokens (no `a` key) keep verifying —
 * and freshly minted approve tokens stay byte-identical to the old format.
 */
export type OneTapAction = 'approve' | 'mint_draft_invoice';

interface OneTapPayload {
  /** Subject id: proposal_id for 'approve', job_id for 'mint_draft_invoice'. */
  p: string;
  /** tenant_id */
  t: string;
  /** nonce (single-use) */
  n: string;
  /** expiry, epoch ms */
  e: number;
  /**
   * Action discriminator (RV-065). OMITTED for 'approve' so legacy approve
   * tokens are byte-identical; present only for 'mint_draft_invoice'.
   */
  a?: 'mint_draft_invoice';
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export interface CreateOneTapApproveTokenInput {
  /** Required for action 'approve' (the default). */
  proposalId?: string;
  /** RV-065 — required for action 'mint_draft_invoice'; binds tenant+jobId. */
  jobId?: string;
  /** RV-065 — defaults to 'approve' (back-compat: token bytes unchanged). */
  action?: OneTapAction;
  tenantId: string;
  /** HMAC secret (server-side, e.g. config.appSecret). */
  secret: string;
  /** Requested TTL in ms. Clamped to ONE_TAP_APPROVE_MAX_TTL_MS. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  nowMs?: number;
}

export interface OneTapApproveToken {
  token: string;
  nonce: string;
  expiresAt: Date;
}

/**
 * Mint an HMAC-signed, single-use one-tap token bound to
 * (proposal_id | job_id) + tenant_id + nonce. TTL is clamped to 30 minutes.
 * Signature/nonce/TTL machinery is identical across both action variants;
 * the default 'approve' variant produces byte-identical payloads to the
 * pre-RV-065 format (no `a` key).
 */
export function createOneTapApproveToken(
  input: CreateOneTapApproveTokenInput,
): OneTapApproveToken {
  if (!input.secret) throw new Error('one-tap token requires a secret');
  const action: OneTapAction = input.action ?? 'approve';
  if (action === 'approve' && !input.proposalId) {
    throw new Error("one-tap 'approve' token requires a proposalId");
  }
  if (action === 'mint_draft_invoice' && !input.jobId) {
    throw new Error("one-tap 'mint_draft_invoice' token requires a jobId");
  }
  const now = input.nowMs ?? Date.now();
  const ttl = Math.min(input.ttlMs ?? ONE_TAP_APPROVE_MAX_TTL_MS, ONE_TAP_APPROVE_MAX_TTL_MS);
  const payload: OneTapPayload = {
    p: action === 'approve' ? (input.proposalId as string) : (input.jobId as string),
    t: input.tenantId,
    n: randomBytes(16).toString('base64url'),
    e: now + ttl,
    // Key omitted entirely for 'approve' — legacy byte-identity.
    ...(action === 'mint_draft_invoice' ? { a: 'mint_draft_invoice' as const } : {}),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `${payloadB64}.${sign(payloadB64, input.secret)}`;
  return { token, nonce: payload.n, expiresAt: new Date(payload.e) };
}

export type OneTapVerifyFailure =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'tenant_mismatch'
  | 'already_used';

export interface VerifyOneTapApproveTokenInput {
  token: string;
  secret: string;
  /** When supplied, the token's tenant binding must match. */
  expectedTenantId?: string;
  nowMs?: number;
  /**
   * Single-use enforcement seam: returns true iff this nonce has not
   * been consumed before (and atomically marks it consumed). Backed by
   * an in-memory store in tests / single-dyno; a DB row in production.
   */
  consumeNonce: (nonce: string) => boolean | Promise<boolean>;
}

export type OneTapVerifyResult =
  | { ok: true; action: 'approve'; proposalId: string; tenantId: string }
  | { ok: true; action: 'mint_draft_invoice'; jobId: string; tenantId: string }
  | { ok: false; reason: OneTapVerifyFailure };

/** Verify an HMAC one-tap approve token. Consumes the nonce on success. */
export async function verifyOneTapApproveToken(
  input: VerifyOneTapApproveTokenInput,
): Promise<OneTapVerifyResult> {
  const parts = input.token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [payloadB64, sig] = parts;

  const expected = sign(payloadB64, input.secret);
  const sigBuf = Buffer.from(sig, 'base64url');
  const expBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: OneTapPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof payload.p !== 'string' ||
    typeof payload.t !== 'string' ||
    typeof payload.n !== 'string' ||
    typeof payload.e !== 'number' ||
    // RV-065: `a` is either absent (legacy approve) or the mint literal.
    (payload.a !== undefined && payload.a !== 'mint_draft_invoice')
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const now = input.nowMs ?? Date.now();
  if (now >= payload.e) return { ok: false, reason: 'expired' };
  if (input.expectedTenantId && input.expectedTenantId !== payload.t) {
    return { ok: false, reason: 'tenant_mismatch' };
  }

  const fresh = await input.consumeNonce(payload.n);
  if (!fresh) return { ok: false, reason: 'already_used' };

  if (payload.a === 'mint_draft_invoice') {
    return { ok: true, action: 'mint_draft_invoice', jobId: payload.p, tenantId: payload.t };
  }
  return { ok: true, action: 'approve', proposalId: payload.p, tenantId: payload.t };
}

/**
 * In-process single-use nonce store. Sufficient for the week-one single
 * dyno; multi-instance deployments swap in a DB-backed consumeNonce.
 * Entries are pruned lazily once `maxEntries` is exceeded.
 */
export function createInMemoryNonceStore(maxEntries = 10_000): (nonce: string) => boolean {
  const used = new Set<string>();
  return (nonce: string): boolean => {
    if (used.has(nonce)) return false;
    used.add(nonce);
    if (used.size > maxEntries) {
      const oldest = used.values().next().value;
      if (oldest !== undefined) used.delete(oldest);
    }
    return true;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Phase 12 — unsupervised proposal routing
//
// Applied when `resolveAutoApproveThreshold` returned `null` (no supervisor
// present). The proposal has already been left in 'ready_for_review' by the
// status decision; this function performs the tenant-configured side effect
// and ALWAYS emits an `unsupervised_proposal_routed` audit event.
// ───────────────────────────────────────────────────────────────────────────

export interface RouteUnsupervisedProposalDeps {
  auditRepo: AuditRepository;
  /**
   * Outbound SMS sender (existing message_dispatches + Twilio delivery).
   * Optional — when absent, queue_and_sms degrades to queue_only.
   */
  sendSms?: (to: string, body: string) => Promise<void>;
  /**
   * Emits an `escalate_to_human` skill call so the active call routes to
   * on-call. Only invoked for the `escalate_to_oncall` routing on a voice
   * channel; non-call channels fall back to queue_only per the story.
   */
  escalateToOnCall?: () => Promise<void>;
  /** Builds the public one-tap approve URL from the signed token. */
  buildApproveUrl?: (token: string) => string;
  /** HMAC secret for the one-tap token. Required for queue_and_sms SMS. */
  secret?: string;
  /**
   * P2-034 — invoked after the owner SMS goes out so the caller can record
   * the outbound `proposal_sms_events` row that anchors the reply transport
   * (the inbound Y/N/EDIT handler resolves "which proposal?" from it).
   *
   * RV-074 — `kind` distinguishes the normal approvable render
   * (`proposal_rendered`, with the one-tap link's `expiresAt`) from the
   * low/very_low-confidence "needs review in app" send
   * (`review_required_rendered`, no token, no `expiresAt`). BOTH must be
   * recorded: the low-confidence SMS says "reply N to reject", so it has
   * to become the owner's latest reply target or that N would land on an
   * older proposal.
   */
  onSmsSent?: (sent: {
    body: string;
    kind: OutboundAnchorKind;
    expiresAt?: Date;
  }) => Promise<void>;
}

export interface RouteUnsupervisedProposalInput {
  tenantId: string;
  proposalId: string;
  /** From tenant_settings.unsupervised_proposal_routing. Defaults to queue_and_sms. */
  routing?: UnsupervisedProposalRouting;
  /** Originating channel — escalate_to_oncall only applies to live voice calls. */
  channel: 'voice_inbound' | 'inapp' | 'sms' | 'other';
  /** Owner's E.164 mobile for the one-tap SMS. Null/undefined skips the SMS. */
  ownerPhone?: string | null;
  /** Short human label for the SMS body, e.g. "New booking for Jane D." */
  summaryText?: string;
  /**
   * P2-034 — full SMS body builder (proposal summary + key facts + reply
   * tokens + the one-tap link). When absent the legacy link-only body is
   * sent, so existing callers keep their exact behavior.
   */
  renderSmsBody?: (approveUrl: string) => string;
  /**
   * RV-074 (F-4) — proposal payload used to check _meta.overallConfidence.
   * When present and confidence is low/very_low, the one-tap Y-able link is
   * suppressed (body becomes the no-approve "needs review in app" form from
   * renderSmsBody, called without an approveUrl).
   */
  payload?: unknown;
  nowMs?: number;
}

export interface RouteUnsupervisedProposalResult {
  /** Routing actually applied after fallbacks. */
  effectiveRouting: UnsupervisedProposalRouting;
  smsSent: boolean;
  escalated: boolean;
  /** Expiry of the one-tap link when an SMS was sent. */
  approveLinkExpiresAt?: Date;
}

export async function routeUnsupervisedProposal(
  deps: RouteUnsupervisedProposalDeps,
  input: RouteUnsupervisedProposalInput,
): Promise<RouteUnsupervisedProposalResult> {
  const requested: UnsupervisedProposalRouting = input.routing ?? 'queue_and_sms';
  let effective: UnsupervisedProposalRouting = requested;
  let smsSent = false;
  let escalated = false;
  let approveLinkExpiresAt: Date | undefined;
  // RV-074 — true when a low/very_low-confidence payload suppressed the
  // one-tap approve link on an SMS that still went out.
  let approveLinkSuppressed = false;

  if (requested === 'escalate_to_oncall' && (input.channel !== 'voice_inbound' || !deps.escalateToOnCall)) {
    // Non-call channels (or no escalation seam wired) fall back to queue_only.
    effective = 'queue_only';
  }

  if (effective === 'escalate_to_oncall' && deps.escalateToOnCall) {
    await deps.escalateToOnCall();
    escalated = true;
  }

  if (effective === 'queue_and_sms') {
    if (deps.sendSms && input.ownerPhone) {
      // RV-074 (F-4) — low/very_low proposals must never get a Y-able one-tap
      // link. When the payload carries a blocking confidence level, mint no
      // token and call renderSmsBody without an approveUrl so the renderer
      // emits the "needs review in app" form.
      const isLowConfidence = confidenceMetaBlocksAutoApprove(input.payload);

      let body: string;
      let expiresAt: Date | undefined;

      if (!isLowConfidence && deps.secret) {
        // Normal path: mint a one-tap token and include the approve URL.
        const { token, expiresAt: exp } = createOneTapApproveToken({
          proposalId: input.proposalId,
          tenantId: input.tenantId,
          secret: deps.secret,
          ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
        });
        expiresAt = exp;
        const url = deps.buildApproveUrl
          ? deps.buildApproveUrl(token)
          : `/p/approve?token=${encodeURIComponent(token)}`;
        const summary = input.summaryText ?? 'A proposal needs your approval';
        body = input.renderSmsBody
          ? input.renderSmsBody(url)
          : `${summary}. Tap to approve (link expires in 30 min): ${url}`;
        approveLinkExpiresAt = expiresAt;
      } else if (isLowConfidence) {
        // Low/very_low confidence: no token, no Y-able link. The renderer
        // (renderProposalSms) emits the "needs review in app" form when it
        // sees the blocking confidence level; pass an empty string so the
        // renderSmsBody callback signature is satisfied.
        const summary = input.summaryText ?? 'A proposal needs your approval';
        body = input.renderSmsBody
          ? input.renderSmsBody('')
          : `${summary}. Review in app.`;
        approveLinkSuppressed = true;
      } else {
        // No secret and not low confidence: preserve original behavior —
        // no token to mint, so no SMS goes out.
        body = '';
      }

      if (body) {
        await deps.sendSms(input.ownerPhone, body);
        smsSent = true;
        // P2-034 / RV-074 — anchor the reply transport. Recorded only after
        // a successful send. Low-confidence sends anchor too (kind
        // `review_required_rendered`): they solicit "reply N to reject", so
        // they MUST become the latest reply target — otherwise that N would
        // be applied to whatever older proposal was rendered before.
        if (deps.onSmsSent) {
          await deps.onSmsSent({
            body,
            kind: isLowConfidence ? 'review_required_rendered' : 'proposal_rendered',
            ...(expiresAt ? { expiresAt } : {}),
          });
        }
      }
    }
    // No phone / no SMS seam: the proposal still sits in ready_for_review —
    // behaviorally queue_only, but we record the requested routing in audit.
  }

  // Audit — every unsupervised-route decision emits an event (story item 6).
  await deps.auditRepo.create(
    createAuditEvent({
      tenantId: input.tenantId,
      actorId: 'system',
      actorRole: 'system',
      eventType: 'unsupervised_proposal_routed',
      entityType: 'proposal',
      entityId: input.proposalId,
      metadata: {
        requestedRouting: requested,
        effectiveRouting: effective,
        channel: input.channel,
        smsSent,
        escalated,
        // RV-074 — make the suppressed approve affordance auditable.
        ...(approveLinkSuppressed
          ? { approveLinkSuppressed: true, suppressReason: 'low_confidence' }
          : {}),
      },
    }),
  );

  return {
    effectiveRouting: effective,
    smsSent,
    escalated,
    ...(approveLinkExpiresAt ? { approveLinkExpiresAt } : {}),
  };
}
