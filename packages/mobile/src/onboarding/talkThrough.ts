/**
 * Mobile client for the spoken setup conversation: POST
 * /api/onboarding/conversation/turn (packages/api/src/routes/onboarding-conversation.ts),
 * the same FSM the web "Talk it through" path drives. The owner talks about
 * the business, services, prices, team and hours; the terminal turn emits
 * `onboarding_*` proposals, which the owner then approves.
 *
 * Pure (an injected ApiFetch, no RN) so every outcome is unit-tested. Each
 * failure is a distinct outcome with owner-facing copy: nothing here retries
 * quietly or swaps in a default.
 */
import type { ApiFetch } from '../lib/apiFetch';

export interface OnboardingTurnRequest {
  /** Omit to start a new conversation (the first call returns the greeting). */
  sessionId?: string;
  userMessage?: string;
  /** Device IANA zone. Omitted when unknown: the server then asks, never guesses. */
  clientTimezone?: string;
}

export interface OnboardingTurn {
  sessionId: string;
  assistantMessage: string;
  completed: boolean;
  /** Proposal ids emitted when the conversation completes. Empty until then. */
  proposalIds: string[];
}

export type OnboardingTurnOutcome =
  | { kind: 'turn'; turn: OnboardingTurn }
  /** 404: the server no longer has this conversation; a new one must start. */
  | { kind: 'session_gone'; message: string }
  /** 409: another device advanced the conversation; nothing was written. */
  | { kind: 'conflict'; message: string }
  /** 403: only the account owner can run setup. */
  | { kind: 'forbidden'; message: string }
  | { kind: 'failed'; message: string };

export const SESSION_GONE_COPY = "That setup conversation expired. Start again and I'll take it from the top.";
export const CONFLICT_COPY = 'This setup was changed on another device. Start again to continue.';
export const FORBIDDEN_COPY = 'Only the account owner can set up the business.';
export const FAILED_COPY = "I couldn't reach setup just now. Check your connection and try again.";

/** The device's IANA zone, or undefined. Never a fallback zone: a wrong zone misbooks every job. */
export function deviceTimezoneOrUndefined(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.length > 0 ? zone : undefined;
  } catch {
    return undefined;
  }
}

function parseTurn(body: unknown): OnboardingTurn | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.sessionId !== 'string' || typeof b.assistantMessage !== 'string') return null;
  return {
    sessionId: b.sessionId,
    assistantMessage: b.assistantMessage,
    completed: b.completed === true,
    proposalIds: Array.isArray(b.proposalIds) ? b.proposalIds.filter((id): id is string => typeof id === 'string') : [],
  };
}

export async function postOnboardingTurn(api: ApiFetch, req: OnboardingTurnRequest): Promise<OnboardingTurnOutcome> {
  let res: Response;
  try {
    res = await api('/api/onboarding/conversation/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch {
    return { kind: 'failed', message: FAILED_COPY };
  }
  if (res.status === 404) return { kind: 'session_gone', message: SESSION_GONE_COPY };
  if (res.status === 409) return { kind: 'conflict', message: CONFLICT_COPY };
  if (res.status === 403) return { kind: 'forbidden', message: FORBIDDEN_COPY };
  if (!res.ok) return { kind: 'failed', message: FAILED_COPY };
  let turn: OnboardingTurn | null;
  try {
    turn = parseTurn(await res.json());
  } catch {
    turn = null;
  }
  return turn ? { kind: 'turn', turn } : { kind: 'failed', message: FAILED_COPY };
}

/**
 * Owner-facing line for the setup items the batch approve refused. The API's
 * per-id reason is a code; a missing detail (VALIDATION_ERROR, the proposal's
 * gate) reads differently from anything else, and nothing is dropped.
 */
export function approvalFailureCopy(failed: ReadonlyArray<{ id: string; reason: string }>): string {
  if (failed.length === 0) return '';
  const items = failed.length === 1 ? '1 setup item' : `${failed.length} setup items`;
  const them = failed.length === 1 ? 'it' : 'them';
  const missing = failed.every((f) => f.reason === 'VALIDATION_ERROR');
  return missing
    ? `${items} still ${failed.length === 1 ? 'needs' : 'need'} a detail I didn't get. Finish ${them} in the web app under Approvals, or skip for now.`
    : `${items} couldn't be saved (${[...new Set(failed.map((f) => f.reason))].join(', ')}). Try again, or finish ${them} in the web app under Approvals.`;
}
