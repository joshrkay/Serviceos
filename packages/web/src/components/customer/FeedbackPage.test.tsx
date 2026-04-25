import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { FeedbackPage } from './FeedbackPage';

const TOKEN = 'abc-token-123';

describe('FeedbackPage', () => {
  it('renders star rating UI after loading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'pending', jobId: 'j1' }),
    }));
    render(
      <MemoryRouter initialEntries={[`/public/feedback/${TOKEN}`]}>
        <Routes><Route path="/public/feedback/:token" element={<FeedbackPage />} /></Routes>
      </MemoryRouter>
    );
    await waitFor(() => screen.getByTestId('star-rating'));
    expect(screen.getByRole('button', { name: /submit/i })).toBeInTheDocument();
  });
});
