/**
 * Tenant-neutral class contract for the public feedback page (U13f).
 *
 * Covers the rating state (stars + kit comment box) and the submitted state.
 * Regex includes `fill`/`stroke` because the star icons colour via SVG fill —
 * a leak the standard bg/text/border guard would miss.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { FeedbackPage } from './FeedbackPage';

const TOKEN = 'abc-token-123';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/public/feedback/${TOKEN}`]}>
      <Routes><Route path="/public/feedback/:token" element={<FeedbackPage />} /></Routes>
    </MemoryRouter>,
  );
}

const RAW_PALETTE =
  /(bg|text|border|border-l|border-r|border-t|border-b|placeholder|ring|divide|shadow|fill|stroke|from|via|to)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/;

function expectNeutral(html: string) {
  expect(html).not.toMatch(RAW_PALETTE);
  expect(html).not.toMatch(/\b(bg|text|border|ring)-primary\b/);
  expect(html).not.toMatch(/\bring-ring\b/);
  expect(html).not.toMatch(/\b(bg|text|border)-accent\b|accent-foreground/);
}

describe('FeedbackPage — tenant-neutral class contract', () => {
  it('stays neutral in the rating state and the submitted state', async () => {
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
    expectNeutral(container.innerHTML);

    // Submitted state.
    fireEvent.click(screen.getByRole('button', { name: /submit feedback/i }));
    await screen.findByRole('link', { name: /leave a google review/i });
    expectNeutral(container.innerHTML);
  });
});
