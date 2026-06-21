/**
 * Typed wrapper for the conversational onboarding agent.
 *
 * Drives one turn of the Onboarding Agent's FSM via
 * `POST /api/onboarding/conversation/turn` (see
 * packages/api/src/routes/onboarding-conversation.ts). Like `api/me.ts`,
 * this takes a `fetch`-shaped client (from `useApiClient`) so the Clerk
 * JWT is attached automatically; it does not call hooks itself.
 *
 * The agent never mutates settings directly — terminal turns emit
 * config-change *proposals* the owner approves later, consistent with the
 * platform's never-auto-execute trust model.
 */
export type AuthedFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Mirrors `TurnResponse` from the API orchestrator. */
export interface OnboardingTurnResponse {
  sessionId: string;
  assistantMessage: string;
  /** FSM state name (e.g. `collecting`, `completed`, `capped`). */
  state: string;
  turnCount: number;
  /** True once the FSM reaches a terminal state (`completed`/`capped`). */
  completed: boolean;
  /** Proposal IDs emitted on terminal transitions; empty until then. */
  proposalIds: string[];
}

export interface OnboardingTurnInput {
  /** Omit to open a new session. */
  sessionId?: string;
  /** Omit on the very first call to fetch the opening prompt for free. */
  userMessage?: string;
}

/**
 * POST one turn. Throws on any non-2xx, surfacing the server's `message`
 * when present so the caller can render it inline.
 */
export async function postOnboardingTurn(
  client: AuthedFetch,
  input: OnboardingTurnInput = {},
): Promise<OnboardingTurnResponse> {
  const res = await client('/api/onboarding/conversation/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = typeof body?.message === 'string' ? body.message : '';
    } catch {
      /* non-JSON body — fall back to status text */
    }
    throw new Error(
      `postOnboardingTurn: ${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`,
    );
  }

  return (await res.json()) as OnboardingTurnResponse;
}
