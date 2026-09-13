/**
 * B1.19 AC-7 — mobile/glove layout contract for the conversational
 * onboarding step. jsdom can't measure real overflow, so this pins the CSS
 * class contract (min-h-11 ≥44px targets, min-w-0/break-words so long
 * transcript bubbles don't force horizontal scroll) the same way
 * EstimateApprovalPage.layout.test.tsx does. Real overflow measurement at
 * 320px lives in e2e/onboarding-conversation-mobile.spec.ts.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../hooks/useConversationVoice', () => ({
  useConversationVoice: () => ({
    active: false,
    partial: '',
    error: null,
    isSpeaking: false,
    supported: true,
    start: vi.fn(),
    stop: vi.fn(),
    speak: vi.fn(),
  }),
}));

const apiFetchMock = vi.fn();
vi.mock('../../../../lib/apiClient', () => ({ useApiClient: () => apiFetchMock }));

import { ConversationStep } from './ConversationStep';

const LONG_UTTERANCE =
  'SoWeHaveThreeTechniciansAndACoupleOfDispatchersAndWeCoverAustinRoundRockAndPflugerville ' +
  'plus emergency after-hours calls on weekends';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('ConversationStep — mobile layout contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('gives the mic toggle and send button ≥44px (min-h-11) tap targets', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-1',
        assistantMessage: 'Opening prompt',
        state: 'profile_capture',
        turnCount: 0,
        completed: false,
        proposalIds: [],
      }),
    );

    render(<ConversationStep tenantId="tenant-1" onCompleted={() => {}} onExit={() => {}} />);
    await waitFor(() => expect(screen.getByText('Opening prompt')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /start talking/i }).className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: /^send$/i }).className).toContain('min-h-11');
    expect(screen.getByLabelText('Your answer').className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: /prefer the form/i }).className).toContain('min-h-11');
  });

  it('wraps long transcript bubbles instead of forcing horizontal overflow', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-2',
        assistantMessage: LONG_UTTERANCE,
        state: 'team_capture',
        turnCount: 3,
        completed: false,
        proposalIds: [],
      }),
    );

    render(<ConversationStep tenantId="tenant-1" onCompleted={() => {}} onExit={() => {}} />);
    await waitFor(() => expect(screen.getByText(LONG_UTTERANCE)).toBeInTheDocument());

    const bubble = screen.getByText(LONG_UTTERANCE);
    expect(bubble.className).toContain('break-words');
    expect(bubble.className).toContain('min-w-0');

    const transcript = screen.getByTestId('conversation-transcript');
    expect(transcript.className).toContain('min-w-0');
  });

  it('the input row and its flex-1 field can shrink below content size (min-w-0) so the row never overflows', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-3',
        assistantMessage: 'Opening prompt',
        state: 'profile_capture',
        turnCount: 0,
        completed: false,
        proposalIds: [],
      }),
    );

    render(<ConversationStep tenantId="tenant-1" onCompleted={() => {}} onExit={() => {}} />);
    await waitFor(() => expect(screen.getByText('Opening prompt')).toBeInTheDocument());

    const input = screen.getByLabelText('Your answer');
    expect(input.className).toContain('min-w-0');
    expect(input.className).toContain('flex-1');

    const form = input.closest('form');
    expect(form).not.toBeNull();
    expect(form!.className).toContain('min-w-0');
  });
});
