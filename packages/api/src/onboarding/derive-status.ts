import type { PhoneLineState } from './phone-line';
import type { ProvisioningFailureCode } from './provisioning-failure';
import type {
  DraftExecution,
  OnboardingStatusResponse,
  OnboardingStep,
  OnboardingStepId,
} from './contracts';

export interface OnboardingFacts {
  /** The tenant these facts belong to — surfaced so the client can stamp
   * tenant_id onto funnel events without a separate /me round-trip. */
  tenantId: string;
  tenantExists: boolean;
  /** tenants.created_at — drives the client's new-account vs. existing-user
   * distinction (welcome tour vs. what's-new changelog). Optional so existing
   * fact fixtures don't need it. */
  tenantCreatedAt?: Date | null;
  identity: {
    businessName: string | null;
    businessHours: unknown | null;     // null OR an empty object {} both count as "not set"
    jobBufferMinutes: number | null;
    hourlyRateCents: number | null;
    /**
     * tenant_settings.timezone — null when the tenant has never CHOSEN one
     * (migration 263 dropped the column's NOT NULL and its
     * `DEFAULT 'America/New_York'`, so null is now representable and means
     * "not chosen", not "Eastern"). Optional on the interface only so fact
     * fixtures predating this field still compile; `isIdentityDone` treats
     * absent exactly like null.
     */
    timezone?: string | null;
  };
  packActivated: boolean;
  twilioStatus: string | null;  // full set of tenant_integrations.status values; only 'full_readiness' and 'failed' have special handling
  /** Provisioned phone number in E.164 (from tenant_integrations.provider_data->>'phoneE164'). null until purchase completes. */
  twilioPhoneNumber?: string | null;
  /** #1563 — the line's read-model state (onboarding/phone-line.ts); lets the
   * phone step tell "awaiting your pick" from "claiming your pick". */
  twilioLineState?: PhoneLineState | null;
  /** #1563 — the number an in-flight pick is claiming (null for auto-pick). */
  twilioPendingNumber?: string | null;
  /** Why the twilio row failed, classified from its `last_error`
   * (provisioning-failure.ts); null unless the row is `failed`. Optional so
   * older fixtures compile: a failed row without one reads as `unknown`. */
  twilioFailureCode?: ProvisioningFailureCode | null;
  subscription: {
    stripeSubscriptionId: string | null;
    status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | null;
  };
  inboundCallCount: number;
  testCallSkippedAt: Date | null;
  /** Timestamp of the one-time 40-AI-minute trial upgrade prompt (when shown). null until trial usage crosses the threshold. */
  upgradePromptShownAt?: Date | null;
  voiceAgentLiveAt: Date | null;
  /** Timestamp of the first real inbound call (activation milestone). null
   * until first_real_call_received fires. Drives the celebration banner. */
  activatedAt: Date | null;
  /** True once a model is configured for the tenant (ai_model is non-null). */
  aiConfigPresent: boolean;
  /** State of the onboarding AI self-check written by the verify_ai worker. */
  aiVerificationStatus: 'pending' | 'running' | 'passed' | 'failed' | null;
  /** Last verification error message (when status is 'failed'). */
  aiVerificationError?: string | null;
  /** When the tenant skipped the AI check (escape hatch — completes the step,
   * verification stays retryable from Settings). */
  aiVerificationSkippedAt: Date | null;
  /**
   * "Pick, don't build" onboarding — the tenant's pre-approval draft, when one
   * exists. Additive: the seven steps are unchanged (the status contract pins
   * `.length(7)` and mobile consumes it); the v3 shell derives its turns from
   * this plus the draft itself.
   */
  draft?: {
    status: 'draft' | 'approved';
    choicesAnswered: number;
    version: number;
    /** Present only for an approved draft: what the listed proposals look like right now. */
    proposals?: DraftProposalsFact;
  } | null;
}

/**
 * The approved draft's proposals, as read: how many ids the draft lists and the
 * status of each one that still exists (a missing row is `expected - statuses.length`).
 */
export interface DraftProposalsFact {
  expected: number;
  statuses: string[];
}

/**
 * The only statuses a member of the approved set may hold while POST /draft/retry
 * is allowed to touch the set: still on its way (`approved`, `executing`),
 * finished (`executed`), or the failure retry exists for (`execution_failed`).
 * Anything else (`undone`, `rejected`, `expired`, `draft`, `ready_for_review`, ...)
 * is a member that will never run again and that retry cannot bring back
 * (`undone` is terminal in lifecycle.ts).
 */
const RETRY_SAFE_STATUSES = new Set(['approved', 'executing', 'executed', 'execution_failed']);

/** Stands in for a listed proposal whose row no longer exists. */
export const MISSING_PROPOSAL = 'missing';

