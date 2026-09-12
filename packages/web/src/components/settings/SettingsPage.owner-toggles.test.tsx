/**
 * #1011 (wayfinder map #995) — owner controls for the five settings that
 * `updateSettingsSchema` used to strip.
 *
 * Written in the `SettingsPage.toggles.test.tsx` style: the page is rendered
 * with `apiFetch` mocked, hydration is asserted off `GET /api/settings`, and
 * each toggle is asserted to PUT `{ [field]: value }` back.
 *
 * The autonomous-close row is the one with a copy obligation: D-019 REVOKED
 * autonomous execution. The column now only decides whether a held booking
 * joins the owner-approval chain, so the label must not promise a capability
 * that no longer exists (see §E.4 of the #1011 design — the final wording is
 * Josh's product call).
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router';

const apiFetchMock = vi.fn();
vi.mock('../../utils/api-fetch', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const fetchLanguageMock = vi.fn();
const updateLanguageMock = vi.fn();
vi.mock('../../api/settings', () => ({
  fetchLanguageSettings: () => fetchLanguageMock(),
  updateLanguageSettings: (patch: unknown) => updateLanguageMock(patch),
}));

vi.mock('../../hooks/useMe', () => ({ useMe: () => ({ me: null }) }));

const toastErrorMock = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: (msg: string) => toastErrorMock(msg),
  },
}));

import { SettingsPage } from './SettingsPage';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 500),
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const LANG = {
  defaultLanguage: 'en',
  ttsVoiceEn: null,
  ttsVoiceEs: null,
  autoDetectLanguage: true,
  spanishDispatcherUserIds: [],
};

/** Seed the mount fetches: GET /api/settings, GET /api/onboarding/status, language. */
function primeMount(settings: Record<string, unknown>) {
  apiFetchMock.mockResolvedValueOnce(jsonResponse(settings));
  apiFetchMock.mockResolvedValueOnce(jsonResponse({ voiceAgentLive: false }));
  fetchLanguageMock.mockResolvedValueOnce(LANG);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

function toggleFor(label: HTMLElement): HTMLButtonElement {
  const button = label.closest('div')?.parentElement?.querySelector('button');
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

function lastPutBody(): Record<string, unknown> {
  const puts = apiFetchMock.mock.calls.filter(
    (c) => c[1] && (c[1] as RequestInit).method === 'PUT',
  );
  expect(puts.length).toBeGreaterThan(0);
  return JSON.parse((puts[puts.length - 1][1] as RequestInit).body as string);
}

const LABELS = {
  thankYou: 'Thank-you text after every job',
  review: 'Review request after every job',
  weekly: 'Weekly summary email',
  close: 'One approval for phone-quoted work',
} as const;

describe('#1011 — SettingsPage owner toggles', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    fetchLanguageMock.mockReset();
    updateLanguageMock.mockReset();
    toastErrorMock.mockReset();
  });

  it('renders a control for each of the five previously-stripped settings', async () => {
    primeMount({});
    renderPage();

    expect(await screen.findByText(LABELS.thankYou)).toBeInTheDocument();
    expect(screen.getByText(LABELS.review)).toBeInTheDocument();
    expect(screen.getByText(LABELS.weekly)).toBeInTheDocument();
    expect(screen.getByText(LABELS.close)).toBeInTheDocument();
    expect(screen.getByTestId('autonomous-close-cap')).toBeInTheDocument();
  });

  it('hydrates all five from GET /api/settings', async () => {
    primeMount({
      sendThankYouSms: false,
      sendReviewRequest: false,
      weeklyFeedbackEnabled: false,
      autonomousCloseEnabled: true,
      autonomousCloseMaxCents: 75000,
    });
    renderPage();

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/settings'));
    const cap = (await screen.findByTestId('autonomous-close-cap')) as HTMLInputElement;
    await waitFor(() => expect(cap.value).toBe('750'));

    // A hydrated-OFF switch must not render in the ON style, or the page lies
    // about live state (the failure mode #877 called out on the voice row).
    const thankYouToggle = toggleFor(screen.getByText(LABELS.thankYou));
    expect(thankYouToggle.className).toContain('bg-slate-200');
    const closeToggle = toggleFor(screen.getByText(LABELS.close));
    expect(closeToggle.className).toContain('bg-blue-600');
  });

  it('PUTs sendThankYouSms:false when the thank-you toggle is switched off', async () => {
    primeMount({ sendThankYouSms: true });
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ sendThankYouSms: false }));
    renderPage();

    fireEvent.click(toggleFor(await screen.findByText(LABELS.thankYou)));

    await waitFor(() => expect(lastPutBody()).toEqual({ sendThankYouSms: false }));
  });

  it('PUTs sendReviewRequest:false when the review toggle is switched off', async () => {
    primeMount({ sendReviewRequest: true });
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ sendReviewRequest: false }));
    renderPage();

    fireEvent.click(toggleFor(await screen.findByText(LABELS.review)));

    await waitFor(() => expect(lastPutBody()).toEqual({ sendReviewRequest: false }));
  });

  it('PUTs weeklyFeedbackEnabled:false when the weekly-summary toggle is switched off', async () => {
    primeMount({ weeklyFeedbackEnabled: true });
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ weeklyFeedbackEnabled: false }));
    renderPage();

    fireEvent.click(toggleFor(await screen.findByText(LABELS.weekly)));

    await waitFor(() => expect(lastPutBody()).toEqual({ weeklyFeedbackEnabled: false }));
  });

  it('PUTs autonomousCloseEnabled:true when the phone-quote approval toggle is switched on', async () => {
    primeMount({ autonomousCloseEnabled: false });
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ autonomousCloseEnabled: true }));
    renderPage();

    fireEvent.click(toggleFor(await screen.findByText(LABELS.close)));

    await waitFor(() => expect(lastPutBody()).toEqual({ autonomousCloseEnabled: true }));
  });

  it('PUTs the cap in CENTS when the dollar field is committed', async () => {
    primeMount({ autonomousCloseEnabled: true, autonomousCloseMaxCents: 75000 });
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ autonomousCloseMaxCents: 120000 }));
    renderPage();

    const cap = (await screen.findByTestId('autonomous-close-cap')) as HTMLInputElement;
    fireEvent.change(cap, { target: { value: '1200' } });
    fireEvent.blur(cap);

    await waitFor(() => expect(lastPutBody()).toEqual({ autonomousCloseMaxCents: 120000 }));
  });

  it('clears the cap with an explicit null when the dollar field is emptied', async () => {
    primeMount({ autonomousCloseEnabled: true, autonomousCloseMaxCents: 75000 });
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ autonomousCloseMaxCents: null }));
    renderPage();

    const cap = (await screen.findByTestId('autonomous-close-cap')) as HTMLInputElement;
    fireEvent.change(cap, { target: { value: '' } });
    fireEvent.blur(cap);

    await waitFor(() => expect(lastPutBody()).toEqual({ autonomousCloseMaxCents: null }));
  });

  it('reverts the switch and toasts when the PUT fails', async () => {
    primeMount({ sendThankYouSms: true });
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ message: 'nope' }, { ok: false, status: 500 }));
    renderPage();

    const label = await screen.findByText(LABELS.thankYou);
    fireEvent.click(toggleFor(label));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('Could not save preference'));
    // Reverted to its hydrated ON state rather than being left showing OFF.
    await waitFor(() => expect(toggleFor(label).className).toContain('bg-blue-600'));
  });

  it('D-019: the autonomous-close copy never claims the AI closes or books on its own', async () => {
    primeMount({});
    renderPage();

    const label = await screen.findByText(LABELS.close);
    const row = label.closest('div')!.parentElement!;
    const copy = (row.textContent ?? '').toLowerCase();

    for (const revoked of ['automatically', 'autonomous', 'without you', 'on its own', 'auto-close']) {
      expect(copy).not.toContain(revoked);
    }
    // It must instead say what the flag does TODAY: route the work into the
    // owner's approval chain.
    expect(copy).toContain('approv');
  });
});
