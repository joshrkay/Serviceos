import { useCallback, useState } from 'react';
import { apiFetch } from '../utils/api-fetch';

export interface OnboardingTurnResult {
  sessionId: string;
  assistantMessage: string;
  completed: boolean;
}

export function useOnboardingVoice() {
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [completed, setCompleted] = useState(false);

  const sendTurn = useCallback(async (userMessage: string): Promise<OnboardingTurnResult> => {
    const response = await apiFetch('/api/onboarding/conversation/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(sessionId ? { sessionId } : {}),
        userMessage,
      }),
    });

    if (!response.ok) {
      throw new Error('ONBOARDING_CONVERSATION_FAILED');
    }

    const data = (await response.json()) as OnboardingTurnResult & { sessionId: string };
    setSessionId(data.sessionId);
    setCompleted(Boolean(data.completed));
    return {
      sessionId: data.sessionId,
      assistantMessage: data.assistantMessage,
      completed: Boolean(data.completed),
    };
  }, [sessionId]);

  return { sessionId, completed, sendTurn };
}