/**
 * Why POST /draft/retry must not touch this approved set: one entry per listed
 * proposal that is outside {approved, executing, executed, execution_failed}
 * (its status), plus one `missing` per listed proposal with no row. Empty means
 * the set is whole and retry can complete it.
 *
 * The single source of truth for both the derived `stopped` state below and the
 * guard inside `retryFailedDraftProposals`, so the status can never invite a
 * retry the endpoint refuses (or the reverse).
 */
export function retryBlockingStatuses(tracked: DraftProposalsFact): string[] {
  const missing = Math.max(0, tracked.expected - tracked.statuses.length);
  return [
    ...tracked.statuses.filter((s) => !RETRY_SAFE_STATUSES.has(s)),
    ...Array<string>(missing).fill(MISSING_PROPOSAL),
  ];
}

/**
 * Derived execution state of an approved draft's proposals. Order matters:
 * `stopped` is decided BEFORE `failed`.
 *
 * - `stopped`: some listed proposal is outside approved/executing/executed/
 *   execution_failed (undone or rejected from the inbox, expired, a stuck
 *   pre-approval status) or no longer exists, WHETHER OR NOT another proposal
 *   failed. Retry re-queues only the failed proposal, so with a sibling that can
 *   never run it would execute that one alone after its fresh undo window:
 *   half the approved configuration live ("executed + undone") with Settings as
 *   the only way back. Retry therefore refuses such a set
 *   (`DRAFT_RETRY_UNSAFE`) and the shell must not offer it; it also never waits
 *   forever. The whole-draft undo (plan U9, S4) is the way out.
 * - `failed`: the set is whole (every listed proposal is approved/executing/
 *   executed/execution_failed) and at least one is `execution_failed`. POST
 *   /draft/retry re-queues exactly those rows, which completes the pair, so the
 *   shell offers a retry instead of waiting forever. `failed + executed` and
 *   `failed + approved` are this case.
 * - `executed`: every listed proposal executed.
 * - `executing`: any executing, or some executed while others still wait for
 *   the worker (work is in flight, so the shell keeps saying "Saving").
 * - `pending`: all approved, none picked up yet.
 *
 * `null` while the draft is still being edited, and when there is nothing to
 * track: a vacuous "executed" must never open billing.
 */
export function deriveDraftExecution(
  draftStatus: 'draft' | 'approved',
  tracked?: DraftProposalsFact,
): DraftExecution | null {
  if (draftStatus !== 'approved') return null;
  if (!tracked || tracked.expected <= 0) return null;
  const { statuses } = tracked;
  if (retryBlockingStatuses(tracked).length > 0) return 'stopped';
  if (statuses.some((s) => s === 'execution_failed')) return 'failed';
  if (statuses.every((s) => s === 'executed')) return 'executed';
  if (statuses.some((s) => s === 'executing' || s === 'executed')) return 'executing';
  return 'pending';
}

/**
 * `timezone` is load-bearing, not cosmetic. Without a chosen zone
 * `CreateAppointmentTaskHandler` (ai/tasks/create-appointment-task.ts) turns
 * EVERY spoken booking into a timezone `voice_clarification` — it refuses to
 * guess, because a wrong zone silently misbooks (Phoenix mis-booking
 * postmortem, migration 263). Reporting identity "done" while that is true
 * unlocks onboarding onto a product that cannot book, which is why the step
 * must stay incomplete until the owner supplies one. The form wizard always
 * submits a zone (IdentityStep.tsx pre-fills the browser-detected value into
 * a select), so this only ever blocks a path that genuinely never captured
 * one — e.g. conversational onboarding, whose settings proposal is gated on
 * the same field (ai/tasks/onboarding/tenant-settings-proposer.ts).
 */
const isIdentityDone = (i: OnboardingFacts['identity']): boolean =>
  !!i.businessName &&
  i.jobBufferMinutes !== null &&
  i.hourlyRateCents !== null &&
  !!i.timezone &&
  i.businessHours !== null &&
  typeof i.businessHours === 'object' &&
  Object.keys(i.businessHours as object).length > 0;

const isBillingDone = (s: OnboardingFacts['subscription']): boolean =>
  !!s.stripeSubscriptionId && (s.status === 'trialing' || s.status === 'active');

/**
 * The phone step's blocker for each failure code, listed BEFORE the generic
 * `twilio_provisioning_failed` (kept on every failure, and alone for
 * `unknown`, so existing readers of that blocker keep working).
 */
const PHONE_FAILURE_BLOCKER: Record<ProvisioningFailureCode, string | null> = {
  area_code_unavailable: 'area_code_unavailable',
  credentials_missing: 'twilio_credentials_missing',
  provider_error: 'twilio_provider_error',
  unknown: null,
};

