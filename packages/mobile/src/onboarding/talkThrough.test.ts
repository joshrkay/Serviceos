import { describe, expect, it, vi } from 'vitest';
import {
  approvalFailureCopy,
  CONFLICT_COPY,
  deviceTimezoneOrUndefined,
  FAILED_COPY,
  FORBIDDEN_COPY,
  postOnboardingTurn,
  SESSION_GONE_COPY,
} from './talkThrough';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const TURN = {
  sessionId: '6f0a8b52-0c64-4d0f-9d43-6f5f2b1a7c11',
  assistantMessage: 'What do you call the business?',
  state: 'profile_capture',
  turnCount: 0,
  completed: false,
  proposalIds: [],
};

describe('postOnboardingTurn', () => {
  it('posts the turn to the setup conversation and returns Rivet\'s reply', async () => {
    const api = vi.fn().mockResolvedValue(json(200, TURN));
    const out = await postOnboardingTurn(api, { sessionId: TURN.sessionId, userMessage: 'Walsh Plumbing', clientTimezone: 'America/New_York' });
    expect(api).toHaveBeenCalledWith('/api/onboarding/conversation/turn', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({
      sessionId: TURN.sessionId,
      userMessage: 'Walsh Plumbing',
      clientTimezone: 'America/New_York',
    });
    expect(out).toEqual({
      kind: 'turn',
      turn: { sessionId: TURN.sessionId, assistantMessage: TURN.assistantMessage, completed: false, proposalIds: [] },
    });
  });

  it('carries the proposal ids of the completing turn', async () => {
    const api = vi.fn().mockResolvedValue(json(200, { ...TURN, completed: true, proposalIds: ['p1', 'p2', 7] }));
    const out = await postOnboardingTurn(api, {});
    expect(out).toMatchObject({ kind: 'turn', turn: { completed: true, proposalIds: ['p1', 'p2'] } });
  });

  it.each([
    [404, 'session_gone', SESSION_GONE_COPY],
    [409, 'conflict', CONFLICT_COPY],
    [403, 'forbidden', FORBIDDEN_COPY],
    [500, 'failed', FAILED_COPY],
  ])('a %i is the %s outcome with its own copy', async (status, kind, message) => {
    const api = vi.fn().mockResolvedValue(json(status, { error: 'X' }));
    expect(await postOnboardingTurn(api, {})).toEqual({ kind, message });
  });

  it('a network failure is a failed turn, not a throw', async () => {
    const api = vi.fn().mockRejectedValue(new TypeError('Network request failed'));
    expect(await postOnboardingTurn(api, {})).toEqual({ kind: 'failed', message: FAILED_COPY });
  });

  it('a 200 without a reply is a failed turn, never an empty bubble', async () => {
    const api = vi.fn().mockResolvedValue(json(200, { sessionId: TURN.sessionId }));
    expect(await postOnboardingTurn(api, {})).toEqual({ kind: 'failed', message: FAILED_COPY });
  });
});

describe('deviceTimezoneOrUndefined', () => {
  it('returns the device zone', () => {
    expect(deviceTimezoneOrUndefined()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('returns undefined, never a default zone, when the device cannot say', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('no Intl');
    });
    expect(deviceTimezoneOrUndefined()).toBeUndefined();
    spy.mockRestore();
  });
});

describe('approvalFailureCopy', () => {
  it('is empty when nothing failed', () => {
    expect(approvalFailureCopy([])).toBe('');
  });

  it('names a missing detail when every refusal is a gate', () => {
    expect(approvalFailureCopy([{ id: 'a', reason: 'VALIDATION_ERROR' }])).toBe(
      "1 setup item still needs a detail I didn't get. Finish it in the web app under Approvals, or skip for now.",
    );
    expect(approvalFailureCopy([{ id: 'a', reason: 'VALIDATION_ERROR' }, { id: 'b', reason: 'VALIDATION_ERROR' }])).toMatch(
      /^2 setup items still need a detail/,
    );
  });

  it('shows any other reason rather than dropping it', () => {
    expect(approvalFailureCopy([{ id: 'a', reason: 'NOT_FOUND' }, { id: 'b', reason: 'VALIDATION_ERROR' }])).toBe(
      "2 setup items couldn't be saved (NOT_FOUND, VALIDATION_ERROR). Try again, or finish them in the web app under Approvals.",
    );
  });
});
