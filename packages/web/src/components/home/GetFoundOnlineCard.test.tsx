import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const AH = vi.hoisted(() => ({ fetcher: vi.fn() }));
vi.mock('../../lib/apiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/apiClient')>();
  return { ...actual, useApiClient: () => AH.fetcher };
});

import { GetFoundOnlineCard } from './GetFoundOnlineCard';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const OPEN = {
  items: [
    { id: 'google_listing', status: 'current', reason: 'needs_pick' },
    { id: 'review_link', status: 'pending', reason: 'missing' },
    { id: 'call_forwarding', status: 'pending', reason: 'not_set_up' },
    { id: 'website', status: 'pending', reason: 'missing' },
    { id: 'google_website', status: 'pending', reason: 'not_published' },
  ],
  allDone: false,
  visible: true,
};

const DONE = {
  items: [
    { id: 'google_listing', status: 'done' },
    { id: 'review_link', status: 'done' },
    { id: 'call_forwarding', status: 'done', checkedAt: '2026-10-20T15:00:00.000Z' },
    { id: 'website', status: 'done' },
    { id: 'google_website', status: 'done' },
  ],
  allDone: true,
  visible: true,
};

function WhereAmI() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderCard() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<GetFoundOnlineCard />} />
        <Route path="/settings" element={<WhereAmI />} />
        <Route path="/settings/phone" element={<WhereAmI />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GetFoundOnlineCard', () => {
  beforeEach(() => {
    AH.fetcher.mockReset();
  });

  it('shows each item with progress and the reason it is open', async () => {
    AH.fetcher.mockResolvedValueOnce(jsonResponse({ data: OPEN }));
    renderCard();
    await screen.findByTestId('get-found-online-card');
    expect(screen.getByTestId('get-found-online-progress')).toHaveTextContent('0 of 5 done');
    expect(screen.getByTestId('get-found-online-item-google_listing')).toHaveTextContent(
      'Pick which Google location is yours.',
    );
    expect(screen.getByTestId('get-found-online-item-review_link')).toHaveAttribute(
      'data-status',
      'pending',
    );
    expect(screen.queryByTestId('get-found-online-hide')).toBeNull();
  });

  it('opens the Settings place that finishes an item', async () => {
    AH.fetcher.mockResolvedValueOnce(jsonResponse({ data: OPEN }));
    renderCard();
    const item = await screen.findByTestId('get-found-online-item-review_link');
    fireEvent.click(item.querySelector('button')!);
    expect(await screen.findByTestId('location')).toHaveTextContent('/settings?open=review-links');
  });

  it('Calls reach the AI: opens Phone settings, and shows the check date once done', async () => {
    AH.fetcher.mockResolvedValueOnce(jsonResponse({ data: OPEN }));
    const { unmount } = renderCard();
    const item = await screen.findByTestId('get-found-online-item-call_forwarding');
    expect(item).toHaveTextContent('Calls reach the AI');
    fireEvent.click(item.querySelector('button')!);
    expect(await screen.findByTestId('location')).toHaveTextContent('/settings/phone');
    unmount();

    AH.fetcher.mockResolvedValueOnce(jsonResponse({ data: DONE }));
    renderCard();
    const done = await screen.findByTestId('get-found-online-item-call_forwarding');
    expect(done).toHaveTextContent(/Last checked/);
    // A passed check offers a re-check: it is still a way into Phone settings.
    expect(done.querySelector('button')).not.toBeNull();
  });

  it('sends the website item to the Website card in Settings', async () => {
    AH.fetcher.mockResolvedValueOnce(jsonResponse({ data: OPEN }));
    renderCard();
    const item = await screen.findByTestId('get-found-online-item-website');
    expect(item).toHaveTextContent('Add your website, or let us make you one.');
    fireEvent.click(item.querySelector('button')!);
    expect(await screen.findByTestId('location')).toHaveTextContent('/settings?open=website');
  });

  it('#1771 Google shows your site: a tap builds the approval card, approving sends it', async () => {
    AH.fetcher
      .mockResolvedValueOnce(jsonResponse({ data: OPEN }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            data: {
              proposalId: 'p-1',
              websiteUri: 'https://joesplumbing.com',
              bookingUri: 'https://app.example.com/book?t=t1',
            },
          },
          201,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'p-1', status: 'approved' }));
    renderCard();
    const item = await screen.findByTestId('get-found-online-item-google_website');
    expect(item).toHaveTextContent('Google shows your site');
    fireEvent.click(item.querySelector('button')!);

    const card = await screen.findByTestId('google-website-approval');
    expect(card).toHaveTextContent('https://joesplumbing.com');
    expect(card).toHaveTextContent('https://app.example.com/book?t=t1');
    expect(AH.fetcher).toHaveBeenLastCalledWith(
      '/api/get-found-online/google-website/draft',
      expect.objectContaining({ method: 'POST' }),
    );
    // Drafting alone sent nothing to Google: no approve call yet.
    expect(AH.fetcher.mock.calls.some((c) => String(c[0]).includes('/approve'))).toBe(false);

    fireEvent.click(screen.getByTestId('google-website-approve'));
    await screen.findByRole('status');
    expect(AH.fetcher).toHaveBeenLastCalledWith('/api/proposals/p-1/approve', expect.objectContaining({ method: 'POST' }));
    expect(screen.queryByTestId('google-website-approval')).toBeNull();
  });

  it('#1771 Not now discards the card; a failed draft says why', async () => {
    AH.fetcher
      .mockResolvedValueOnce(jsonResponse({ data: OPEN }))
      .mockResolvedValueOnce(jsonResponse({ data: { proposalId: 'p-2', websiteUri: 'https://a.com' } }, 201))
      .mockResolvedValueOnce(jsonResponse({ id: 'p-2', status: 'rejected' }));
    renderCard();
    fireEvent.click((await screen.findByTestId('get-found-online-item-google_website')).querySelector('button')!);
    fireEvent.click(await screen.findByTestId('google-website-discard'));
    await waitFor(() => expect(screen.queryByTestId('google-website-approval')).toBeNull());
    expect(AH.fetcher).toHaveBeenLastCalledWith('/api/proposals/p-2/reject', expect.objectContaining({ method: 'POST' }));

    AH.fetcher.mockResolvedValueOnce(jsonResponse({ message: 'Connect your Google Business Profile first' }, 400));
    fireEvent.click(screen.getByTestId('get-found-online-item-google_website').querySelector('button')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Connect your Google Business Profile first');
  });

  it('#1771 shows Google\'s reason after a refused write, and no website sends the owner to add one', async () => {
    AH.fetcher.mockResolvedValueOnce(
      jsonResponse({
        data: {
          ...OPEN,
          items: [
            ...OPEN.items.slice(0, 4),
            { id: 'google_website', status: 'error', reason: 'failed', failureReason: 'Google no longer accepts the connection.' },
          ],
        },
      }),
    );
    renderCard();
    const failed = await screen.findByTestId('get-found-online-item-google_website');
    expect(failed).toHaveTextContent('Google no longer accepts the connection.');
    expect(failed).toHaveAttribute('data-status', 'error');
  });

  it('#1771 with no website yet, the item opens the Website card', async () => {
    AH.fetcher.mockResolvedValueOnce(
      jsonResponse({
        data: { ...OPEN, items: [...OPEN.items.slice(0, 4), { id: 'google_website', status: 'pending', reason: 'no_website' }] },
      }),
    );
    renderCard();
    const item = await screen.findByTestId('get-found-online-item-google_website');
    expect(item).toHaveTextContent('Add your website first');
    fireEvent.click(item.querySelector('button')!);
    expect(await screen.findByTestId('location')).toHaveTextContent('/settings?open=website');
  });

  it('keeps every tap target at least 44px tall (min-h-11)', async () => {
    AH.fetcher.mockResolvedValueOnce(jsonResponse({ data: { ...DONE, items: [OPEN.items[0], DONE.items[1], OPEN.items[2]], allDone: false } }));
    renderCard();
    await screen.findByTestId('get-found-online-card');
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('min-h-11');
    }
  });

  it('renders nothing for non-owners (403)', async () => {
    AH.fetcher.mockResolvedValueOnce(jsonResponse({ error: 'FORBIDDEN' }, 403));
    const { container } = renderCard();
    await waitFor(() => expect(AH.fetcher).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="get-found-online-card"]')).toBeNull();
  });

  it('renders nothing once the finished checklist was dismissed', async () => {
    AH.fetcher.mockResolvedValueOnce(jsonResponse({ data: { ...DONE, visible: false } }));
    const { container } = renderCard();
    await waitFor(() => expect(AH.fetcher).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="get-found-online-card"]')).toBeNull();
  });

  it('hides the finished checklist when the owner taps Hide', async () => {
    AH.fetcher
      .mockResolvedValueOnce(jsonResponse({ data: DONE }))
      .mockResolvedValueOnce(jsonResponse({ data: { ...DONE, visible: false } }));
    renderCard();
    const hide = await screen.findByTestId('get-found-online-hide');
    expect(hide.className).toContain('min-h-11');
    fireEvent.click(hide);
    await waitFor(() => expect(screen.queryByTestId('get-found-online-card')).toBeNull());
    expect(AH.fetcher).toHaveBeenLastCalledWith('/api/get-found-online/dismiss', { method: 'POST' });
  });

  it('says so when hiding fails instead of failing silently', async () => {
    AH.fetcher
      .mockResolvedValueOnce(jsonResponse({ data: DONE }))
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    renderCard();
    fireEvent.click(await screen.findByTestId('get-found-online-hide'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not hide the checklist');
    expect(screen.getByTestId('get-found-online-card')).toBeInTheDocument();
  });
});
