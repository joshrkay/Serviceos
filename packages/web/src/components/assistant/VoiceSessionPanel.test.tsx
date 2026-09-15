/**
 * #1019 6.1b (G1 2, ZERO tests) — VoiceSessionPanel component tests.
 *
 * VoiceSessionPanel had no test coverage at all before this file. Mocks
 * `useVoiceSession` (its own hook now covered separately in
 * useVoiceSession.test.ts) so this file is a pure rendering/interaction
 * unit test: the "Start session" affordance before a session exists, the
 * state badge + agent text once one does, the text-input form (Send / End,
 * with the disabled states each action depends on), and the queued-proposal
 * count.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoiceSessionPanel } from './VoiceSessionPanel';
import { useVoiceSession, type UseVoiceSession } from '../../hooks/useVoiceSession';

vi.mock('../../hooks/useVoiceSession', () => ({
  useVoiceSession: vi.fn(),
}));

const mockedUseVoiceSession = vi.mocked(useVoiceSession);

function session(overrides: Partial<UseVoiceSession> = {}): UseVoiceSession {
  return {
    sessionId: null,
    state: null,
    isStarting: false,
    isSending: false,
    ended: false,
    proposalIds: [],
    lastTtsText: null,
    start: vi.fn(),
    send: vi.fn(),
    end: vi.fn(),
    ...overrides,
  };
}

describe('VoiceSessionPanel', () => {
  beforeEach(() => {
    mockedUseVoiceSession.mockReset();
  });

  it('shows only "Start session" before a session exists, and calls start() on click', () => {
    const start = vi.fn();
    mockedUseVoiceSession.mockReturnValue(session({ start }));
    render(<VoiceSessionPanel />);

    expect(screen.queryByPlaceholderText('Type your message…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('disables the start button and shows "Starting…" while isStarting', () => {
    mockedUseVoiceSession.mockReturnValue(session({ isStarting: true }));
    render(<VoiceSessionPanel />);
    const button = screen.getByRole('button', { name: 'Starting…' });
    expect(button).toBeDisabled();
  });

  it('renders the state badge and the agent\'s last spoken text once a session exists', () => {
    mockedUseVoiceSession.mockReturnValue(
      session({ sessionId: 'sess-1', state: 'intent_capture', lastTtsText: 'Which job is this for?' }),
    );
    render(<VoiceSessionPanel />);

    expect(screen.getByText('intent_capture')).toBeInTheDocument();
    expect(screen.getByText('Which job is this for?')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type your message…')).toBeInTheDocument();
  });

  it('typing and submitting calls send() with the drafted text and clears the input', () => {
    const send = vi.fn();
    mockedUseVoiceSession.mockReturnValue(session({ sessionId: 'sess-1', send }));
    render(<VoiceSessionPanel />);

    const input = screen.getByPlaceholderText('Type your message…') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'book Thursday at 10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(send).toHaveBeenCalledWith('book Thursday at 10');
    expect(input.value).toBe('');
  });

  it('does not call send() for a whitespace-only draft', () => {
    const send = vi.fn();
    mockedUseVoiceSession.mockReturnValue(session({ sessionId: 'sess-1', send }));
    render(<VoiceSessionPanel />);

    const input = screen.getByPlaceholderText('Type your message…');
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('clicking End calls end()', () => {
    const end = vi.fn();
    mockedUseVoiceSession.mockReturnValue(session({ sessionId: 'sess-1', end }));
    render(<VoiceSessionPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('once ended, the input and Send/End buttons are disabled and the placeholder changes', () => {
    mockedUseVoiceSession.mockReturnValue(session({ sessionId: 'sess-1', ended: true }));
    render(<VoiceSessionPanel />);

    expect(screen.getByPlaceholderText('Session ended')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'End' })).toBeDisabled();
  });

  it('shows the queued-proposal count only when at least one exists', () => {
    mockedUseVoiceSession.mockReturnValue(session({ sessionId: 'sess-1' }));
    const { rerender } = render(<VoiceSessionPanel />);
    expect(screen.queryByText(/Proposals queued/)).toBeNull();

    mockedUseVoiceSession.mockReturnValue(
      session({ sessionId: 'sess-1', proposalIds: ['p-1', 'p-2'] }),
    );
    rerender(<VoiceSessionPanel />);
    expect(screen.getByText('Proposals queued: 2')).toBeInTheDocument();
  });
});