function phoneFailureBlockers(code: ProvisioningFailureCode): string[] {
  const specific = PHONE_FAILURE_BLOCKER[code];
  return specific ? [specific, 'twilio_provisioning_failed'] : ['twilio_provisioning_failed'];
}

const isTestCallDone = (f: OnboardingFacts): boolean => f.inboundCallCount > 0;
const isTestCallSkipped = (f: OnboardingFacts): boolean =>
  f.testCallSkippedAt !== null && f.inboundCallCount === 0;

export function deriveOnboardingStatus(f: OnboardingFacts): OnboardingStatusResponse {
  const done: Record<OnboardingStepId, boolean> = {
    signup:    f.tenantExists,
    identity:  isIdentityDone(f.identity),
    pack:      f.packActivated,
    phone:     f.twilioStatus === 'full_readiness',
    billing:   isBillingDone(f.subscription),
    ai_check:  f.aiVerificationStatus === 'passed' || f.aiVerificationSkippedAt !== null,
    test_call: isTestCallDone(f) || isTestCallSkipped(f),
  };

  // Billing precedes phone: the Twilio number is a real, recurring cost, so
  // provisioning only starts after trial checkout (card on file) — the
  // subscription webhook enqueues the provisioning job when the trial goes
  // live. The phone step's existing "provisioning in progress" UI is the
  // graceful pre-number state; no number is ever bought for a tire-kicker.
  const order: OnboardingStepId[] = ['signup', 'identity', 'pack', 'billing', 'phone', 'ai_check', 'test_call'];
  const firstNotDone = order.find((id) => !done[id]) ?? null;

  const phoneMetadataFields = {
    ...(f.twilioPhoneNumber ? { phoneNumber: f.twilioPhoneNumber } : {}),
    ...(f.twilioLineState ? { lineState: f.twilioLineState } : {}),
    ...(f.twilioPendingNumber ? { pendingNumber: f.twilioPendingNumber } : {}),
  };
  const phoneMetadata = Object.keys(phoneMetadataFields).length > 0 ? phoneMetadataFields : undefined;

  const steps = order.map((id): OnboardingStep => {
    if (id === 'phone' && f.twilioStatus === 'failed') {
      const failureCode = f.twilioFailureCode ?? 'unknown';
      return {
        id,
        status: 'error',
        failureCode,
        blockers: phoneFailureBlockers(failureCode),
        ...(phoneMetadata ? { metadata: phoneMetadata } : {}),
      };
    }
    if (id === 'ai_check') {
      if (f.aiVerificationStatus === 'passed') {
        return { id, status: 'done' };
      }
      // Escape hatch: a skip completes the step — it takes precedence over a
      // recorded failure (the tenant chose to move on; 'passed' above still
      // wins when a retry later succeeds).
      if (f.aiVerificationSkippedAt !== null) {
        return { id, status: 'skipped' };
      }
      if (f.aiVerificationStatus === 'failed') {
        const blocker = f.aiConfigPresent ? 'ai_verification_failed' : 'ai_config_missing';
        return {
          id,
          status: 'error',
          blockers: [blocker],
          ...(f.aiVerificationError ? { metadata: { error: f.aiVerificationError } } : {}),
        };
      }
      if (id === firstNotDone) {
        return { id, status: 'current', metadata: { verifying: f.aiVerificationStatus === 'running' } };
      }
      return { id, status: 'pending' };
    }
    if (id === 'test_call' && isTestCallSkipped(f)) {
      return { id, status: 'skipped' };
    }
    if (done[id]) {
      return { id, status: 'done', ...(id === 'phone' && phoneMetadata ? { metadata: phoneMetadata } : {}) };
    }
    if (id === firstNotDone) {
      return { id, status: 'current', ...(id === 'phone' && phoneMetadata ? { metadata: phoneMetadata } : {}) };
    }
    return { id, status: 'pending' };
  });

  return {
    steps,
    currentStep: firstNotDone,
    isComplete: firstNotDone === null,
    voiceAgentLive: f.voiceAgentLiveAt != null,
    tenantId: f.tenantId,
    subscriptionStatus: f.subscription.status,
    ...(f.upgradePromptShownAt
      ? { upgradePromptShownAt: f.upgradePromptShownAt.toISOString() }
      : {}),
    ...(f.activatedAt ? { activatedAt: f.activatedAt.toISOString() } : {}),
    ...(f.tenantCreatedAt ? { accountCreatedAt: f.tenantCreatedAt.toISOString() } : {}),
    ...(f.draft ? { draft: toDraftStatus(f.draft) } : {}),
  };
}

/** The status response's draft block: the raw proposal statuses never leave the server. */
function toDraftStatus(draft: NonNullable<OnboardingFacts['draft']>): NonNullable<OnboardingStatusResponse['draft']> {
  const { proposals, ...rest } = draft;
  return { ...rest, execution: deriveDraftExecution(draft.status, proposals) };
}
