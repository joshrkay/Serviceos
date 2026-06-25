/**
 * Tenant-neutral class contract for the public feedback page (U13f).
 *
 * Covers the rating state (stars + kit comment box) and the submitted state.
 * Regex includes `fill`/`stroke` because the star icons colour via SVG fill —
 * a leak the standard bg/text/border guard would miss.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { FeedbackPage } from './FeedbackPage';
import { expectNoRawPalette } from './rawPaletteContract';

const TOKEN = 'abc-token-123';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/public/feedback/${TOKEN}`]}>
      <Routes><Route path="/public/feedback/:token" element={<FeedbackPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('FeedbackPage — no-raw-palette class contract', () => {
  it('renders no raw palette in the rating state and the submitted state', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: async () =>
          init?.method === 'POST'
            ? { ok: true, reviewUrls: { google: 'https://g.co/review' } }
            : { status: 'pending', jobId: 'j1', businessName: 'ACME' },
      }),
    ));
    const { container } = renderPage();

    // Rating state: stars (SVG fill) + kit comment textarea.
    await waitFor(() => screen.getByTestId('star-rating'));
    fireEvent.click(screen.getByRole('button', { name: '5 stars' }));
    expectNoRawPalette(container.innerHTML);

    // Submitted state.
    fireEvent.click(screen.getByRole('button', { name: /submit feedback/i }));
    await screen.findByRole('link', { name: /leave a google review/i });
    expectNoRawPalette(container.innerHTML);
  });
});
