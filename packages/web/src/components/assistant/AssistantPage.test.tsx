import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AssistantPage } from './AssistantPage';

vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../../data/mock-data', () => ({
  type: {},
}));
// Mock the authenticated fetch wrapper so tests can assert the page uses it
// (with the Clerk bearer token attached) instead of bare global fetch.
vi.mock('../../utils/api-fetch', () => ({ apiFetch: vi.fn() }));
// sonner's <Toaster> isn't mounted in unit tests — spy on toast.error to
// assert the visible error surface.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useDetailQuery } from '../../hooks/useDetailQuery';
import { apiFetch } from '../../utils/api-fetch';
import { toast } from 'sonner';

const mockedApiFetch = vi.mocked(apiFetch);

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
