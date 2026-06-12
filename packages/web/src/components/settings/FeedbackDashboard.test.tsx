import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { FeedbackDashboard } from './FeedbackDashboard';

describe('FeedbackDashboard', () => {
  it('shows average rating after loading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        responses: [
          { id: '1', rating: 5, comment: 'Great!', submittedAt: new Date().toISOString() },
          { id: '2', rating: 3, comment: null, submittedAt: new Date().toISOString() },
        ],
        total: 2,
      }),
    }));
    render(<MemoryRouter><FeedbackDashboard /></MemoryRouter>);
    await waitFor(() => screen.getByTestId('average-rating'));
    expect(screen.getByTestId('average-rating').textContent).toContain('4.0');
  });

  it('shows the empty state when there is no feedback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ responses: [], total: 0 }),
    }));
    render(<MemoryRouter><FeedbackDashboard /></MemoryRouter>);
    expect(await screen.findByText('No feedback yet')).toBeInTheDocument();
  });

  it('shows the error state when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    render(<MemoryRouter><FeedbackDashboard /></MemoryRouter>);
    expect(await screen.findByText('Could not load feedback.')).toBeInTheDocument();
  });
});
