/**
 * Onboarding API types — mirrored from packages/api/src/onboarding/contracts.ts.
 *
 * The API package is the source of truth; this file restates the shapes the
 * web client consumes. packages/shared is not a workspace in this repo, so
 * each consumer re-declares per the established pattern (see
 * packages/api/src/shared/contracts.ts for the API-side mirror).
 */

export type OnboardingStepId =
  | 'signup'
  | 'identity'
  | 'pack'
  | 'phone'
  | 'billing'
  | 'ai_check'
  | 'test_call';

export type OnboardingStepStatus =
  | 'done'
  | 'current'
  | 'pending'
  | 'error'
  | 'skipped';

export interface OnboardingStep {
  id: OnboardingStepId;
  status: OnboardingStepStatus;
  blockers?: string[];
  metadata?: Record<string, unknown>;
}

export type SubscriptionStatusValue =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | null;

export interface OnboardingStatusResponse {
  steps: OnboardingStep[];
  currentStep: OnboardingStepId | null;
  isComplete: boolean;
  voiceAgentLive: boolean;
  /** The tenant id — lets the client stamp tenant_id onto funnel events. */
  tenantId: string;
  /** Mirror of tenants.subscription_status. Drives the past-due payment banner. */
  subscriptionStatus: SubscriptionStatusValue;
  /** ISO-8601 timestamp of the 30-minute upgrade nudge fire-event. Drives the in-app banner. */
  upgradePromptShownAt?: string;
  /** ISO-8601 timestamp of the activation milestone (first real inbound call).
   * Drives the one-time celebration banner. Absent until activation fires. */
  activatedAt?: string;
  /** ISO-8601 timestamp of tenants.created_at. Lets the client tell a brand-new
   * account (welcome tour) from an established user (what's-new changelog). */
  accountCreatedAt?: string;
}

export interface DayHours {
  open: string;
  close: string;
}

export type BusinessHours = Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', DayHours | null>>;

export interface BusinessIdentityInput {
  businessName: string;
  serviceAreaText?: string;
  serviceAreaRadius?: number;
  businessHours: BusinessHours;
  jobBufferMinutes: number;
  hourlyRateCents: number;
  /** IANA timezone name (e.g. "America/Phoenix"). Browser-detected on submit. */
  timezone?: string;
  /**
   * Owner's personal cell, normalized server-side to E.164. Used for
   * emergency vulnerability-triage patch-through. Empty string clears
   * the value; omit to leave unchanged.
   */
  ownerPhone?: string;
}

export type PackId = 'hvac' | 'plumbing';
export interface PackPickInput {
  packId: PackId;
}

/**
 * B1.19 — conversational onboarding ("talk it through").
 * Mirrors packages/api/src/ai/orchestration/onboarding-conversation.ts
 * (TurnRequest/TurnResponse) and packages/api/src/ai/agents/onboarding/types.ts
 * (OnboardingState). `state` is typed as a plain string rather than a
 * literal union: the backend FSM is gaining a `tools_capture` state in the
 * same B1.19 run (owned by a parallel agent) and may add further capture
 * states later — this client only needs the value for display/labeling, so
 * widening avoids a compile break on either side landing first.
 */
export interface OnboardingConversationTurnRequest {
  /** Omit to create a new session. */
  sessionId?: string;
  /** Omit only for the very first call of a new session (surfaces the
   *  opening prompt) or to replay the last assistant message on resume. */
  userMessage?: string;
}

export interface OnboardingConversationTurnResponse {
  sessionId: string;
  assistantMessage: string;
  /** FSM state name, e.g. 'profile_capture' | 'category_capture' |
   *  'pricing_capture' | 'team_capture' | 'schedule_capture' |
   *  'tools_capture' | 'review' | 'completed' | 'capped'. */
  state: string;
  turnCount: number;
  completed: boolean;
  proposalIds: string[];
}

export interface OnboardingConversationTranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
  /** ISO-8601. Client-stamped — the turn endpoint doesn't echo timestamps. */
  at: string;
}
