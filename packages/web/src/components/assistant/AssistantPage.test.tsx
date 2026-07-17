import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AssistantPage } from './AssistantPage';

vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
// Mock the authenticated fetch wrapper so tests can assert the page uses it
// (with the Clerk bearer token attached) instead of bare global fetch.
vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
// sonner's <Toaster> isn't mounted in unit tests — spy on toast.error to
// assert the visible error surface.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// U6 — spy on the analytics wrapper to assert assistant_message_sent fires.
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

// UB-B2 — controllable conversation-mode hook: page tests drive the captured
// onSubmit exactly like a settled utterance would, without WebSocket/mic fakes.
const conv = vi.hoisted(() => ({
  active: false,
  partial: '',
  start: vi.fn(),
  stop: vi.fn(),
  speak: vi.fn(),
  opts: null as null | { onSubmit: (text: string) => void | Promise<void> },
}));
vi.mock('../../hooks/useConversationVoice', () => ({
  useConversationVoice: (opts: { onSubmit: (text: string) => void | Promise<void> }) => {
    conv.opts = opts;
    return {
      active: conv.active,
      partial: conv.partial,
      error: null,
      isSpeaking: false,
      supported: true,
      start: conv.start,
      stop: conv.stop,
      speak: conv.speak,
    };
  },
}));

import { useDetailQuery } from '../../hooks/useDetailQuery';
import { apiFetch } from '../../utils/api-fetch';
import { toast } from 'sonner';
import { track } from '../../lib/analytics';

const mockedApiFetch = vi.mocked(apiFetch);
const trackMock = vi.mocked(track);

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const defaultDetailResult = {
  data: null,
  isLoading: false,
  error: null,
  refetch: vi.fn(),
};

beforeEach(() => {
  vi.mocked(useDetailQuery).mockReturnValue(defaultDetailResult);
  mockedApiFetch.mockReset();
  vi.mocked(toast.error).mockReset();
  localStorage.clear();
  conv.active = false;
  conv.partial = '';
  conv.start.mockReset();
  conv.stop.mockReset();
  conv.speak.mockReset();
  conv.opts = null;
});

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AssistantPage />
    </MemoryRouter>
  );
}

describe('AssistantPage', () => {
  it('shows welcome message when no conversationId', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Hi Ada!/)).toBeInTheDocument();
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });
  });

  it('renders messages from API when conversation data is available', async () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      ...defaultDetailResult,
      data: {
        id: 'conv1',
        messages: [
          { id: 'a1', role: 'assistant', content: 'Good morning! You have 3 jobs today.', createdAt: '2026-03-15T09:00:00Z' },
          { id: 'u1', role: 'user',      content: 'Any urgent ones?',                    createdAt: '2026-03-15T09:01:00Z' },
        ],
      },
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Good morning! You have 3 jobs today.')).toBeInTheDocument();
      expect(screen.getByText('Any urgent ones?')).toBeInTheDocument();
    });
  });

  it('shows welcome message when API returns error', async () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      ...defaultDetailResult,
      error: 'HTTP 404',
      data: null,
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });
  });

  it('renders the text input', () => {
    renderPage();
    expect(screen.getByPlaceholderText('Ask anything or give a command…')).toBeInTheDocument();
  });

  it('renders suggestion chips', () => {
    renderPage();
    expect(screen.getByText('Invoice the Rodriguez job')).toBeInTheDocument();
  });

  it('does not query API when no conversationId in URL', () => {
    renderPage();
    expect(vi.mocked(useDetailQuery)).toHaveBeenCalledWith('/api/conversations', null);
  });

  it('renders header with AI assistant name', () => {
    renderPage();
    expect(screen.getByText('Rivet AI')).toBeInTheDocument();
  });

  it('emits assistant_message_sent when a message is sent (enums/counts, no text)', async () => {
    trackMock.mockClear();
    mockedApiFetch.mockResolvedValue(jsonResponse({ message: { content: 'ok' }, conversationId: 'c1' }));
    renderPage();

    // A suggestion chip funnels through the same send() path as typed input.
    fireEvent.click(screen.getByText('Invoice the Rodriguez job'));

    await waitFor(() => {
      expect(trackMock.mock.calls.some((c) => c[0] === 'assistant_message_sent')).toBe(true);
    });
    const call = trackMock.mock.calls.find((c) => c[0] === 'assistant_message_sent')!;
    expect(call[1]).toMatchObject({ input_mode: 'text', has_attachment: false });
    expect(typeof (call[1] as { length: number }).length).toBe('number');
    // never the message text
    expect(JSON.stringify(call[1])).not.toContain('Rodriguez');
  });
});

