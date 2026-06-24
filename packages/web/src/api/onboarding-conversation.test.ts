import { describe, it, expect, vi } from 'vitest';
import { postOnboardingTurn, type OnboardingTurnResponse } from './onboarding-conversation';

const ok = (payload: OnboardingTurnResponse) =>
  vi.fn(
    async (_path: string, _init?: RequestInit) =>
      ({ ok: true, json: async () => payload }) as unknown as Response,
  );

const sample: OnboardingTurnResponse = {
  sessionId: 's1',
  assistantMessage: 'hi',
  state: 'collecting',
  turnCount: 1,
  completed: false,
  proposalIds: [],
};

describe('postOnboardingTurn', () => {
  it('POSTs the turn endpoint with a JSON body and returns the parsed response', async () => {
    const client = ok(sample);
    const out = await postOnboardingTurn(client, { sessionId: 's1', userMessage: 'hello' });
    expect(out).toEqual(sample);
    expect(client).toHaveBeenCalledWith(
      '/api/onboarding/conversation/turn',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 's1', userMessage: 'hello' }),
      }),
    );
  });

  it('sends an empty body when opening a new session', async () => {
    const client = ok({ ...sample, turnCount: 0 });
    await postOnboardingTurn(client);
    const body = JSON.parse((client.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({});
  });

  it('throws with the server message on a non-2xx', async () => {
    const client = vi.fn(async () =>
      ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ message: 'Session does not exist for this tenant' }),
      }) as unknown as Response,
    );
    await expect(postOnboardingTurn(client, { sessionId: 'x' })).rejects.toThrow(
      /Session does not exist for this tenant/,
    );
  });
});
