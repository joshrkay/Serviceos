import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { FeedbackPage } from './FeedbackPage';

const TOKEN = 'abc-token-123';

/** GET returns a pending request; POST returns the given submit body. */
function mockFetch(submitBody: unknown) {
  return vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      json: async () =>
        init?.method === 'POST'
          ? submitBody
          : { status: 'pending', jobId: 'j1', businessName: 'ACME' },
    }),
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/public/feedback/${TOKEN}`]}>
      <Routes><Route path="/public/feedback/:token" element={<FeedbackPage />} /></Routes>
    </MemoryRouter>,
  );
}

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

  it('shows an invalid link message when token is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter initialEntries={['/public/feedback']}>
        <Routes><Route path="/public/feedback" element={<FeedbackPage />} /></Routes>
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: /invalid feedback link/i })).toBeInTheDocument();
    expect(
      screen.getByText(/missing required information or is malformed/i)
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the public review CTA only when the API returns review links (rating ≥ 4★)', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: true, reviewUrls: { google: 'https://g.co/review' } }));
    renderPage();
    await waitFor(() => screen.getByTestId('star-rating'));
    fireEvent.click(screen.getByRole('button', { name: '5 stars' }));
    fireEvent.click(screen.getByRole('button', { name: /submit feedback/i }));
    const link = await screen.findByRole('link', { name: /leave a google review/i });
    expect(link).toHaveAttribute('href', 'https://g.co/review');
  });

  it('withholds public review links for a low rating (< 4★) — internal-only thank-you', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: true })); // no reviewUrls
    renderPage();
    await waitFor(() => screen.getByTestId('star-rating'));
    fireEvent.click(screen.getByRole('button', { name: '2 stars' }));
    fireEvent.click(screen.getByRole('button', { name: /submit feedback/i }));
    expect(await screen.findByText(/thank you/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /review/i })).not.toBeInTheDocument();
  });

  it('keeps ≥44px tap targets on the rating controls (mobile contract)', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: true }));
    renderPage();
    await waitFor(() => screen.getByTestId('star-rating'));
    // 40px star icon + p-1 padding ≥ 44px; the submit button uses py-4.
    expect(screen.getByRole('button', { name: '5 stars' }).className).toContain('p-1');
    expect(screen.getByRole('button', { name: /submit feedback/i }).className).toContain('py-4');
  });
});