// ─── Journey QA 2026-07-02 (bug 11): thread must survive the post-turn refetch ─

describe('journey QA bug 11 — reply survives the post-turn refetch', () => {
  async function sendFirstTurn() {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        message: { content: 'Focus on the two waiting estimates.' },
        conversationId: 'conv-9',
      }),
    );
    const view = renderPage();
    await waitFor(() => {
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText('Ask anything or give a command…');
    fireEvent.change(input, { target: { value: 'What should I focus on today?' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => {
      expect(screen.getByText('Focus on the two waiting estimates.')).toBeInTheDocument();
    });
    return view;
  }

  it('keeps the local bubbles when the refetched conversation carries NO messages', async () => {
    const view = await sendFirstTurn();

    // The reply pinned conversationId → useDetailQuery refetches. Simulate the
    // regression the journey hit: a conversation row without a messages array.
    vi.mocked(useDetailQuery).mockReturnValue({
      ...defaultDetailResult,
      data: { id: 'conv-9' },
    });
    view.rerender(
      <MemoryRouter>
        <AssistantPage />
      </MemoryRouter>,
    );

    // The thread must NOT reset to (only) the welcome bubble: both turn
    // bubbles survive the refetch. (The welcome bubble itself may remain —
    // it was already on screen before the turn.)
    expect(screen.getByText('What should I focus on today?')).toBeInTheDocument();
    expect(screen.getByText('Focus on the two waiting estimates.')).toBeInTheDocument();
  });

  it('keeps the local bubbles when the refetched thread is PARTIAL (fewer messages than local)', async () => {
    const view = await sendFirstTurn();

    vi.mocked(useDetailQuery).mockReturnValue({
      ...defaultDetailResult,
      data: {
        id: 'conv-9',
        messages: [
          { id: 'm1', role: 'user', content: 'What should I focus on today?', createdAt: '2026-07-02T14:00:00Z' },
        ],
      },
    });
    view.rerender(
      <MemoryRouter>
        <AssistantPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Focus on the two waiting estimates.')).toBeInTheDocument();
  });

  it('adopts the server thread when it is AHEAD of local (reload / other-device case)', async () => {
    const view = await sendFirstTurn();

    vi.mocked(useDetailQuery).mockReturnValue({
      ...defaultDetailResult,
      data: {
        id: 'conv-9',
        messages: [
          { id: 'm1', role: 'user', content: 'What should I focus on today?', createdAt: '2026-07-02T14:00:00Z' },
          { id: 'm2', role: 'assistant', content: 'Focus on the two waiting estimates.', createdAt: '2026-07-02T14:00:05Z' },
          { id: 'm3', role: 'assistant', content: 'Also: one invoice is overdue.', createdAt: '2026-07-02T14:00:09Z' },
        ],
      },
    });
    view.rerender(
      <MemoryRouter>
        <AssistantPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Also: one invoice is overdue.')).toBeInTheDocument();
    });
  });
});

// ─── P20-005: Accurate AI failure messaging ──────────────────────────────────

describe('P20-005 — AI failure messaging', () => {
  async function typeAndSend(text: string) {
    await waitFor(() => {
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText('Ask anything or give a command…');
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  }

  it('P20-005: shows accurate error message when chat API call fails (network error)', async () => {
    mockedApiFetch.mockRejectedValueOnce(new Error('Network error'));

    renderPage();
    await typeAndSend('Hello');

    await waitFor(() => {
      expect(
        screen.getByText('Unable to connect to AI service — please try again or contact support.')
      ).toBeInTheDocument();
    });
  });

  it('P20-005: shows accurate error message when chat API returns a non-2xx status', async () => {
    mockedApiFetch.mockResolvedValueOnce(
      new Response('Service Unavailable', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      })
    );

    renderPage();
    await typeAndSend('Hello');

    await waitFor(() => {
      expect(
        screen.getByText('Unable to connect to AI service — please try again or contact support.')
      ).toBeInTheDocument();
    });
  });

  it('P20-005: does not display "not connected yet" string on AI failure', async () => {
    mockedApiFetch.mockRejectedValueOnce(new Error('Network error'));

    renderPage();
    await typeAndSend('Hello');

    await waitFor(() => {
      expect(
        screen.getByText('Unable to connect to AI service — please try again or contact support.')
      ).toBeInTheDocument();
    });

    // The old misleading copy must not appear anywhere in the rendered output
    expect(screen.queryByText(/not connected yet/i)).not.toBeInTheDocument();
  });
});

// ─── OBS-41: safe error logging (no raw error object / PII) ─────────────────

describe('OBS-41 — AI chat failure logging does not leak the raw error object', () => {
  async function typeAndSend(text: string) {
    await waitFor(() => {
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText('Ask anything or give a command…');
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  }

  it('logs only a safe {name, message} shape, never the raw Error instance', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Simulate the shape apiFetch's 401 retry path / a JSON error body can
    // produce: an Error whose message embeds response-body-like content and
    // a bearer token, plus an extra property a raw response object might
    // carry (e.g. a parsed body attached by an upstream catch).
    const sensitiveError = Object.assign(
      new Error('API error: 401 — Authorization: Bearer super-secret-token-abc123'),
      { responseBody: { customerEmail: 'jane@example.com', ssn: '123-45-6789' } },
    );
    mockedApiFetch.mockRejectedValueOnce(sensitiveError);

    renderPage();
    await typeAndSend('Hello');

    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());

    const call = consoleErrorSpy.mock.calls.find((c) => c[0] === 'AI chat request failed:');
    expect(call).toBeDefined();

    // The raw Error instance (and its extra `responseBody` property) must
    // never be the thing that was logged.
    const logged = call?.[1];
    expect(logged).not.toBe(sensitiveError);
    expect(logged).not.toHaveProperty('responseBody');

    // Only a safe { name, message } shape is logged, and the message must
    // not carry the raw bearer token through untouched.
    expect(logged).toMatchObject({ name: 'Error' });
    const loggedMessage = (logged as { message?: string })?.message ?? '';
    expect(loggedMessage).not.toContain('super-secret-token-abc123');

    consoleErrorSpy.mockRestore();
  });
});

// ─── Story 3.12: retry affordance on a failed turn ───────────────────────────

describe('Story 3.12 — retry on agent failure', () => {
  async function typeAndSend(text: string) {
    await waitFor(() => {
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText('Ask anything or give a command…');
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  }

  it('offers a one-tap retry after a failed turn, then recovers', async () => {
    mockedApiFetch.mockRejectedValueOnce(new Error('Network error'));
    renderPage();
    await typeAndSend('Invoice Acme');

    // Inline error + an actionable retry (never a silent failure).
    await waitFor(() =>
      expect(screen.getByText(/Couldn.t reach the assistant/i)).toBeInTheDocument(),
    );
    const retry = screen.getByRole('button', { name: /^retry$/i });

    // The retry resends the SAME input; this attempt succeeds.
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({ message: { content: 'Created the invoice.' } }),
    );
    fireEvent.click(retry);

    await waitFor(() =>
      expect(screen.getByText('Created the invoice.')).toBeInTheDocument(),
    );
    // The retry strip clears once the resend succeeds.
    await waitFor(() =>
      expect(screen.queryByText(/Couldn.t reach the assistant/i)).toBeNull(),
    );
  });
});

// ─── B4: authenticated proposal approve/reject with visible failures ─────────

describe('B4 — proposal approve/reject', () => {
  const proposal = {
    id: 'prop-1',
    title: 'Invoice the Rodriguez job',
    summary: 'Create a $1,850 invoice for the Rodriguez exterior paint job.',
    explanation: 'Job marked complete with no invoice on file.',
    confidence: 'High',
    type: 'Invoice',
    status: 'Pending',
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Send a chat message whose reply carries a proposal card. */
  async function renderWithProposal() {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({ message: { content: 'Here is a draft invoice.', proposal } })
    );

    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });
    const input = screen.getByPlaceholderText('Ask anything or give a command…');
    fireEvent.change(input, { target: { value: 'Invoice the Rodriguez job' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    });
  }

  it('B4: approve goes through the authenticated api client, not bare fetch', async () => {
    await renderWithProposal();

    const bareFetch = vi.spyOn(globalThis, 'fetch');
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'prop-1', status: 'approved' } }));

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/api/proposals/prop-1/approve',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(bareFetch).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText('Applied successfully')).toBeInTheDocument();
    });
  });

  it('Finding 2: renders the undo toast after a successful approve (server-driven window)', async () => {
    await renderWithProposal();

    // Approve response now carries the server's undo window (approvedAt +
    // undoExpiresAt). The page must raise the shared undo toast — parity with
    // the inbox, which previously the assistant surface lacked entirely.
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        id: 'prop-1',
        status: 'approved',
        approvedAt: new Date().toISOString(),
        undoExpiresAt: new Date(Date.now() + 5000).toISOString(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(screen.getByTestId('undo-toast')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /undo/i })).toBeInTheDocument();
  });

  it('Finding 2: clicking Undo POSTs the undo endpoint for the approved proposal', async () => {
    await renderWithProposal();

    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        id: 'prop-1',
        status: 'approved',
        approvedAt: new Date().toISOString(),
        undoExpiresAt: new Date(Date.now() + 5000).toISOString(),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => screen.getByTestId('undo-toast'));

    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ id: 'prop-1', status: 'undone' }));
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));

    await waitFor(() => {
      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/api/proposals/prop-1/undo',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('B4: failed approve shows an error and does not mark the proposal approved', async () => {
    await renderWithProposal();

    mockedApiFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Couldn’t apply this suggestion. Please try again.');
    });
    // Card reverted to Pending — no fake success state.
    expect(screen.queryByText('Applied successfully')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  it('B4: reject goes through the authenticated api client, not bare fetch', async () => {
    await renderWithProposal();

    const bareFetch = vi.spyOn(globalThis, 'fetch');
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'prop-1', status: 'rejected' } }));

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    await waitFor(() => {
      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/api/proposals/prop-1/reject',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(bareFetch).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText(/dismissed/)).toBeInTheDocument();
    });
  });

  it('B4: failed reject shows an error and does not mark the proposal rejected', async () => {
    await renderWithProposal();

    mockedApiFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Couldn’t dismiss this suggestion. Please try again.');
    });
    expect(screen.queryByText(/dismissed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });
});

