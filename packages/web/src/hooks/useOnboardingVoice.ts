/**
 * Drives the conversational Onboarding Agent — POST /api/onboarding/conversation/turn
 * — one turn at a time, holding the session id across turns.
 *
 * The endpoint is session-stateful: the first turn omits `sessionId` (the server
 * opens a session and echoes its id); subsequent turns reuse it. Once the FSM
 * reports `completed`, further sends are refused (terminal state). This is the
 * seam the route-aware VoiceBar uses on /onboarding instead of the /assistant
 * dispatch, so a spoken setup answer reaches the onboarding agent.
 */
import { useCallback, useState } from 'react';
import { apiFetch } from '../utils/api-fetch';

export interface OnboardingVoiceTurn {
  sessionId: string;
  assistantMessage: string;
  state: string;
  completed: boolean;
}

export interface UseOnboardingVoice {
  sessionId: string | null;
  completed: boolean;
  lastAssistantMessage: string | null;
  isSending: boolean;
  error: string | null;
  /**
   * Send one utterance to the onboarding agent. Returns the turn (or null on a
   * failed/empty/terminal send). Retains `sessionId` for the next turn.
   */
  sendTurn: (userMessage: string) => Promise<OnboardingVoiceTurn | null>;
  reset: () => void;
}

export function useOnboardingVoice(): UseOnboardingVoice {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [lastAssistantMessage, setLastAssistantMessage] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendTurn = useCallback(
    async (userMessage: string): Promise<OnboardingVoiceTurn | null> => {
      const text = userMessage.trim();
      // Never dispatch an empty utterance or one past the terminal FSM state.
      if (!text || completed) return null;

      setIsSending(true);
      setError(null);
      try {
        const res = await apiFetch('/api/onboarding/conversation/turn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(sessionId ? { sessionId } : {}),
            userMessage: text,
          }),
        });
        if (!res.ok) {
          setError('Could not reach the setup assistant. Please try again.');
          return null;
        }
        const turn = (await res.json()) as OnboardingVoiceTurn;
        setSessionId(turn.sessionId);
        setCompleted(Boolean(turn.completed));
        setLastAssistantMessage(turn.assistantMessage ?? null);
        return turn;
      } catch {
        setError('Could not reach the setup assistant. Please try again.');
        return null;
      } finally {
        setIsSending(false);
      }
    },
    [sessionId, completed],
  );

  const reset = useCallback(() => {
    setSessionId(null);
    setCompleted(false);
    setLastAssistantMessage(null);
    setError(null);
  }, []);

  return { sessionId, completed, lastAssistantMessage, isSending, error, sendTurn, reset };
}
