import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const conv = {
  active: false,
  partial: '',
  error: null as string | null,
  isSpeaking: false,
  supported: true,
  start: vi.fn(),
  stop: vi.fn(),
  speak: vi.fn(),
  opts: null as null | { onSubmit: (text: string) => void | Promise<void> },
};
vi.mock('../../../../hooks/useConversationVoice', () => ({
  useConversationVoice: (opts: { onSubmit: (text: string) => void | Promise<void> }) => {
    conv.opts = opts;
    return {
      active: conv.active,
      partial: conv.partial,
      error: conv.error,
      isSpeaking: conv.isSpeaking,
      supported: conv.supported,
      start: conv.start,
      stop: conv.stop,
      speak: conv.speak,
    };
  },
}));

const apiFetchMock = vi.fn();
vi.mock('../../../../lib/apiClient', () => ({ useApiClient: () => apiFetchMock }));

import { ConversationStep } from './ConversationStep';

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('ConversationStep — B1.19 AC-1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    conv.active = false;
    conv.partial = '';
    conv.error = null;
    conv.supported = true;
  });

  it('renders the opening prompt after bootstrapping a session', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-1',
        assistantMessage: "Hi! Tell me about your business.",
        state: 'profile_capture',
        turnCount: 0,
        completed: false,
        proposalIds: [],
      }),
    );

    render(
      <ConversationStep tenantId="tenant-1" onCompleted={() => {}} onExit={() => {}} />,
    );

    await waitFor(() =>
      expect(screen.getByText('Hi! Tell me about your business.')).toBeInTheDocument(),
    );
    expect(screen.getByText('Business profile')).toBeInTheDocument();
  });

  it('submits typed answers through the same turn endpoint as voice (AC-8 text-injected path)', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-2',
        assistantMessage: 'Opening prompt',
        state: 'profile_capture',
        turnCount: 0,
        completed: false,
        proposalIds: [],
      }),
    );

    render(
      <ConversationStep tenantId="tenant-1" onCompleted={() => {}} onExit={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('Opening prompt')).toBeInTheDocument());

    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-2',
        assistantMessage: 'What services do you offer?',
        state: 'category_capture',
        turnCount: 1,
        completed: false,
        proposalIds: [],
      }),
    );

    fireEvent.change(screen.getByLabelText('Your answer'), {
      target: { value: 'Acme HVAC in Austin' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() =>
      expect(screen.getByText('What services do you offer?')).toBeInTheDocument(),
    );
    expect(screen.getByText('Acme HVAC in Austin')).toBeInTheDocument();

    const turnCall = apiFetchMock.mock.calls[1];
    expect(JSON.parse((turnCall[1] as RequestInit).body as string)).toEqual({
      sessionId: 'sess-2',
      userMessage: 'Acme HVAC in Austin',
      // The client sends the browser's zone so the server need not default
      // one; onboarding gates rather than guesses when it is absent.
      clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it('routes settled mic utterances through the same onSubmit seam as useConversationVoice', async () => {
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
    render(
      <ConversationStep tenantId="tenant-1" onCompleted={() => {}} onExit={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('Opening prompt')).toBeInTheDocument());

    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-3',
        assistantMessage: 'Got it.',
        state: 'category_capture',
        turnCount: 1,
        completed: false,
        proposalIds: [],
      }),
    );

    expect(conv.opts).not.toBeNull();
    await conv.opts!.onSubmit('spoken utterance');

    await waitFor(() => expect(screen.getByText('Got it.')).toBeInTheDocument());
    expect(screen.getByText('spoken utterance')).toBeInTheDocument();
  });

  it('calls onCompleted exactly once when the FSM reaches a terminal state', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-4',
        assistantMessage: 'Opening prompt',
        state: 'schedule_capture',
        turnCount: 5,
        completed: false,
        proposalIds: [],
      }),
    );
    const onCompleted = vi.fn();
    render(
      <ConversationStep tenantId="tenant-1" onCompleted={onCompleted} onExit={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('Opening prompt')).toBeInTheDocument());

    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-4',
        assistantMessage: 'Done. Your setup proposals are in the inbox.',
        state: 'completed',
        turnCount: 6,
        completed: true,
        proposalIds: ['prop-1'],
      }),
    );

    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'looks good' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Continue setup/i)).toBeInTheDocument();
  });

  it('falls back to the typed input and disables the mic toggle when voice is unsupported', async () => {
    conv.supported = false;
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-5',
        assistantMessage: 'Opening prompt',
        state: 'profile_capture',
        turnCount: 0,
        completed: false,
        proposalIds: [],
      }),
    );
    render(
      <ConversationStep tenantId="tenant-1" onCompleted={() => {}} onExit={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('Opening prompt')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /start talking/i })).toBeDisabled();
    expect(screen.getByLabelText('Your answer')).toBeInTheDocument();
  });

  it('calls onExit when "switch back" is clicked', async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        sessionId: 'sess-6',
        assistantMessage: 'Opening prompt',
        state: 'profile_capture',
        turnCount: 0,
        completed: false,
        proposalIds: [],
      }),
    );
    const onExit = vi.fn();
    render(
      <ConversationStep tenantId="tenant-1" onCompleted={() => {}} onExit={onExit} />,
    );
    await waitFor(() => expect(screen.getByText('Opening prompt')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /prefer the form/i }));
    expect(onExit).toHaveBeenCalled();
  });
});