// ─── UB-B2: conversation mode ─────────────────────────────────────────────────

describe('UB-B2 — conversation mode', () => {
  it('renders a ≥44px conversation toggle that starts the session', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });

    const toggle = screen.getByTitle('Start conversation mode');
    // Tap-target class contract (min-h-11 = 44px).
    expect(toggle.className).toContain('min-h-11');

    fireEvent.click(toggle);
    expect(conv.start).toHaveBeenCalledTimes(1);
  });

  it('active session: toggle stops it and the live partial line renders in the composer', async () => {
    conv.active = true;
    conv.partial = 'invoice the rodr';
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });

    expect(screen.getByTestId('conversation-live-partial')).toHaveTextContent('invoice the rodr');

    fireEvent.click(screen.getByTitle('End conversation mode'));
    expect(conv.stop).toHaveBeenCalledTimes(1);
  });

  it('an utterance final auto-submits exactly ONE chat POST carrying inputMode voice', async () => {
    conv.active = true;
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({ message: { content: 'Sent the invoice.' } }),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });
    expect(conv.opts).not.toBeNull();

    await act(async () => {
      await conv.opts!.onSubmit('invoice the Rodriguez job');
    });

    await waitFor(() => {
      expect(screen.getByText('Sent the invoice.')).toBeInTheDocument();
    });
    // Exactly one POST, through the existing chat path, flagged as voice.
    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedApiFetch.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('/api/assistant/chat');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.inputMode).toBe('voice');
    expect(body.messages[body.messages.length - 1]).toEqual({
      role: 'user',
      content: 'invoice the Rodriguez job',
    });
  });

  it('speaks the reply through the conversation session (barge-in-interruptible TTS)', async () => {
    conv.active = true;
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({ message: { content: '**Done.** Invoice sent.' } }),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });

    await act(async () => {
      await conv.opts!.onSubmit('invoice the Rodriguez job');
    });

    await waitFor(() => {
      expect(conv.speak).toHaveBeenCalledWith('**Done.** Invoice sent.');
    });
  });

  it('a proposal riding a voice reply renders the same inline card as typed chat', async () => {
    conv.active = true;
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        message: {
          content: 'Here is a draft invoice.',
          proposal: {
            id: 'prop-9',
            title: 'Invoice the Rodriguez job',
            summary: 'Create a $1,850 invoice.',
            explanation: 'Job complete, no invoice on file.',
            confidence: 'High',
            type: 'Invoice',
            status: 'Pending',
          },
        },
      }),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });

    await act(async () => {
      await conv.opts!.onSubmit('invoice the Rodriguez job');
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    });
  });
});
