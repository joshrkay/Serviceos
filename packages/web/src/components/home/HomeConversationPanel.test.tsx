import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

const navigateMock = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigateMock };
});

const detailQueryMock = vi.fn();
vi.mock('../../hooks/useDetailQuery', () => ({
  useDetailQuery: (...args: unknown[]) => detailQueryMock(...args),
}));

const dictationStart = vi.fn();
const dictationStop = vi.fn();
let dictationState = { isRecording: false, partial: '', error: null as string | null };
vi.mock('../../hooks/useDeepgramDictation', () => ({
  useDeepgramDictation: () => ({
    ...dictationState,
    supported: true,
    start: dictationStart,
    stop: dictationStop,
  }),
}));

import { HomeConversationPanel } from './HomeConversationPanel';

function renderPanel() {
  return render(
    <MemoryRouter>
      <HomeConversationPanel />
    </MemoryRouter>,
  );
}

describe('Story 3.1 — HomeConversationPanel', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    detailQueryMock.mockReset();
    detailQueryMock.mockReturnValue({ data: null, isLoading: false, error: null, refetch: vi.fn() });
    dictationStart.mockReset();
    dictationStop.mockReset();
    dictationState = { isRecording: false, partial: '', error: null };
    localStorage.clear();
  });

  it('renders an empty state when there is no conversation yet', () => {
    renderPanel();
    expect(screen.getByTestId('home-conversation-panel')).toBeTruthy();
    expect(screen.getByTestId('home-conversation-empty')).toBeTruthy();
  });

  it('previews the most recent turns (user + agent) inline', () => {
    detailQueryMock.mockReturnValue({
      data: {
        id: 'c1',
        messages: [
          { id: 'm1', role: 'user', content: 'Invoice the Rodriguez job', createdAt: '2026-06-21T10:00:00Z' },
          { id: 'm2', role: 'assistant', content: 'Here is a draft invoice for Rodriguez.', createdAt: '2026-06-21T10:00:01Z' },
        ],
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderPanel();
    expect(screen.getByText('Invoice the Rodriguez job')).toBeTruthy();
    expect(screen.getByText('Here is a draft invoice for Rodriguez.')).toBeTruthy();
    // Empty state is not shown once there are messages.
    expect(screen.queryByTestId('home-conversation-empty')).toBeNull();
  });

  it('hands a typed message off to the persistent thread via /assistant?q=', () => {
    renderPanel();
    const input = screen.getByLabelText('Message the assistant');
    fireEvent.change(input, { target: { value: 'schedule Thompson for Tuesday' } });
    fireEvent.click(screen.getByLabelText('Send'));
    expect(navigateMock).toHaveBeenCalledWith(
      '/assistant?q=schedule%20Thompson%20for%20Tuesday',
    );
  });

  it('Enter submits; Shift+Enter does not', () => {
    renderPanel();
    const input = screen.getByLabelText('Message the assistant');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(navigateMock).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigateMock).toHaveBeenCalledWith('/assistant?q=hello');
  });

  it('opens the thread with no seed when the composer is empty', () => {
    renderPanel();
    fireEvent.click(screen.getByText('Open'));
    expect(navigateMock).toHaveBeenCalledWith('/assistant');
  });

  it('meets the ≥44px tap-target contract on interactive controls', () => {
    renderPanel();
    // Send button: size-11 == 44px.
    expect(screen.getByLabelText('Send').className).toContain('size-11');
    // Header "Open" and the empty-state CTA carry min-h-11 (44px).
    expect(screen.getByText('Open').closest('button')!.className).toContain('min-h-11');
    expect(screen.getByTestId('home-conversation-empty').className).toContain('min-h-11');
  });

  it('starts live dictation when the mic is tapped', () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText('Voice'));
    expect(dictationStart).toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('shows a stop control and surfaces dictation errors while recording', () => {
    dictationState = { isRecording: true, partial: 'invoice the', error: 'Microphone permission is required for voice dictation.' };
    renderPanel();
    fireEvent.click(screen.getByLabelText('Stop dictation'));
    expect(dictationStop).toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/microphone permission/i);
  });

  it('renders the composer on Path A tokens — no raw Tailwind palette leaks', () => {
    const { container } = renderPanel();
    expect(container.innerHTML).not.toMatch(
      /(bg|text|border|border-l|border-t|placeholder|ring|divide|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
    );
  });
});
