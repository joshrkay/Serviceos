import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConversationalIntakePage } from './ConversationalIntakePage';

describe('P3-009 — ConversationalIntakePage container', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders with an empty intake thread', () => {
    render(<ConversationalIntakePage />);
    expect(screen.getByText(/intake/i)).toBeInTheDocument();
  });

  it('POSTs to /api/assistant/chat on send and appends the reply', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: { content: 'Got it. Creating the customer.' },
          conversationId: 'conv-1',
        }),
        { status: 200 }
      )
    );

    render(<ConversationalIntakePage />);
    const input = screen.getByPlaceholderText(/type a message/i);
    fireEvent.change(input, { target: { value: 'Create customer John' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/assistant/chat',
        expect.objectContaining({ method: 'POST' })
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/Got it\. Creating the customer\./)).toBeInTheDocument();
    });
  });

  it('renders an error reply when the API rejects', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response('server error', { status: 500 })
    );

    render(<ConversationalIntakePage />);
    const input = screen.getByPlaceholderText(/type a message/i);
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText(/chat failed: 500/)).toBeInTheDocument();
    });
  });
});
