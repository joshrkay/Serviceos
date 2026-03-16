import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AssistantPage } from './AssistantPage';

vi.mock('../../hooks/useDetailQuery', () => ({ useDetailQuery: vi.fn() }));
vi.mock('../shared/AIProposalCard', () => ({ AIProposalCard: () => null }));
vi.mock('../../data/mock-data', () => ({
  initialMessages: [
    { id: 'm1', role: 'assistant', content: 'Hello! How can I help you today?', time: '9:00 AM' },
    { id: 'm2', role: 'user',      content: 'What jobs are scheduled today?',   time: '9:01 AM' },
  ],
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
  it('falls back to mock initialMessages when no conversationId', () => {
    renderPage();
    expect(screen.getByText('Hello! How can I help you today?')).toBeInTheDocument();
    expect(screen.getByText('What jobs are scheduled today?')).toBeInTheDocument();
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

  it('falls back to mock messages when API returns error', async () => {
    vi.mocked(useDetailQuery).mockReturnValue({
      ...defaultDetailResult,
      error: 'HTTP 404',
      data: null,
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Hello! How can I help you today?')).toBeInTheDocument();
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
