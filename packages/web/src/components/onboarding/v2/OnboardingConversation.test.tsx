import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OnboardingTurnResponse } from '../../../api/onboarding-conversation';

const apiFetchMock = vi.fn();
vi.mock('../../../lib/apiClient', () => ({ useApiClient: () => apiFetchMock }));

vi.mock('../../../api/onboarding-conversation', async () => {
  const actual = await vi.importActual<
    typeof import('../../../api/onboarding-conversation')
  >('../../../api/onboarding-conversation');
  return { ...actual, postOnboardingTurn: vi.fn() };
});

import { postOnboardingTurn } from '../../../api/onboarding-conversation';
import { OnboardingConversation } from './OnboardingConversation';

const turn = (over: Partial<OnboardingTurnResponse>): OnboardingTurnResponse => ({
  sessionId: 's1',
  assistantMessage: '...',
  state: 'collecting',
  turnCount: 0,
  completed: false,
  proposalIds: [],
  ...over,
});

const composer = () => screen.getByLabelText('Your message to the setup assistant');
const sendBtn = () => screen.getByRole('button', { name: 'Send' });

describe('OnboardingConversation', () => {
  beforeEach(() => {
    vi.mocked(postOnboardingTurn).mockReset();
  });

  it('fetches and renders the opening assistant prompt on mount', async () => {
    vi.mocked(postOnboardingTurn).mockResolvedValueOnce(
      turn({ assistantMessage: 'Hi! What is your business name?' }),
    );
    render(<OnboardingConversation />);
    await waitFor(() =>
      expect(screen.getByText('Hi! What is your business name?')).toBeInTheDocument(),
    );
    // Opener is fetched with no session/message (free turn).
    expect(postOnboardingTurn).toHaveBeenCalledWith(apiFetchMock);
  });

  it('sends a reply and appends the assistant response', async () => {
    vi.mocked(postOnboardingTurn)
      .mockResolvedValueOnce(turn({ assistantMessage: 'What is your business name?' }))
      .mockResolvedValueOnce(
        turn({ assistantMessage: 'Great — what services do you offer?', turnCount: 1 }),
      );
    render(<OnboardingConversation />);
    await waitFor(() => screen.getByText('What is your business name?'));

    fireEvent.change(composer(), { target: { value: 'Acme HVAC' } });
    fireEvent.click(sendBtn());

    await waitFor(() =>
      expect(screen.getByText('Great — what services do you offer?')).toBeInTheDocument(),
    );
    expect(screen.getByText('Acme HVAC')).toBeInTheDocument();
    expect(postOnboardingTurn).toHaveBeenLastCalledWith(apiFetchMock, {
      sessionId: 's1',
      userMessage: 'Acme HVAC',
    });
  });

  it('confirms drafted proposals and fires onComplete on a terminal turn', async () => {
    const onComplete = vi.fn();
    vi.mocked(postOnboardingTurn)
      .mockResolvedValueOnce(turn({ assistantMessage: 'Last question?' }))
      .mockResolvedValueOnce(
        turn({
          assistantMessage: 'All done!',
          state: 'completed',
          completed: true,
          proposalIds: ['p1', 'p2'],
        }),
      );
    render(<OnboardingConversation onComplete={onComplete} />);
    await waitFor(() => screen.getByText('Last question?'));

    fireEvent.change(composer(), { target: { value: 'done' } });
    fireEvent.click(sendBtn());

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/prepared 2 changes/i),
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
    // Composer is hidden once the FSM is terminal.
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('meets the mobile tap-target contract on the send button (≥44px)', async () => {
    vi.mocked(postOnboardingTurn).mockResolvedValueOnce(turn({ assistantMessage: 'Hi?' }));
    render(<OnboardingConversation />);
    await waitFor(() => screen.getByText('Hi?'));
    // min-h-11 == 2.75rem == 44px (CLAUDE.md mobile tap-target rule).
    expect(sendBtn().className).toContain('min-h-11');
  });

  it('surfaces an error and restores the message when a turn fails', async () => {
    vi.mocked(postOnboardingTurn)
      .mockResolvedValueOnce(turn({ assistantMessage: 'Hi?' }))
      .mockRejectedValueOnce(new Error('postOnboardingTurn: 500 Internal Server Error'));
    render(<OnboardingConversation />);
    await waitFor(() => screen.getByText('Hi?'));

    const ta = composer() as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hello' } });
    fireEvent.click(sendBtn());

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // The optimistic bubble is rolled back and the text restored.
    expect((composer() as HTMLTextAreaElement).value).toBe('hello');
  });
});
