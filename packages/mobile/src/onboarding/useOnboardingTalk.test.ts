// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAILED_COPY, SESSION_GONE_COPY, type OnboardingTurnOutcome } from './talkThrough';
import {
  NOT_HEARD_COPY,
  SAVE_CHECK_FAILED_COPY,
  SAVE_FAILED_COPY,
  SAVE_POLL_ATTEMPTS,
  SAVE_SLOW_COPY,
  NOTHING_CAPTURED_COPY,
  STATUS_UNKNOWN_COPY,
  STT_UNAVAILABLE_COPY,
  TRANSCRIBE_FAILED_COPY,
  useOnboardingTalk,
  type OnboardingTalkDeps,
} from './useOnboardingTalk';

const SESSION = '6f0a8b52-0c64-4d0f-9d43-6f5f2b1a7c11';

const reply = (
  assistantMessage: string,
  extra: Partial<{ completed: boolean; proposalIds: string[]; sessionId: string; turnCount: number }> = {},
): OnboardingTurnOutcome => ({
  kind: 'turn',
  turn: { sessionId: SESSION, assistantMessage, completed: false, turnCount: 0, proposalIds: [], ...extra },
});

function makeDeps(overrides: Partial<OnboardingTalkDeps> = {}): OnboardingTalkDeps {
  return {
    sendTurn: vi.fn().mockResolvedValue(reply('What do you call the business?')),
    transcribe: vi.fn().mockResolvedValue({ transcript: 'Walsh Plumbing' }),
    speak: vi.fn(),
    approve: vi.fn().mockResolvedValue({ approved: ['p1', 'p2'], failed: [] }),
    stillAwaiting: vi.fn().mockImplementation(async (ids: string[]) => ids),
    identityDone: vi.fn().mockResolvedValue(true),
    timezone: 'America/New_York',
    wait: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function started(deps: OnboardingTalkDeps) {
  const hook = renderHook(() => useOnboardingTalk(deps));
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  return hook;
}

afterEach(cleanup);

describe('useOnboardingTalk', () => {
  it('opens with Rivet\'s greeting, shown and spoken, sending the device zone', async () => {
    const deps = makeDeps();
    const { result } = await started(deps);
    expect(deps.sendTurn).toHaveBeenCalledTimes(1);
    expect(deps.sendTurn).toHaveBeenCalledWith({ clientTimezone: 'America/New_York' });
    expect(result.current.turns).toEqual([{ id: 't1', role: 'rivet', text: 'What do you call the business?' }]);
    expect(deps.speak).toHaveBeenCalledWith('What do you call the business?', expect.any(Function));
  });

  it('reaching for the mic drops a reply that has not started playing, so it cannot cut the recording', async () => {
    const deps = makeDeps();
    const { result } = await started(deps);
    const isCurrent = vi.mocked(deps.speak).mock.calls[0][1];
    expect(isCurrent()).toBe(true);
    act(() => result.current.hush());
    expect(isCurrent()).toBe(false);
    vi.mocked(deps.sendTurn).mockResolvedValueOnce(reply('What trade are you in?'));
    await act(() => result.current.sendText('Walsh Plumbing'));
    expect(vi.mocked(deps.speak).mock.calls[1][1]()).toBe(true);
  });

  it('omits the zone when the device does not know it, so the server asks', async () => {
    const deps = makeDeps({ timezone: undefined });
    await started(deps);
    expect(deps.sendTurn).toHaveBeenCalledWith({});
  });

  it('sends a spoken answer in the same conversation and shows both sides', async () => {
    const deps = makeDeps();
    const { result } = await started(deps);
    vi.mocked(deps.sendTurn).mockResolvedValueOnce(reply('What trade are you in?'));
    await act(() => result.current.sendAudio('file:///clip.m4a'));
    expect(deps.transcribe).toHaveBeenCalledWith('file:///clip.m4a');
    expect(deps.sendTurn).toHaveBeenLastCalledWith({ sessionId: SESSION, userMessage: 'Walsh Plumbing', clientTimezone: 'America/New_York' });
    expect(result.current.turns.map((t) => [t.role, t.text])).toEqual([
      ['rivet', 'What do you call the business?'],
      ['owner', 'Walsh Plumbing'],
      ['rivet', 'What trade are you in?'],
    ]);
    expect(result.current.status).toBe('ready');
  });

  it('says so when nothing was heard, and sends nothing', async () => {
    const deps = makeDeps({ transcribe: vi.fn().mockResolvedValue({ transcript: '  ' }) });
    const { result } = await started(deps);
    await act(() => result.current.sendAudio('file:///clip.m4a'));
    expect(result.current.error).toEqual({ message: NOT_HEARD_COPY, action: 'none' });
    expect(deps.sendTurn).toHaveBeenCalledTimes(1);
  });

  it('says so when the clip could not be transcribed', async () => {
    const deps = makeDeps({ transcribe: vi.fn().mockRejectedValue(new Error('502')) });
    const { result } = await started(deps);
    await act(() => result.current.sendAudio('file:///clip.m4a'));
    expect(result.current.error).toEqual({ message: TRANSCRIBE_FAILED_COPY, action: 'none' });
    expect(result.current.status).toBe('ready');
  });

  it('switches to typing when the server has no transcription', async () => {
    const deps = makeDeps({ transcribe: vi.fn().mockResolvedValue({ notConfigured: true }) });
    const { result } = await started(deps);
    await act(() => result.current.sendAudio('file:///clip.m4a'));
    expect(result.current.sttUnavailable).toBe(true);
    expect(result.current.error?.message).toBe(STT_UNAVAILABLE_COPY);
  });

  it('a failed turn keeps the owner\'s words and "Try again" re-sends exactly them', async () => {
    const deps = makeDeps();
    const { result } = await started(deps);
    vi.mocked(deps.sendTurn).mockResolvedValueOnce({ kind: 'failed', message: FAILED_COPY });
    await act(() => result.current.sendText('We do plumbing'));
    expect(result.current.error).toEqual({ message: FAILED_COPY, action: 'retry_turn' });
    // The server never took it: the replay shows the count unchanged, so the words are re-sent.
    vi.mocked(deps.sendTurn)
      .mockResolvedValueOnce(reply('What do you call the business?', { turnCount: 0 }))
      .mockResolvedValueOnce(reply('Who works with you?', { turnCount: 1 }));
    await act(() => result.current.recover());
    expect(vi.mocked(deps.sendTurn).mock.calls.at(-2)?.[0]).toEqual({ sessionId: SESSION, clientTimezone: 'America/New_York' });
    expect(deps.sendTurn).toHaveBeenLastCalledWith({ sessionId: SESSION, userMessage: 'We do plumbing', clientTimezone: 'America/New_York' });
    expect(result.current.turns.filter((t) => t.role === 'owner')).toHaveLength(1);
    expect(result.current.turns.at(-1)?.text).toBe('Who works with you?');
    expect(result.current.error).toBeNull();
  });

  it('a turn the server took but whose answer was lost is not re-sent on "Try again"', async () => {
    const deps = makeDeps();
    const { result } = await started(deps);
    vi.mocked(deps.sendTurn).mockResolvedValueOnce({ kind: 'failed', message: FAILED_COPY });
    await act(() => result.current.sendText('We do plumbing'));
    vi.mocked(deps.sendTurn).mockResolvedValueOnce(reply('Who works with you?', { turnCount: 1 }));
    await act(() => result.current.recover());
    expect(deps.sendTurn).toHaveBeenLastCalledWith({ sessionId: SESSION, clientTimezone: 'America/New_York' });
    expect(vi.mocked(deps.sendTurn).mock.calls.filter(([req]) => req.userMessage === 'We do plumbing')).toHaveLength(1);
    expect(result.current.turns.map((t) => t.text)).toEqual(['What do you call the business?', 'We do plumbing', 'Who works with you?']);
    expect(result.current.status).toBe('ready');
  });

  it('a lost completing turn lands in review from the replay', async () => {
    const deps = makeDeps();
    const { result } = await started(deps);
    vi.mocked(deps.sendTurn).mockResolvedValueOnce({ kind: 'failed', message: FAILED_COPY });
    await act(() => result.current.sendText('Weekdays seven to five'));
    vi.mocked(deps.sendTurn).mockResolvedValueOnce(reply("That's everything I need.", { turnCount: 5, completed: true, proposalIds: ['p1'] }));
    await act(() => result.current.recover());
    expect(result.current.status).toBe('review');
    expect(result.current.proposalIds).toEqual(['p1']);
  });

  it('a replay that also fails keeps "Try again"', async () => {
    const deps = makeDeps();
    const { result } = await started(deps);
    vi.mocked(deps.sendTurn).mockResolvedValueOnce({ kind: 'failed', message: FAILED_COPY });
    await act(() => result.current.sendText('We do plumbing'));
    vi.mocked(deps.sendTurn).mockResolvedValueOnce({ kind: 'failed', message: FAILED_COPY });
    await act(() => result.current.recover());
    expect(result.current.error).toEqual({ message: FAILED_COPY, action: 'retry_turn' });
    expect(result.current.status).toBe('ready');
  });

  it('an expired conversation is said out loud, and "Start again" opens a new one', async () => {
    const deps = makeDeps();
    const { result } = await started(deps);
    vi.mocked(deps.sendTurn).mockResolvedValueOnce({ kind: 'session_gone', message: SESSION_GONE_COPY });
    await act(() => result.current.sendText('We do plumbing'));
    expect(result.current.error).toEqual({ message: SESSION_GONE_COPY, action: 'restart' });
    vi.mocked(deps.sendTurn).mockResolvedValueOnce(reply('Let\'s start over. What do you call the business?', { sessionId: 'new' }));
    await act(() => result.current.recover());
    expect(deps.sendTurn).toHaveBeenLastCalledWith({ clientTimezone: 'America/New_York' });
    expect(result.current.turns).toHaveLength(1);
  });

  it('a non-owner gets the reason and no button', async () => {
    const deps = makeDeps({ sendTurn: vi.fn().mockResolvedValue({ kind: 'forbidden', message: 'Only the account owner can set up the business.' }) });
    const { result } = renderHook(() => useOnboardingTalk(deps));
    await waitFor(() => expect(result.current.error?.action).toBe('none'));
  });

  async function inReview(deps: OnboardingTalkDeps) {
    const hook = await started(deps);
    vi.mocked(deps.sendTurn).mockResolvedValueOnce(reply("That's everything I need.", { completed: true, proposalIds: ['p1', 'p2'] }));
    await act(() => hook.result.current.sendText('Weekdays seven to five'));
    expect(hook.result.current.status).toBe('review');
    return hook;
  }

  it('a finished conversation lists its setup items for review; saving approves them and waits for setup to apply', async () => {
    const identityDone = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const deps = makeDeps({ identityDone });
    const { result } = await inReview(deps);
    expect(result.current.proposalIds).toEqual(['p1', 'p2']);
    await act(() => result.current.save(['p1', 'p2']));
    expect(deps.approve).toHaveBeenCalledWith(['p1', 'p2']);
    expect(identityDone).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('finished');
  });

  it('a refused item stays for review with its reason, and "Try again" re-sends only what is still waiting', async () => {
    const deps = makeDeps({
      approve: vi.fn().mockResolvedValueOnce({ approved: ['p1'], failed: [{ id: 'p2', reason: 'VALIDATION_ERROR' }] }),
    });
    const { result } = await inReview(deps);
    await act(() => result.current.save(['p1', 'p2']));
    expect(result.current.status).toBe('review');
    expect(result.current.proposalIds).toEqual(['p2']);
    expect(result.current.error?.message).toMatch(/^1 setup item still needs a detail/);
    vi.mocked(deps.approve).mockResolvedValueOnce({ approved: ['p2'], failed: [] });
    await act(() => result.current.recover());
    expect(deps.stillAwaiting).toHaveBeenCalledWith(['p2']);
    expect(deps.approve).toHaveBeenLastCalledWith(['p2']);
    expect(result.current.status).toBe('finished');
  });

  it('a save whose answer was lost but went through is not re-approved on "Try again"', async () => {
    const deps = makeDeps({ approve: vi.fn().mockRejectedValueOnce(new Error('offline')) });
    const { result } = await inReview(deps);
    await act(() => result.current.save(['p1', 'p2']));
    vi.mocked(deps.stillAwaiting).mockResolvedValueOnce([]);
    await act(() => result.current.recover());
    expect(deps.approve).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('finished');
  });

  it('a retry only re-approves what is still waiting', async () => {
    const deps = makeDeps({ approve: vi.fn().mockRejectedValueOnce(new Error('offline')) });
    const { result } = await inReview(deps);
    await act(() => result.current.save(['p1', 'p2']));
    vi.mocked(deps.stillAwaiting).mockResolvedValueOnce(['p2']);
    vi.mocked(deps.approve).mockResolvedValueOnce({ approved: ['p2'], failed: [] });
    await act(() => result.current.recover());
    expect(deps.approve).toHaveBeenLastCalledWith(['p2']);
    expect(result.current.status).toBe('finished');
  });

  it('a retry that cannot check what was saved says so and sends nothing', async () => {
    const deps = makeDeps({ approve: vi.fn().mockRejectedValueOnce(new Error('offline')) });
    const { result } = await inReview(deps);
    await act(() => result.current.save(['p1', 'p2']));
    vi.mocked(deps.stillAwaiting).mockResolvedValueOnce(null);
    await act(() => result.current.recover());
    expect(deps.approve).toHaveBeenCalledTimes(1);
    expect(result.current.error).toEqual({ message: SAVE_CHECK_FAILED_COPY, action: 'retry_save' });
    expect(result.current.status).toBe('review');
  });

  it('a save that does not reach the server says so and can be retried', async () => {
    const deps = makeDeps({ approve: vi.fn().mockRejectedValueOnce(new Error('offline')) });
    const { result } = await inReview(deps);
    await act(() => result.current.save(['p1', 'p2']));
    expect(result.current.error).toEqual({ message: SAVE_FAILED_COPY, action: 'retry_save' });
    expect(result.current.status).toBe('review');
  });

  it('a setup that is slow to apply says so instead of opening the app early', async () => {
    const deps = makeDeps({ identityDone: vi.fn().mockResolvedValue(false) });
    const { result } = await inReview(deps);
    await act(() => result.current.save(['p1', 'p2']));
    expect(deps.identityDone).toHaveBeenCalledTimes(SAVE_POLL_ATTEMPTS);
    expect(result.current.status).toBe('saving');
    expect(result.current.error).toEqual({ message: SAVE_SLOW_COPY, action: 'check_again' });
    vi.mocked(deps.identityDone).mockResolvedValue(true);
    await act(() => result.current.recover());
    expect(result.current.status).toBe('finished');
  });

  it('only batch-eligible items are approved; the rest stay for review in Approvals and the app does not open', async () => {
    const deps = makeDeps({ approve: vi.fn().mockResolvedValue({ approved: ['p1'], failed: [] }) });
    const { result } = await inReview(deps);
    await act(() => result.current.save(['p1']));
    expect(deps.approve).toHaveBeenCalledWith(['p1']);
    expect(result.current.proposalIds).toEqual(['p2']);
    expect(result.current.status).toBe('review');
    expect(deps.identityDone).not.toHaveBeenCalled();
  });

  it('with nothing batch-eligible, saving approves nothing', async () => {
    const deps = makeDeps();
    const { result } = await inReview(deps);
    await act(() => result.current.save([]));
    expect(deps.approve).not.toHaveBeenCalled();
    expect(result.current.status).toBe('review');
  });

  it('a retry keeps held items out of the batch', async () => {
    const deps = makeDeps({ approve: vi.fn().mockRejectedValueOnce(new Error('offline')) });
    const { result } = await inReview(deps);
    await act(() => result.current.save(['p1']));
    vi.mocked(deps.approve).mockResolvedValueOnce({ approved: ['p1'], failed: [] });
    await act(() => result.current.recover());
    expect(deps.stillAwaiting).toHaveBeenLastCalledWith(['p1']);
    expect(deps.approve).toHaveBeenLastCalledWith(['p1']);
    expect(result.current.proposalIds).toEqual(['p2']);
  });

  it('typing an answer drops Rivet\'s pending line, so it cannot play out of order', async () => {
    const deps = makeDeps();
    const { result } = await started(deps);
    const isCurrent = vi.mocked(deps.speak).mock.calls[0][1];
    vi.mocked(deps.sendTurn).mockResolvedValueOnce(reply('What trade are you in?'));
    await act(() => result.current.sendText('Walsh Plumbing'));
    expect(isCurrent()).toBe(false);
  });

  it('a conversation that ends with nothing captured offers "Start again", not a dead end', async () => {
    const deps = makeDeps();
    const { result } = await started(deps);
    vi.mocked(deps.sendTurn).mockResolvedValueOnce(reply('Thanks, that is all I can ask.', { completed: true, proposalIds: [] }));
    await act(() => result.current.sendText('no idea'));
    expect(result.current.error).toEqual({ message: NOTHING_CAPTURED_COPY, action: 'restart' });
    vi.mocked(deps.sendTurn).mockResolvedValueOnce(reply('What do you call the business?', { sessionId: 'new' }));
    await act(() => result.current.recover());
    expect(deps.sendTurn).toHaveBeenLastCalledWith({ clientTimezone: 'America/New_York' });
    expect(result.current.status).toBe('ready');
    expect(result.current.turns).toHaveLength(1);
  });

  it('a status it cannot read is reported as unknown, not as done', async () => {
    const deps = makeDeps({ identityDone: vi.fn().mockRejectedValue(new Error('500')) });
    const { result } = await inReview(deps);
    await act(() => result.current.save(['p1', 'p2']));
    expect(result.current.error).toEqual({ message: STATUS_UNKNOWN_COPY, action: 'check_again' });
  });
});
