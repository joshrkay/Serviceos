import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AssistantPage } from './AssistantPage';

vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../shared/AIProposalCard', () => ({ AIProposalCard: () => null }));
vi.mock('../../data/mock-data', () => ({
  type: {},
}));

import { useDetailQuery } from '../../hooks/useDetailQuery';

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
});

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
    expect(screen.getByText('Fieldly AI')).toBeInTheDocument();
  });
});

// ─── P20-005: Accurate AI failure messaging ──────────────────────────────────

describe('P20-005 — AI failure messaging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('P20-005: shows accurate error message when chat API call fails (network error)', async () => {
    // Simulate a network failure on the assistant chat endpoint.
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    renderPage();

    // Wait for welcome message then type and send
    await waitFor(() => {
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('Ask anything or give a command…');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(
        screen.getByText('Unable to connect to AI service — please try again or contact support.')
      ).toBeInTheDocument();
    });
  });

  it('P20-005: shows accurate error message when chat API returns a non-2xx status', async () => {
    // Simulate an HTTP 503 response from the assistant chat endpoint.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Service Unavailable', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      })
    );

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('Ask anything or give a command…');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(
        screen.getByText('Unable to connect to AI service — please try again or contact support.')
      ).toBeInTheDocument();
    });
  });

  it('P20-005: does not display "not connected yet" string on AI failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/I'm your AI assistant/)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('Ask anything or give a command…');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(
        screen.getByText('Unable to connect to AI service — please try again or contact support.')
      ).toBeInTheDocument();
    });

    // The old misleading copy must not appear anywhere in the rendered output
    expect(screen.queryByText(/not connected yet/i)).not.toBeInTheDocument();
  });
});
