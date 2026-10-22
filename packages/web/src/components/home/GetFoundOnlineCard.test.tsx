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
  ],
  allDone: false,
  visible: true,
};

const DONE = {
  items: [
    { id: 'google_listing', status: 'done' },
    { id: 'review_link', status: 'done' },
    { id: 'call_forwarding', status: 'done', checkedAt: '2026-10-20T15:00:00.000Z' },
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
    expect(screen.getByTestId('get-found-online-progress')).toHaveTextContent('0 of 3 done');
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
